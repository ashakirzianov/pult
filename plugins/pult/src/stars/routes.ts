// The Stars' routes under `/api/plugins/pult` (xaxis `pult/design-durable-agent-sleep`, The routes):
// each decodes, calls the Stars, and maps an unknown id to 404 and a failure to `{ error }`.
import { Effect, HttpServerRequest, HttpServerResponse, Schema } from "../host.ts";
import type { Schedules } from "../schedules/schedules.ts";
import type { Stars, StarsError } from "./stars.ts";

const decodeCreate = Schema.decodeUnknownEffect(
  Schema.Struct({ ifNone: Schema.optional(Schema.Boolean) }),
);
const decodeFields = Schema.decodeUnknownEffect(
  Schema.Struct({ name: Schema.optional(Schema.String), tint: Schema.optional(Schema.String) }),
);

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
          return json({ error: "The body must be JSON: { ifNone? }." }, 400);
        return json(yield* stars.create({ ifNone: body.value.ifNone === true }));
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
          return json({ error: "The body must be JSON: { name?, tint? }." }, 400);
        yield* stars.upkeep;
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        return json(yield* stars.setRecord(star, body.value));
      }),
    );
  if (
    segments.length === 4 &&
    id !== undefined &&
    sub === "conversations" &&
    name !== undefined &&
    method === "GET"
  )
    return answer(
      Effect.gen(function* () {
        const star = yield* stars.get(id);
        if (star === undefined) return notFound;
        const transcript = yield* stars.transcript(star, name);
        return transcript === undefined
          ? json({ error: "The Star has no such transcript on this server." }, 404)
          : json(transcript);
      }),
    );
  return undefined;
};
