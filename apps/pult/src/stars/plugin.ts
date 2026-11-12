// The server's Pult plugin, as the page asks it (`plugins/pult`, xaxis
// `pult/design-durable-agent-sleep`, The routes): the one file that names its
// routes, apart from the workbench so `node --test src/stars/plugin.test.ts`
// can run it. `about` says what the plugin of a server does; the Stars'
// routes serve everything the page knows of a Star, each answer decoded
// strictly, so an answer of another shape fails loudly.

/** The plugin's feature of keeping the Stars: where `about` lists it, the server finds, keeps and serves its Stars, and the page draws them. */
export const STARS_FEATURE = "stars";

/** The plugin's feature of firing the Stars' schedules: listed only where the server fires them, none under its `schedules-off`. */
export const SCHEDULES_FEATURE = "star-schedules";

/** The plugin's feature of putting a Star to sleep by hand, Refresh Context: `POST stars/<id>/sleep`, offered only where `about` lists it. */
export const SLEEP_FEATURE = "star-sleep";

const PLUGIN_PATH = "/api/plugins/pult";

/** How long a read may take before the server reads as having no plugin, or no Stars: the environment's cards wait on both. */
const READ_TIMEOUT_MS = 10_000;

/** An environment's address and bearer, as `connection.credential` gives them. */
export interface Credential {
  readonly httpBaseUrl: string;
  readonly token: string;
}

/** The names `about` answers, `{ features: string[] }`; null for anything else, which is no plugin. Other fields are let be, as a newer plugin may add them. */
export function decodeAbout(body: unknown): ReadonlyArray<string> | null {
  if (typeof body !== "object" || body === null || !("features" in body)) return null;
  const { features } = body;
  return Array.isArray(features) && features.every((each) => typeof each === "string")
    ? features
    : null;
}

/**
 * Reads what the server's plugin does from its `about`, with the
 * environment's bearer, as an asset's bytes are read (`src/files/server.ts`):
 * its features, none where the server answers anything but `about`'s JSON
 * (stock T3 Code, an older Pult server, a plugin that failed to activate) or
 * cannot be reached within `READ_TIMEOUT_MS`. JSON that is not `about`'s,
 * and a refusal other than 404, are told; a 404, or a page that is no JSON,
 * is not.
 */
