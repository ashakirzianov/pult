// The Stars' routes under `/api/plugins/pult` (xaxis `pult/tasks/durable-agent-sleep.task/design.md`, The routes):
// each decodes, calls the Stars, and maps an unknown id to 404 and a failure to `{ error }`.
import { RuntimeMode } from "@t3tools/contracts";

import { Effect, HttpServerRequest, HttpServerResponse, Schema } from "../host.ts";
import type { Schedules } from "../schedules/schedules.ts";
import { isChannel, USER_CHANNEL } from "./channels.ts";
import type { PageWakeModel } from "./deliver.ts";
import type { Stars, StarsError } from "./stars.ts";

const decodeCreate = Schema.decodeUnknownEffect(
  Schema.Struct({ ifNone: Schema.optional(Schema.Boolean), name: Schema.optional(Schema.String) }),
);
const decodeFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    tint: Schema.optional(Schema.String),
  }),
);
const decodeWake = Schema.decodeUnknownEffect(
  Schema.Struct({ runtimeMode: RuntimeMode, channel: Schema.optional(Schema.String) }),
);

/** The reserved name of `GET stars/<id>/conversations/<name>` that looks a transcript up by its thread. */
const BY_THREAD = "by-thread";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const notFound = json({ error: "No Star has this id on this server." }, 404);

const bodyOf = <A>(
  request: HttpServerRequest.HttpServerRequest,
  decode: (input: unknown) => Effect.Effect<A, unknown>,
) => request.json.pipe(Effect.flatMap(decode), Effect.option);

/** The routes' answers, by method and path below `/stars`; undefined for a path of no route. */
export const starsRoute = (
  stars: Stars,
  schedules: Schedules,
  pageWakeModel: PageWakeModel,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> | undefined => {
  const segments = path.split("/").slice(1).map(decodeURIComponent);
  if (segments[0] !== "stars") return undefined;
  const [, id, sub, name] = segments;
  const method = request.method;
  const answer = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, StarsError>) =>
    effect.pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));

  const view = Effect.flatMap(stars.view, schedules.withSchedules);
  if (segments.length === 1 && method === "GET")
    return answer(Effect.map(view, (each) => json(each)));
  if (segments.length === 1 && method === "POST")
    return answer(
      Effect.gen(function* () {
        const body = yield* bodyOf(request, decodeCreate);
        if (body._tag === "None")
          return json({ error: "The body must be JSON: { ifNone?, name? }." }, 400);
        return json(
          yield* stars.create({ ifNone: body.value.ifNone === true, name: body.value.name }),
        );
      }),
    );
  if (segments.length === 2 && id === "upkeep" && method === "POST")
    return answer(
      stars.upkeep.pipe(
        Effect.andThen(view),
        Effect.map((each) => json(each)),
      ),
    );
  // POST, not PATCH: a page on another origin may send a browser API only the methods the server's CORS allows (`browserApiCorsAllowedMethods`).
  if (segments.length === 2 && id !== undefined && method === "POST")
    return answer(
      Effect.gen(function* () {
        const body = yield* bodyOf(request, decodeFields);
        if (body._tag === "None")
          return json({ error: "The body must be JSON: { name?, description?, tint? }." }, 400);
        yield* stars.upkeep;
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json(yield* stars.setRecord(star, body.value));
      }),
    );
  // Refresh Context: the user puts the Star's current conversation in `user` to sleep, unless something holds it.
  if (segments.length === 3 && id !== undefined && sub === "sleep" && method === "POST")
    return answer(
      Effect.gen(function* () {
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        const outcome = yield* stars.sleepByHand(star);
        return "asleep" in outcome
          ? json({ error: "The Star is asleep already: it has no conversation to end." }, 409)
          : json(outcome);
      }),
    );
  // The page wakes `user` itself (its draft, a sync's handoff), or another channel (its tagged draft): the model to wake it at, telling `work` of a broken file.
  if (segments.length === 3 && id !== undefined && sub === "model" && method === "POST")
    return answer(
      Effect.gen(function* () {
        const body = yield* bodyOf(request, decodeWake);
        const channel = body._tag === "None" ? undefined : (body.value.channel ?? USER_CHANNEL);
        if (body._tag === "None" || channel === undefined || !isChannel(channel))
          return json({ error: "The body must be JSON: { runtimeMode, channel? }." }, 400);
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json({ model: yield* pageWakeModel(star, body.value.runtimeMode, channel) });
      }),
    );
  const channel =
    segments.length === 6 && sub === "channels" && segments[4] === "conversations"
      ? name
      : undefined;
  if (
    ((channel !== undefined && isChannel(channel)) ||
      (segments.length === 4 && sub === "conversations")) &&
    id !== undefined &&
    name !== undefined &&
    method === "GET"
  )
    return answer(
      Effect.gen(function* () {
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        // `by-thread` is no transcript's name: the lookup of the one whose conversation the thread was, with its name.
        const threadId =
          channel === undefined && name === BY_THREAD
            ? new URL(request.url, "http://plugin").searchParams.get("threadId")
            : undefined;
        if (threadId === null)
          return json({ error: "A lookup by thread names it: ?threadId=<id>." }, 400);
        const transcript =
          threadId === undefined
            ? yield* stars.transcript(star, segments[5] ?? name, channel)
            : yield* stars.transcriptOfThread(star, threadId);
        return transcript === undefined
          ? json({ error: "The Star has no such transcript on this server." }, 404)
          : json(transcript);
      }),
    );
  return undefined;
};
