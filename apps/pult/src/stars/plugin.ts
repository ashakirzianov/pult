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

/** The plugin's feature of putting a Star to sleep by hand, Refresh Context: `POST stars/<id>/sleep`, offered only where `about` lists it. */
export const SLEEP_FEATURE = "star-sleep";

/** The plugin's feature of a Star's model per channel (`.pult/channel-models.json`): `POST stars/<id>/model`, asked only where `about` lists it. */
export const CHANNEL_MODELS_FEATURE = "star-channel-models";

/** The plugin's feature of keeping its Mac awake while agents work, a switch read and set through `keep-awake`; listed on darwin alone. */
export const KEEP_AWAKE_FEATURE = "keep-awake";

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

/** The channel with the user, whose conversation is the Star's tab (xaxis `pult/tasks/star-channels.task`). */
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
/** A transcript's answer, decoded; a throw for any other shape. */
const decodeAsks = (body: unknown): AsksAnswer => asksAnswer(body, "asks");
const decodeAsk = (body: unknown): RouteAsk => routeAsk(body, "ask");
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

/** A new Star in a fresh folder named after `name`; with `ifNone`, the one there while the server has any. */
export const createStarOn = (
  credential: Credential,
  options: { readonly ifNone: boolean; readonly name?: string },
) => ask(credential, "POST", "/stars", decodeStar, options);

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

const wakeModel = (body: unknown): RouteModel | null =>
  isFields(body) && body.model !== undefined
    ? model(body.model, "wake.model")
    : fail("wake", "{ model }");

/**
 * The model the page wakes the Star's `user` at itself (its draft, a sync's
 * handoff), or `channel` (its tagged draft), at `runtimeMode`: the Star's
 * choice, its options kept for the caller to decode, or null for the page's
 * own; the plugin tells the Star's `work` of a file it cannot serve.
 */
export const readWakeModel = (
  credential: Credential,
  id: string,
  runtimeMode: string,
  channel?: string,
) =>
  ask(credential, "POST", `${starPath(id)}/model`, wakeModel, {
    runtimeMode,
    ...(channel === undefined ? {} : { channel }),
  });

/** One transcript of the Star on this environment, parsed. */
export const readStarTranscript = (credential: Credential, id: string, name: string) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}/conversations/${encodeURIComponent(name)}`,
    decodeTranscript,
  );

/** The transcript whose conversation was the thread `threadId`, with its name; a throw where the Star has none, as from an older plugin. */
export const readStarTranscriptOfThread = (credential: Credential, id: string, threadId: string) =>
  ask(
    credential,
    "GET",
    `${starPath(id)}/conversations/by-thread?threadId=${encodeURIComponent(threadId)}`,
    (body) => namedTranscript(body, "transcript"),
  );

const keepAwakeAnswer = (body: unknown): boolean =>
  isFields(body) && typeof body.on === "boolean" ? body.on : fail("keep-awake", "{ on }");

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

/** Whether the server keeps its Mac awake while agents work. */
export const readKeepAwake = (credential: Credential) =>
  ask(credential, "GET", "/keep-awake", keepAwakeAnswer);

/** Turns keeping the Mac awake on or off; answered as `readKeepAwake`. */
export const writeKeepAwake = (credential: Credential, on: boolean) =>
  ask(credential, "POST", "/keep-awake", keepAwakeAnswer, { on });

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
