// The server's Pult plugin, as the page asks it (`plugins/pult`, xaxis
// `pult/tasks/durable-agent-sleep.task/design.md`, The routes): the one file that names its
// routes, apart from the workbench so `node --test src/stars/plugin.test.ts`
// can run it. `about` says what the plugin of a server does; the Stars'
// routes serve everything the page knows of a Star, each answer decoded
// strictly, so an answer of another shape fails loudly.

/** The plugin's feature of keeping the Stars: where `about` lists it, the server finds, keeps and serves its Stars, and the page draws them. */
export const STARS_FEATURE = "stars";

/** The plugin's feature of firing the Stars' schedules: listed only where the server fires them, none under its `schedules-off`. */
export const SCHEDULES_FEATURE = "star-schedules";

/** The plugin's feature of putting a Star's channel to sleep by hand, Refresh Context: `POST stars/<id>/sleep` with `{ channel }`, offered only where `about` lists it. */
export const CHANNEL_SLEEP_FEATURE = "star-channel-sleep";

/** The plugin's feature of a Star's model per channel (`.pult/channel-models.json`): `POST stars/<id>/model`, asked only where `about` lists it. */
export const CHANNEL_MODELS_FEATURE = "star-channel-models";
/** A channel's transcripts, listed by `GET stars/<id>/channels/<slug>/conversations` and read by their route. */
export const CHANNEL_HISTORY_FEATURE = "star-channel-history";
/** A channel's settings, read and written by `GET` and `POST stars/<id>/channels/<slug>/settings`, which its details shelf draws. */
export const CHANNEL_SETTINGS_FEATURE = "star-channel-settings";

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

/** A batch of changes under a Stars directory, as its watch tells it. */
interface DirectoryChanges {
  readonly changes: ReadonlyArray<{ readonly path: string }>;
  readonly truncated: boolean;
}

/** An answer's Stars, as the watch's readers need them: each one's folder and default channel. */
interface WatchedStars {
  readonly directory: string;
  readonly stars: ReadonlyArray<{
    readonly id: string;
    readonly root: string;
    readonly defaultChannel: string;
  }>;
}

/**
 * The Stars of `answer` whose channels a batch of changes under its Stars
 * directory touched, `which` of them: a change to a Star's
 * `.pult/channels/<slug>` or under it (`under`, below it, a path in the
 * channel's folder relative to it, empty for the folder itself), the Star's
 * folder read from the change's path, relative to the directory; every Star
 * where more changed than the batch names.
 */
function starsTouched(
  event: DirectoryChanges,
  answer: WatchedStars,
  which: (star: WatchedStars["stars"][number], slug: string, under: string) => boolean,
): string[] {
  const slashed = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  const directory = slashed(answer.directory);
  const touched = event.changes.flatMap((change) => {
    const match = /^(.+)\/\.pult\/channels\/([^/]+)(?:\/(.*))?$/.exec(slashed(change.path));
    return match === null
      ? []
      : [{ folder: `${directory}/${match[1]}`, slug: match[2] ?? "", under: match[3] ?? "" }];
  });
  return answer.stars
    .filter(
      (star) =>
        event.truncated ||
        touched.some(
          ({ folder, slug, under }) => folder === slashed(star.root) && which(star, slug, under),
        ),
    )
    .map((star) => star.id);
}

/**
 * The Stars of `answer` a batch of changes may have rewritten a transcript
 * of their default channel for, which the fold shows, as a conversation
 * un-settled and settled again does: a change to the Star's
 * `.pult/channels/<default>` or under it, where the plugin writes them;
 * every Star where more changed than the batch names.
 */
export const defaultTranscriptStars = (event: DirectoryChanges, answer: WatchedStars) =>
  starsTouched(event, answer, (star, slug) => slug === star.defaultChannel);

/**
 * The Stars of `answer` a batch of changes may have written a transcript of
 * a channel but the default one for, which no answer names (its
 * `conversations` are the default channel's): a change under a Star's
 * `.pult/channels/<slug>/conversations/`, `slug` not its default channel;
 * every Star where more changed than the batch names.
 */