export async function readAbout(credential: Credential): Promise<ReadonlyArray<string>> {
  let response: Response;
  try {
    response = await fetch(new URL(`${PLUGIN_PATH}/about`, credential.httpBaseUrl), {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `[pult-shell] could not ask the server's Pult plugin what it does: ${String(error)}`,
    );
    return [];
  }
  // A server without the route answers 404, or its web app's page. Any other refusal is told, not silent.
  if (!response.ok) {
    if (response.status !== 404)
      console.warn(
        `[pult-shell] the server's Pult plugin refused \`about\` (${response.status}): read as no plugin.`,
      );
    return [];
  }
  if (response.headers.get("content-type")?.includes("application/json") !== true) return [];
  const features = decodeAbout(await response.json().catch(() => undefined));
  if (features === null)
    console.warn("[pult-shell] the server's Pult plugin answered no `about`: read as no plugin.");
  return features ?? [];
}

/** The channel with the user, whose conversation is the Star's tab (xaxis `pult/issues/star-channels.md`). */
export const USER_CHANNEL = "user";

/**
 * Whether a batch of changes under the Stars directory may have rewritten a
 * transcript of `user`'s, which the fold shows, as a conversation
 * un-settled and settled again does: a change to a `.pult/channels/user`
 * or under it, where the plugin writes them, or more changed than the batch
 * names.
 */
export function rewritesUserTranscripts(event: {
  readonly changes: ReadonlyArray<{ readonly path: string }>;
  readonly truncated: boolean;
}): boolean {
  return (
    event.truncated ||
    event.changes.some((change) => USER_CHANNEL_PATH.test(change.path.replaceAll("\\", "/")))
  );
}

/** `user`'s channel's folder, or a path under it, `/`-separated. */
const USER_CHANNEL_PATH = new RegExp(`(?:^|/)\\.pult/channels/${USER_CHANNEL}(?:/|$)`);

/**
 * The Stars of `answer` a batch of changes under its Stars directory may
 * have written a transcript of a channel but `user`'s for, which no answer
 * names (its `conversations` are `user`'s): a change under a Star's
 * `.pult/channels/<slug>/conversations/`, `slug` not `user`, the Star's
 * folder read from the change's path, relative to the directory; every
 * Star where more changed than the batch names.
 */
export function channelTranscriptStars(
  event: {
    readonly changes: ReadonlyArray<{ readonly path: string }>;
    readonly truncated: boolean;
  },
  answer: {
    readonly directory: string;
    readonly stars: ReadonlyArray<{ readonly id: string; readonly root: string }>;
  },
): string[] {
  const slashed = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  const directory = slashed(answer.directory);
  const folders = new Set(
    event.changes.flatMap((change) => {
      const match = /^(.+)\/\.pult\/channels\/([^/]+)\/conversations(?:\/|$)/.exec(
        slashed(change.path),
      );
      return match === null || match[2] === USER_CHANNEL ? [] : [`${directory}/${match[1]}`];
    }),
  );
  return answer.stars
    .filter((star) => event.truncated || folders.has(slashed(star.root)))
    .map((star) => star.id);
}

/** An open channel of a Star's as the route reads it: its slug, its current conversation's thread, and the sleep rule's reading of it, a deadline or what holds it. */
export interface RouteChannel {
  readonly slug: string;
  readonly threadId: string;
  readonly sleeps: { readonly at: string } | { readonly heldBy: string };
}

/** A Star as the write routes answer it: its record, its folder (a host path) and its project. */
export interface WrittenStar {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
  readonly root: string;
  readonly projectId: string;
}

/** A schedule's newest run, as its record says. */
export interface RouteRun {
  /** ISO instants. */
  readonly due: string;
  readonly fired: string;
  /** `started`, `queued`, `launched`, `replayed` or `failed` today; a string, so a newer plugin's result hides no Star. */
  readonly result: string;
  /** Why it failed; null unless it did. */
  readonly error: string | null;
  readonly thread: string | null;
}

/** A schedule of a Star's, as the plugin parsed its file: the rule in words and the next due instant are the plugin's, the page only draws them. */
export interface RouteSchedule {
  readonly name: string;
  /** The file, a host path. */
  readonly path: string;
  /** The rule in words, `weekdays 09:00`; null for a file that is no schedule. */
  readonly rule: string | null;
  /** Its IANA zone; null for a file that is no schedule. */
  readonly timezone: string | null;
  /** The next due instant, ISO; null where none is. */
  readonly next: string | null;
  /** A one-off whose run has a record. */
  readonly spent: boolean;
  /** Why the file will not run, else null. */
  readonly problem: string | null;
  readonly last: RouteRun | null;
}

/** A thing the Star needs from the user, as the plugin read its file, `.pult/asks/<name>.md`: its title the file's first line, its text the whole file. */
export interface RouteAsk {
  readonly name: string;
  readonly title: string;
  readonly text: string;
  /** The file, a host path. */
  readonly path: string;
}

/** A model as the server's threads carry it, the fields the page checks; the view decodes it in full. */
export interface RouteModel {
  readonly instanceId: string;
  readonly model: string;
}

/** A Star as `GET /stars` serves it, the fields the page draws; `root` and `instructions` are host paths. */
export interface RouteStar extends WrittenStar {
  readonly instructions: string;
  /** Every open channel, `user` among them, by slug; none while it sleeps. `asleepSince`, `model` and `conversations` are `user`'s. */
  readonly channels: ReadonlyArray<RouteChannel>;
  /** Since when `user` sleeps: its last conversation's settlement, else the Star's creation. */
  readonly asleepSince: string;
  /** The model its next conversation with the user takes, the one a wake by message into `user` takes; null before its first, and from a plugin older than the field. */
  readonly model: RouteModel | null;
  /** The names of `user`'s transcripts on this environment, oldest first. */
  readonly conversations: ReadonlyArray<string>;
  /** Its schedules' files, by name; none from a plugin older than the schedules. */
  readonly schedules: ReadonlyArray<RouteSchedule>;
  /** Its asks, by name; none from a plugin older than the asks. */
  readonly asks: ReadonlyArray<RouteAsk>;
}

/** What `GET /stars` answers: the server's Stars directory (a host path), the projects a page draws as no project, and its Stars. */
export interface StarsAnswer {
  readonly directory: string;
  readonly hidden: ReadonlyArray<string>;
  readonly stars: ReadonlyArray<RouteStar>;
}

/** One entry of a transcript: a message of the user's or the Star's, or a tool call's line. */
export interface TranscriptEntry {
  readonly kind: "user" | "star" | "tool";
  readonly at: string;
  readonly text: string;
}

/** A transcript as `GET /stars/<id>/conversations/<name>` serves it, parsed. */
export interface Transcript {
  readonly threadId: string;
  readonly started: string;
  readonly ended: string;
  readonly environment: string;
  readonly title: string;
  /** Written from the latest turns alone, its start missing. */
  readonly partial: boolean;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

/** An answer of the plugin that is not of its route's shape: the page shows no Star there and tells it. */
export class PluginAnswerError extends Error {
  override readonly name = "PluginAnswerError";
}

type Fields = { readonly [key: string]: unknown };

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A decoder: the value as `T`, or a throw naming where it was not. */
type Decode<T> = (value: unknown, at: string) => T;

const fail = (at: string, what: string): never => {
  throw new PluginAnswerError(`${at} is not ${what}`);
};

const string: Decode<string> = (value, at) =>
  typeof value === "string" ? value : fail(at, "a string");

const boolean: Decode<boolean> = (value, at) =>
  typeof value === "boolean" ? value : fail(at, "a boolean");

const nullable =
  <T>(each: Decode<T>): Decode<T | null> =>
  (value, at) =>
    value === null ? null : each(value, at);

const arrayOf =
  <T>(each: Decode<T>): Decode<ReadonlyArray<T>> =>
  (value, at) =>
    Array.isArray(value)
      ? value.map((item: unknown, index) => each(item, `${at}[${index}]`))
      : fail(at, "an array");

/** An object's fields, each decoded; other fields are let be, as a newer plugin adds them. */
const struct =
  <T extends object>(decoders: { readonly [K in keyof T]: Decode<T[K]> }): Decode<T> =>
  (value, at) => {
    if (!isFields(value)) return fail(at, "an object");
    const decoded: Partial<T> = {};
    for (const key of Object.keys(decoders) as Array<keyof T & string>)
      decoded[key] = decoders[key](value[key], `${at}.${key}`);
    return decoded as T;
  };

const sleeps: Decode<RouteChannel["sleeps"]> = (value, at) => {
  if (isFields(value) && typeof value.at === "string") return { at: value.at };
  if (isFields(value) && typeof value.heldBy === "string") return { heldBy: value.heldBy };
  return fail(at, "{ at } or { heldBy }");
};

const channel = struct<RouteChannel>({ slug: string, threadId: string, sleeps });

/** A server without channels serves none: absent reads as none open, any other shape fails. */
const channels: Decode<ReadonlyArray<RouteChannel>> = (value, at) =>
  value === undefined ? [] : arrayOf(channel)(value, at);

const schedule = struct<RouteSchedule>({
  name: string,
  path: string,
  rule: nullable(string),
  timezone: nullable(string),
  next: nullable(string),
  spent: boolean,
  problem: nullable(string),
  last: nullable(
    struct<RouteRun>({
      due: string,
      fired: string,
      result: string,
      error: nullable(string),
      thread: nullable(string),
    }),
  ),
});

/** A plugin older than the schedules serves none: absent reads as none, any other shape fails. */
const schedules: Decode<ReadonlyArray<RouteSchedule>> = (value, at) =>
  value === undefined ? [] : arrayOf(schedule)(value, at);

/** A plugin older than the asks serves none: absent reads as none, any other shape fails. */
const asks: Decode<ReadonlyArray<RouteAsk>> = (value, at) =>
  value === undefined
    ? []
    : arrayOf(struct<RouteAsk>({ name: string, title: string, text: string, path: string }))(
        value,
        at,
      );

/** A plugin older than the field serves none: absent reads as null. Its options and any other field are kept, for the view to decode. */
const model: Decode<RouteModel | null> = (value, at) => {
  if (value === undefined || value === null) return null;
  struct<RouteModel>({ instanceId: string, model: string })(value, at);
  return value as RouteModel;
};

const writtenStar = struct<WrittenStar>({
  id: string,
  name: string,
  tint: string,
  created: string,
  root: string,
  projectId: string,
});

const routeStar = struct<RouteStar>({
  id: string,
  name: string,
  tint: string,
  created: string,
  root: string,
  projectId: string,
  instructions: string,
  channels,
  asleepSince: string,
  model,
  conversations: arrayOf(string),
  schedules,
  asks,
});

const starsAnswer = struct<StarsAnswer>({
  directory: string,
  hidden: arrayOf(string),
  stars: arrayOf(routeStar),
});

const entryKind: Decode<TranscriptEntry["kind"]> = (value, at) =>
  value === "user" || value === "star" || value === "tool" ? value : fail(at, "user, star or tool");

const transcript = struct<Transcript>({
  threadId: string,
  started: string,
  ended: string,
  environment: string,
  title: string,
  partial: boolean,
  entries: arrayOf(struct<TranscriptEntry>({ kind: entryKind, at: string, text: string })),
});

/** `GET /stars`'s answer, decoded; a throw for any other shape. */
export const decodeStars = (body: unknown): StarsAnswer => starsAnswer(body, "stars");
/** A Star as the write routes answer it, decoded; a throw for any other shape. */
const decodeStar = (body: unknown): WrittenStar => writtenStar(body, "star");
/** A transcript's answer, decoded; a throw for any other shape. */
export const decodeTranscript = (body: unknown): Transcript => transcript(body, "transcript");

/**
 * Asks a route of the plugin with the environment's bearer and decodes its
 * answer. A refusal throws the plugin's own `{ error }`, or its status; an
 * answer that is no JSON, or JSON of another shape, throws a
 * `PluginAnswerError`.
 */
async function ask<T>(
  credential: Credential,
  method: "GET" | "POST",
  path: string,
  decode: (body: unknown) => T,
  body?: unknown,
): Promise<T> {
  const response = await fetch(new URL(`${PLUGIN_PATH}${path}`, credential.httpBaseUrl), {
    method,
    headers: {
      authorization: `Bearer ${credential.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(method === "GET" ? { signal: AbortSignal.timeout(READ_TIMEOUT_MS) } : {}),
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isFields(json) && typeof json.error === "string" ? json.error : undefined;
    throw new Error(error ?? `the server's Pult plugin answered ${response.status}`);
  }
  if (json === undefined) throw new PluginAnswerError(`${method} ${path} answered no JSON`);
  return decode(json);
}

const starPath = (id: string) => `/stars/${encodeURIComponent(id)}`;

/** The server's Stars, as a page draws them. */
export const readStars = (credential: Credential) => ask(credential, "GET", "/stars", decodeStars);

/** A new Star in a fresh folder; with `ifNone`, the one there while the server has any. */
export const createStarOn = (credential: Credential, options: { readonly ifNone: boolean }) =>
  ask(credential, "POST", "/stars", decodeStar, options);

/** The plugin's upkeep now, a Star that arrived by a clone or a pull made a project; answered as `readStars`. */
export const upkeepStars = (credential: Credential) =>
  ask(credential, "POST", "/stars/upkeep", decodeStars, {});

/** Rewrites those lines of the Star's record and retitles its project. */
export const writeStarRecord = (
  credential: Credential,
  id: string,
  fields: { readonly name?: string; readonly tint?: string },
) => ask(credential, "POST", starPath(id), decodeStar, fields);

/** What Refresh Context answers: the Star's conversation in `user` put to sleep, or left awake by what holds it, the sleep rule's hold as `sleeps` names it. */
export type SleepAnswer =
  | { readonly slept: true }
  | { readonly slept: false; readonly heldBy: string };

const sleepAnswer = (body: unknown): SleepAnswer => {
  if (isFields(body) && body.slept === true) return { slept: true };
  if (isFields(body) && body.slept === false && typeof body.heldBy === "string")
    return { slept: false, heldBy: body.heldBy };
  return fail("sleep", "{ slept: true } or { slept: false, heldBy }");
};

/** Puts the Star's current conversation in `user` to sleep now, unless something holds it; a Star asleep already is refused. */
export const sleepStarOn = (credential: Credential, id: string) =>
  ask(credential, "POST", `${starPath(id)}/sleep`, sleepAnswer, {});

/** One transcript of the Star on this environment, parsed. */
export const readStarTranscript = (credential: Credential, id: string, name: string) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}/conversations/${encodeURIComponent(name)}`,
    decodeTranscript,
  );
