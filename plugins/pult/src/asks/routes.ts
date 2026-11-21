// The asks' routes under `/api/plugins/pult` (`asks.ts`): `GET asks` for the page's shelves, and
// `POST asks/<id>/replied|snooze|settle|unsettle` for its card's actions and the reply's send.
import { DateTime, Effect, HttpServerRequest, HttpServerResponse, Schema } from "../host.ts";
import type { Action, Asks, AsksError } from "./asks.ts";

const decodeSnooze = Schema.decodeUnknownEffect(
  Schema.Struct({ until: Schema.NullOr(Schema.String) }),
);

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** The routes' answers, by method and path below `/asks`; undefined for a path of no route. */
export const asksRoute = (
  asks: Asks,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> | undefined => {
  const segments = path.split("/").slice(1).map(decodeURIComponent);
  if (segments[0] !== "asks") return undefined;
  const [, id, verb] = segments;
  const answer = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, AsksError>) =>
    effect.pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));

  if (segments.length === 1 && request.method === "GET")
    return answer(Effect.map(asks.view, (view) => json(view)));
  if (segments.length !== 3 || id === undefined || request.method !== "POST") return undefined;
  const act = (action: Action) =>
    answer(
      Effect.map(asks.act(id, action), (ask) =>
        ask === undefined
          ? json({ error: "No ask has this id on this server." }, 404)
          : "refused" in ask
            ? json({ error: ask.refused }, 409)
            : json(ask),
      ),
    );
  switch (verb) {
    case "replied":
    case "settle":
    case "unsettle":
      return act({ kind: verb });
    case "snooze":
      return Effect.gen(function* () {
        const body = yield* request.json.pipe(Effect.flatMap(decodeSnooze), Effect.option);
        const until = body._tag === "Some" ? body.value.until : undefined;
        const at = until == null ? undefined : DateTime.make(until);
        if (until === undefined || at?._tag === "None")
          return json({ error: "The body must be JSON: { until: <ISO time> | null }." }, 400);
        return yield* act({
          kind: "snooze",
          until: at === undefined ? null : DateTime.formatIso(at.value),
        });
      });
    default:
      return undefined;
  }
};