export const channelTranscriptStars = (event: DirectoryChanges, answer: WatchedStars) =>
  starsTouched(
    event,
    answer,
    (star, slug, under) =>
      slug !== star.defaultChannel &&
      (under === "conversations" || under.startsWith("conversations/")),
  );

/**
 * The Stars of `answer` a batch of changes may have changed a channel's
 * settings for: a change to a Star's `.pult/channels/settings.yaml`, every
 * channel's, or a `.pult/channels/<slug>/settings.yaml`, one channel's;
 * every Star where more changed than the batch names.
 */
export const channelSettingsStars = (event: DirectoryChanges, answer: WatchedStars) =>
  starsTouched(
    event,
    answer,
    (_, slug, under) => (slug === "settings.yaml" && under === "") || under === "settings.yaml",
  );

/** An open channel of a Star's as the route reads it: its slug, its current conversation's thread, and the sleep rule's reading of it, a deadline or what holds it. */
export interface RouteChannel {
  readonly slug: string;
  readonly threadId: string;
  readonly sleeps: { readonly at: string } | { readonly heldBy: string };
}

/** The fields the shelf can edit in a Star's record. */
export interface RecordFields {
  readonly name?: string;
  readonly description?: string;
  readonly tint?: string;
}

/** A Star as the write routes answer it: its record, its folder (a host path) and its project. */
export interface WrittenStar {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly description: string | null;
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

const SCHEDULE_KINDS = ["daily", "once", "every"] as const;

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** A schedule of a Star's, as the plugin parsed its file: the rule in words and the next due instant are the plugin's, the page only draws them. */
export interface RouteSchedule {
  readonly name: string;
  /** What to show in place of the name; null where the file sets none, or from a plugin older than titles. */
  readonly title: string | null;
  /** The file, a host path. */
  readonly path: string;
  /** The rule in words, `weekdays 09:00`; null for a file that is no schedule. */
  readonly rule: string | null;
  /** The rule's kind, its icon's: `daily` and `every` recur, `once` is a one-off; null for a file that is no schedule, from a plugin older than kinds, or of a kind this page does not know. */
  readonly kind: ScheduleKind | null;
  /** Its IANA zone; null for a file that is no schedule. */
  readonly timezone: string | null;
  /** The channel its runs land in, its `to`, else the Star's default channel; null for a file that is no schedule, or from a plugin older than the field. */
  readonly channel: string | null;
  /** The next due instant, ISO; null where none is. */
  readonly next: string | null;
  /** A one-off whose run has a record. */
  readonly spent: boolean;
  /** Why the file will not run, else null. */
  readonly problem: string | null;
  readonly last: RouteRun | null;
}

/** Where `about` lists it, the plugin serves the asks (`pult_ask`'s): `GET asks` and `POST asks/<id>/<action>`. */
export const ASKS_FEATURE = "asks";

/** Who posted an ask: a Star's conversation in a channel, or any other thread. */
export type RoutePoster =
  | { readonly star: string; readonly channel: string }
  | { readonly thread: string };

export type AskStatus = "posted" | "replied" | "snoozed" | "settled";

/** An ask as the plugin serves it on a card's action; `file` is a host path, `settled` its own settle or its thread's. */
export interface RouteAsk {
  readonly id: string;
  readonly title: string;
  readonly status: AskStatus;
  readonly file: string;
  readonly poster: RoutePoster;
  readonly posted: string;
  readonly replied: string | null;
  readonly snoozedUntil: string | null;
  readonly settled: string | null;
  /** The reply options its poster suggests. */
  readonly replies: ReadonlyArray<string>;
}

/** What `GET asks` answers: the asks folder (a host path) and its hidden project, null before its first Markdown, and every ask by `posted`, each with the line its reply opens with. */
export interface AsksAnswer {
  readonly folder: string;
  readonly projectId: string | null;
  readonly asks: ReadonlyArray<RouteAsk & { readonly prefix: string }>;
}

/** A model as the server's threads carry it, the fields the page checks; the view decodes it in full. */
export interface RouteModel {
  readonly instanceId: string;
  readonly model: string;
}

/** A Star as `GET /stars` serves it, the fields the page draws; `root` and `instructions` are host paths. */
export interface RouteStar extends WrittenStar {
  readonly instructions: string;
  /** The slug of its default channel, the one its tab shows, `default-channel` in its record (`star-channels`). */
  readonly defaultChannel: string;
  /** Every open channel, the default among them, by slug; none while it sleeps. `asleepSince`, `model` and `conversations` are the default channel's. */
  readonly channels: ReadonlyArray<RouteChannel>;
  /** Since when the default channel sleeps: its last conversation's settlement, else the Star's creation. */
  readonly asleepSince: string;
  /** The model the default channel's next conversation takes, the one a wake by message into it takes; null before its first. */
  readonly model: RouteModel | null;
  /** An older plugin's names of every other channel's transcripts, by channel, oldest first; a newer one lists a channel's by `readStarChannelTranscripts`. */
  readonly histories?: ReadonlyArray<{
    readonly slug: string;
    readonly names: ReadonlyArray<string>;
  }>;
  readonly conversations: ReadonlyArray<string>;
  /** Its schedules' files, by name; none from a plugin older than the schedules. */
  readonly schedules: ReadonlyArray<RouteSchedule>;
}

/** What `GET /stars` answers: the server's Stars directory (a host path), the projects a page draws as no project, and its Stars. */
export interface StarsAnswer {
  readonly directory: string;
  readonly hidden: ReadonlyArray<string>;
  readonly stars: ReadonlyArray<RouteStar>;
}

/** When a channel's conversation ends for its size: from this many tokens in its context, or never (`rotate-on-context`). */
export type RotateOnContext = number | "never";

/** A channel's settings as `GET stars/<id>/channels/<slug>/settings` serves them, at the runtime mode of its newest conversation. */
export interface ChannelSettings {
  /** The model a fresh conversation takes, its options kept for the view to decode; null where neither a file nor a conversation names one. */
  readonly model: RouteModel | null;
  /** The file of the `model` key, this channel's or every channel's, or its last conversation; null with no model. */
  readonly modelFrom: "channel" | "shared" | "conversation" | null;
  readonly rotateOnContext: RotateOnContext;
  /** The file of the `rotate-on-context` key, or Pult's default where none says. */
  readonly rotateFrom: "channel" | "shared" | "default";
  /** Since when it sleeps, ISO; null while it is awake. */
  readonly asleepSince: string | null;
  /** What is wrong with the files, in the plugin's sentences. */
  readonly problems: ReadonlyArray<string>;
}

/** What the shelf writes into a channel's own file: a key left out is left alone, null removes it. */
export interface ChannelSettingsChanges {
  readonly model?: RouteModel | null;
  readonly rotateOnContext?: RotateOnContext | null;
}

/** `rotate-on-context` as the plugin reads it: thousands of tokens written with a `k`, `1k` to `999999k`, or `never`. */
const ROTATE_THOUSANDS = /^([1-9][0-9]{0,5})k$/u;

/** A typed `rotate-on-context`, as the plugin reads the key: tokens, `never`, or null for an empty one, which removes the key; undefined for one it refuses. */
export function parseRotateOnContext(text: string): RotateOnContext | null | undefined {
  const typed = text.trim();
  if (typed === "") return null;
  if (typed === "never") return "never";
  const thousands = ROTATE_THOUSANDS.exec(typed)?.[1];
  return thousands === undefined ? undefined : Number(thousands) * 1000;
}

/** `rotate-on-context` as a file says it: `400k`, or `never`. */
export const rotateOnContextText = (value: RotateOnContext) =>
  value === "never" ? "never" : `${value / 1000}k`;

/** One entry of a transcript: a message of the user's or the Star's, or a tool call's line. */
export interface TranscriptEntry {
  readonly kind: "user" | "star" | "tool";
  readonly at: string;
  readonly text: string;
  /** A Star reply's message; null for any other entry, and for a reply written before transcripts named it or served by an older plugin. */
  readonly messageId: string | null;
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

/** An optional field: absent reads as null, any other shape fails. */
const optional =
  <T>(each: Decode<T>): Decode<T | null> =>
  (value, at) =>
    value === undefined ? null : each(value, at);

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

/** A newer plugin's kind reads as none, drawn with no icon, so it hides no Star. */
const scheduleKind: Decode<ScheduleKind | null> = (value, at) => {
  const kind = string(value, at);
  return SCHEDULE_KINDS.find((each) => each === kind) ?? null;
};

const schedule = struct<RouteSchedule>({
  name: string,
  title: optional(nullable(string)),
  path: string,
  rule: nullable(string),
  kind: optional(nullable(scheduleKind)),
  timezone: nullable(string),
  channel: optional(nullable(string)),
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

/** A plugin older than the field serves none: absent reads as null. Its options and any other field are kept, for the view to decode. */
const model: Decode<RouteModel | null> = (value, at) => {
  if (value === undefined || value === null) return null;
  struct<RouteModel>({ instanceId: string, model: string })(value, at);
  return value as RouteModel;
};

const writtenStar = struct<WrittenStar>({
  id: string,
  name: string,
  description: optional(string),
  tint: string,
  created: string,
  root: string,
  projectId: string,
});

const routeStar = struct<RouteStar>({
  id: string,
  name: string,
  description: optional(string),
  tint: string,
  created: string,
  root: string,
  projectId: string,
  instructions: string,
  defaultChannel: string,
  channels,
  asleepSince: string,
  model,
  histories: (value, at) =>
    value === undefined
      ? undefined
      : arrayOf(
          struct<{ slug: string; names: ReadonlyArray<string> }>({
            slug: string,
            names: arrayOf(string),
          }),
        )(value, at),
  conversations: arrayOf(string),
  schedules,
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
  entries: arrayOf(
    struct<TranscriptEntry>({
      kind: entryKind,
      at: string,
      text: string,
      messageId: optional(string),
    }),
  ),
});

const askStatus: Decode<AskStatus> = (value, at) =>
  value === "posted" || value === "replied" || value === "snoozed" || value === "settled"
    ? value
    : fail(at, "posted, replied, snoozed or settled");

const poster: Decode<RoutePoster> = (value, at) => {
  if (isFields(value) && typeof value.star === "string" && typeof value.channel === "string")
    return { star: value.star, channel: value.channel };
  if (isFields(value) && typeof value.thread === "string") return { thread: value.thread };
  return fail(at, "{ star, channel } or { thread }");
};

/** A plugin older than the replies serves none: absent reads as none, any other shape fails. */
const askReplies: Decode<ReadonlyArray<string>> = (value, at) =>
  value === undefined ? [] : arrayOf(string)(value, at);

const routeAsk = struct<RouteAsk>({
  id: string,
  title: string,
  status: askStatus,
  file: string,
  poster,
  posted: string,
  replied: nullable(string),
  snoozedUntil: nullable(string),
  settled: nullable(string),
  replies: askReplies,
});

const asksAnswer = struct<AsksAnswer>({
  folder: string,
  projectId: nullable(string),
  asks: arrayOf((value, at) => ({
    ...routeAsk(value, at),
    prefix: struct<{ prefix: string }>({ prefix: string })(value, at).prefix,
  })),
});

/** A transcript as the lookup by its thread serves it, with its name among the Star's `conversations`. */
export interface NamedTranscript extends Transcript {
  readonly name: string;
}

const namedTranscript: Decode<NamedTranscript> = (value, at) => ({
  ...transcript(value, at),
  name: string(isFields(value) ? value.name : undefined, `${at}.name`),
});

/** `GET /stars`'s answer, decoded; a throw for any other shape. */
export const decodeStars = (body: unknown): StarsAnswer => starsAnswer(body, "stars");
/** A Star as the write routes answer it, decoded; a throw for any other shape. */
const decodeStar = (body: unknown): WrittenStar => writtenStar(body, "star");
const literal =
  <T extends string>(values: ReadonlyArray<T>): Decode<T> =>
  (value, at) =>
    values.find((each) => each === value) ?? fail(at, `one of ${values.join(", ")}`);

const rotateOnContext: Decode<RotateOnContext> = (value, at) =>
  value === "never" || (typeof value === "number" && Number.isInteger(value) && value > 0)
    ? value
    : fail(at, "tokens or never");

const channelSettings = struct<ChannelSettings>({
  model,
  modelFrom: nullable(literal(["channel", "shared", "conversation"] as const)),
  rotateOnContext,
  rotateFrom: literal(["channel", "shared", "default"] as const),
  asleepSince: nullable(string),
  problems: arrayOf(string),
});

/** A channel's settings' answer, decoded; a throw for any other shape. */
const decodeChannelSettings = (body: unknown): ChannelSettings => channelSettings(body, "settings");

/** A transcript's answer, decoded; a throw for any other shape. */
const decodeAsks = (body: unknown): AsksAnswer => asksAnswer(body, "asks");
const decodeAsk = (body: unknown): RouteAsk => routeAsk(body, "ask");
export const decodeTranscript = (body: unknown): Transcript => transcript(body, "transcript");
/** A channel's transcripts' names, `{ names }`, oldest first; a throw for any other shape. */
export const decodeChannelTranscripts = (body: unknown): ReadonlyArray<string> =>
  struct<{ names: ReadonlyArray<string> }>({ names: arrayOf(string) })(body, "channel").names;

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

/** A new Star in a fresh folder named after `name`; with `ifNone`, the one there while the server has any. */
export const createStarOn = (
  credential: Credential,
  options: { readonly ifNone: boolean; readonly name?: string },
) => ask(credential, "POST", "/stars", decodeStar, options);

/** Rewrites those lines of the Star's record and retitles its project. */
export const writeStarRecord = (credential: Credential, id: string, fields: RecordFields) =>
  ask(credential, "POST", starPath(id), decodeStar, fields);

/** What Refresh Context answers: the channel's conversation put to sleep, or left awake by what holds it, the sleep rule's hold as `sleeps` names it. */
export type SleepAnswer =
  | { readonly slept: true }
  | { readonly slept: false; readonly heldBy: string };

const sleepAnswer = (body: unknown): SleepAnswer => {
  if (isFields(body) && body.slept === true) return { slept: true };
  if (isFields(body) && body.slept === false && typeof body.heldBy === "string")
    return { slept: false, heldBy: body.heldBy };
  return fail("sleep", "{ slept: true } or { slept: false, heldBy }");
};

/** Puts the current conversation of the Star's `channel` to sleep now, unless something holds it; a channel asleep already is refused. */
export const sleepChannelOn = (credential: Credential, id: string, channel: string) =>
  ask(credential, "POST", `${starPath(id)}/sleep`, sleepAnswer, { channel });

const wakeModel = (body: unknown): RouteModel | null =>
  isFields(body) && body.model !== undefined
    ? model(body.model, "wake.model")
    : fail("wake", "{ model }");

/**
 * The model the page wakes the Star's `channel` at itself (its draft, a
 * sync's handoff), at `runtimeMode`: the Star's choice, its options kept for
 * the caller to decode, or null for the page's own; the plugin tells the
 * channel of a file it cannot serve.
 */
export const readWakeModel = (
  credential: Credential,
  id: string,
  runtimeMode: string,
  channel: string,
) => ask(credential, "POST", `${starPath(id)}/model`, wakeModel, { runtimeMode, channel });

/** One transcript of the Star on this environment, parsed. */
export const readStarTranscript = (
  credential: Credential,
  id: string,
  name: string,
  channel?: string,
) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}${channel === undefined ? "" : "/channels/" + encodeURIComponent(channel)}/conversations/${encodeURIComponent(name)}`,
    decodeTranscript,
  );

/** The names of the transcripts of the Star's `channel` on this environment, oldest first. */
export const readStarChannelTranscripts = (credential: Credential, id: string, channel: string) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}/channels/${encodeURIComponent(channel)}/conversations`,
    decodeChannelTranscripts,
  );

const channelSettingsPath = (id: string, channel: string) =>
  `${starPath(id)}/channels/${encodeURIComponent(channel)}/settings`;

/** The settings of the Star's `channel` on this environment, as its shelf draws them. */
export const readStarChannelSettings = (credential: Credential, id: string, channel: string) =>
  ask(credential, "GET", channelSettingsPath(id, channel), decodeChannelSettings);

/** Writes `changes` into the channel's own settings file on this environment, answering its settings after. */
export const writeStarChannelSettings = (
  credential: Credential,
  id: string,
  channel: string,
  changes: ChannelSettingsChanges,
) => ask(credential, "POST", channelSettingsPath(id, channel), decodeChannelSettings, changes);

/** The transcript whose conversation was the thread `threadId`, with its name; a throw where the Star has none, as from an older plugin. */
export const readStarTranscriptOfThread = (credential: Credential, id: string, threadId: string) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}/conversations/by-thread?threadId=${encodeURIComponent(threadId)}`,
    (body) => namedTranscript(body, "transcript"),
  );

/** The server's asks, every one, by `posted`. */
export const readAsks = (credential: Credential) => ask(credential, "GET", "/asks", decodeAsks);

/** What a page does to an ask: its reply sent, Settle, Un-settle, or Snooze until a time, null being Wake. */
export type AskAction =
  | { readonly kind: "replied" | "settle" | "unsettle" }
  | { readonly kind: "snooze"; readonly until: string | null };

/** Acts on the ask, answering it as it stands after; a refusal (unknown, its thread's settle, a settle notice that failed) throws the plugin's words. */
export const actOnAsk = (credential: Credential, id: string, action: AskAction) =>
  ask(
    credential,
    "POST",
    `/asks/${encodeURIComponent(id)}/${action.kind}`,
    decodeAsk,
    action.kind === "snooze" ? { until: action.until } : undefined,
  );

/** The plugin's feature of keeping the xaxis checkout of `/` at main's tip (`pult/decisions`, `xaxis-kept-checkouts`): `GET xaxis/kept`, asked only where `about` lists it. */
export const XAXIS_KEPT_FEATURE = "xaxis-kept";

/** The kept checkout's latest Get latest, as the mover recorded it. */
export interface KeptAttempt {
  readonly at: string;
  readonly outcome: "moved" | "up-to-date" | "waiting" | "failed";
  readonly code: string | null;
  /** The CLI's message and hint, for a refusal or a failure. */
  readonly message: string | null;
}

/** A kept checkout as `xaxis/kept` answers it. */
export interface KeptCheckout {
  readonly dir: string;
  readonly last: KeptAttempt | null;
  /** The Get latest under way, since when; null while none runs. */
  readonly running: { readonly since: string } | null;
  /** Threads with a run in progress working inside the checkout. */
  readonly agentThreads: ReadonlyArray<string>;
}

/** `GET xaxis/kept`'s answer: the kept folder, its checkouts, and why the CLI could not list them, null when it could. */
export interface KeptAnswer {
  readonly folder: string;
  readonly checkouts: ReadonlyArray<KeptCheckout>;
  readonly unlisted: string | null;
}

const outcome: Decode<KeptAttempt["outcome"]> = (value, at) =>
  value === "moved" || value === "up-to-date" || value === "waiting" || value === "failed"
    ? value
    : fail(at, "moved, up-to-date, waiting or failed");

const keptAnswer = struct<KeptAnswer>({
  folder: string,
  checkouts: arrayOf(
    struct<KeptCheckout>({
      dir: string,
      last: nullable(
        struct<KeptAttempt>({
          at: string,
          outcome,
          code: optional(string),
          message: optional(string),
        }),
      ),
      running: optional(struct<{ readonly since: string }>({ since: string })),
      agentThreads: arrayOf(string),
    }),
  ),
  unlisted: optional(string),
});

/** `GET xaxis/kept`'s answer, decoded; a throw for any other shape. */
export const decodeKept = (body: unknown): KeptAnswer => keptAnswer(body, "kept");

/** The kept xaxis checkout and its mover's state. */
export const readXaxisKept = (credential: Credential) =>
  ask(credential, "GET", "/xaxis/kept", decodeKept);
