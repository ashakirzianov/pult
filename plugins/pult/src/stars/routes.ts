// The Stars' routes under `/api/plugins/pult` (xaxis `pult/tasks/durable-agent-sleep.task/design.md`, The routes):
// each decodes, calls the Stars, and maps an unknown id to 404 and a failure to `{ error }`.
import { ModelSelection, RuntimeMode } from "@t3tools/contracts";

import { Effect, HttpServerRequest, HttpServerResponse, Schema } from "../host.ts";
import type { Schedules } from "../schedules/schedules.ts";
import { isChannel } from "./channels.ts";
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
const decodeSleep = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ channel: Schema.optional(Schema.String) })),
);

/** A channel's settings as the shelf writes them: a key left out is left alone, null removes it; tokens as `rotate-on-context` reads them, thousands from `1k` to `999999k`. */
const decodeChannelSettings = Schema.decodeUnknownEffect(
  Schema.Struct({
    model: Schema.optional(Schema.NullOr(ModelSelection)),
    rotateOnContext: Schema.optional(
      Schema.NullOr(
        Schema.Union([
          Schema.Literal("never"),
          Schema.Int.check(
            Schema.isMultipleOf(1000),
            Schema.isBetween({ minimum: 1000, maximum: 999_999_000 }),
          ),
        ]),
      ),
    ),
  }),
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
  // Refresh Context: the user puts a channel's current conversation to sleep, the default channel's where the body names none, unless something holds it.
  if (segments.length === 3 && id !== undefined && sub === "sleep" && method === "POST")
    return answer(
      Effect.gen(function* () {
        // No body at all is the default channel's, as `{}` is.
        const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        const body = yield* (
          text.trim() === "" ? Effect.succeed({ channel: undefined }) : decodeSleep(text)
        ).pipe(Effect.option);
        const named = body._tag === "None" ? undefined : body.value.channel;
        if (body._tag === "None" || (named !== undefined && !isChannel(named)))
          return json({ error: "The body must be JSON: { channel? }." }, 400);
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        const outcome = yield* stars.sleepByHand(star, named);
        return "asleep" in outcome
          ? json({ error: "The channel is asleep already: it has no conversation to end." }, 409)
          : json(outcome);
      }),
    );
  // The page wakes a channel itself (its draft, a sync's handoff), the default channel where the body names none: the model to wake it at, telling the channel of a broken file.
  if (segments.length === 3 && id !== undefined && sub === "model" && method === "POST")
    return answer(
      Effect.gen(function* () {
        const body = yield* bodyOf(request, decodeWake);
        const named = body._tag === "None" ? undefined : body.value.channel;
        if (body._tag === "None" || (named !== undefined && !isChannel(named)))
          return json({ error: "The body must be JSON: { runtimeMode, channel? }." }, 400);
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json({
          model: yield* pageWakeModel(star, body.value.runtimeMode, named ?? star.defaultChannel),
        });
      }),
    );
  // A channel's transcripts' names, which its tab's fold draws: `GET stars/<id>/channels/<slug>/conversations`.
  if (
    segments.length === 5 &&
    id !== undefined &&
    sub === "channels" &&
    name !== undefined &&
    isChannel(name) &&
    segments[4] === "conversations" &&
    method === "GET"
  )
    return answer(
      Effect.gen(function* () {
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json({ names: yield* stars.channelTranscripts(star, name) });
      }),
    );
  // A channel's settings, which its shelf draws and writes: `GET` and `POST stars/<id>/channels/<slug>/settings`.
  if (
    segments.length === 5 &&
    id !== undefined &&
    sub === "channels" &&
    name !== undefined &&
    isChannel(name) &&
    segments[4] === "settings" &&
    (method === "GET" || method === "POST")
  )
    return answer(
      Effect.gen(function* () {
        const body = method === "POST" ? yield* bodyOf(request, decodeChannelSettings) : undefined;
        if (body?._tag === "None")
          return json({ error: "The body must be JSON: { model?, rotateOnContext? }." }, 400);
        const model = body?.value.model;
        // Each value is one line of the file.
        if (
          model != null &&
          [
            model.instanceId,
            model.model,
            ...(model.options ?? []).map((option) => option.value),
          ].some((value) => typeof value === "string" && /[\r\n]/u.test(value))
        )
          return json({ error: "The model's values must each be one line." }, 400);
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json(
          body === undefined
            ? yield* stars.channelSettings(star, name)
            : yield* stars.setChannelSettings(star, name, body.value),
        );
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
