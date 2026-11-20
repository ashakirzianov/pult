// A Star's model per channel (xaxis `pult/issues/star-channel-model.md`): `.pult/channel-models.json`
// names a `default` and exact channels' `{provider, model, effort?}`. A choice this environment
// cannot serve, its provider lacking the wake's runtime mode included, falls back, entry to `default`
// to the newest conversation's; what was wrong comes back with the content's hash, told once per content.
import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  Digest,
  Effect,
  FileSystem,
  Path,
  ProviderRegistry,
  ThreadManagementService,
} from "../host.ts";
import { type Channel, isChannel } from "./channels.ts";
import { SYSTEM_DIRECTORY } from "./record.ts";

export const CHANNEL_MODELS_FILE = `${SYSTEM_DIRECTORY}/channel-models.json`;

/** The option each driver takes effort as; a driver not here takes a model alone. */
const EFFORT_OPTION: ReadonlyMap<ProviderDriverKind, string> = new Map([
  ["claudeAgent" as ProviderDriverKind, "effort"],
  ["codex" as ProviderDriverKind, "reasoningEffort"],
]);

/** How many of an environment's models a problem lists. */
const LISTED_MODELS = 12;

export interface ChannelModel {
  /** The selection a fresh conversation of the channel starts with; null for today's, the newest conversation's. */
  readonly selection: ModelSelection | null;
  /** Where it came from: the channel's entry, the file's `default`, or neither. */
  readonly from: "channel" | "default" | "history";
  /** What is wrong with the file on this environment, every entry checked; null where nothing is or there is no file. */
  readonly broken: BrokenFile | null;
}

export interface BrokenFile {
  /** The file's content as SHA-256 hex, so the Star is told once per content. */
  readonly hash: string;
  /** One sentence each, naming the field, its value and what this environment accepts. */
  readonly problems: ReadonlyArray<string>;
}

interface Choice {
  readonly provider: string;
  readonly model: string;
  readonly effort: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `"${value}"`).join(", ");

/** An entry's shape, `{provider, model, effort?}` and nothing else; a problem where it is not. */
const readChoice = (field: string, value: unknown): Choice | string => {
  if (!isRecord(value))
    return `\`${field}\` is not an object of \`provider\`, \`model\` and optional \`effort\``;
  const unknown = Object.keys(value).filter(
    (key) => !["provider", "model", "effort"].includes(key),
  );
  if (unknown.length > 0)
    return `\`${field}\` has ${quoted(unknown)}, which is none of \`provider\`, \`model\`, \`effort\``;
  const { provider, model, effort } = value;
  for (const [key, text] of [
    ["provider", provider],
    ["model", model],
  ] as const)
    if (typeof text !== "string" || text.trim() === "")
      return `\`${field}.${key}\` is not a non-empty string`;
  if (effort !== undefined && (typeof effort !== "string" || effort.trim() === ""))
    return `\`${field}.effort\` is not a non-empty string; omit it for the model's default`;
  return {
    provider: (provider as string).trim(),
    model: (model as string).trim(),
    effort: (effort as string | undefined)?.trim(),
  };
};

/** A provider a launch of the Star's project can start now: enabled there, installed, signed in and not failing its check. */
const serves = (provider: ServerProvider, enabledForProject: ReadonlySet<string>) =>
  enabledForProject.has(provider.instanceId) &&
  provider.enabled &&
  isProviderAvailable(provider) &&
  provider.installed &&
  provider.auth.status !== "unauthenticated" &&
  provider.status !== "error" &&
  provider.status !== "disabled";

/** The selection `choice` is on this environment, with fresh options: its effort or none; a problem where it cannot be served. */
const serve = (
  field: string,
  choice: Choice,
  providers: ReadonlyArray<ServerProvider>,
  enabledForProject: ReadonlySet<string>,
): ModelSelection | string => {
  const provider = providers.find((candidate) => candidate.instanceId === choice.provider);
  if (provider === undefined || !serves(provider, enabledForProject)) {
    const served = providers
      .filter((candidate) => serves(candidate, enabledForProject))
      .map((candidate) => candidate.instanceId);
    return `\`${field}.provider\` "${choice.provider}" is ${provider === undefined ? "not a provider" : "not served"} here; this environment serves ${served.length === 0 ? "none" : quoted(served)}`;
  }

  // Only an advertised model, unlike `t3_thread_launch`, which takes any slug from a provider listing none.
  const model =
    provider.models.find((candidate) => candidate.slug === choice.model) ??
    provider.models.find((candidate) =>
      candidate.aliases?.some((alias) => alias.toLowerCase() === choice.model.toLowerCase()),
    );
  if (model === undefined)
    return `\`${field}.model\` "${choice.model}" is not offered by "${provider.instanceId}" here; it offers ${provider.models.length === 0 ? "none now" : quoted(provider.models.slice(0, LISTED_MODELS).map((candidate) => candidate.slug))}${provider.models.length > LISTED_MODELS ? " and more" : ""}`;
  const slug = model.slug;
  if (choice.effort === undefined) return { instanceId: provider.instanceId, model: slug };
  const option = EFFORT_OPTION.get(provider.driver);
  if (option === undefined)
    return `\`${field}.effort\` "${choice.effort}" cannot be set for "${provider.instanceId}", whose driver takes no effort through this file; omit it`;
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === option,
  );
  const offered =
    descriptor?.type === "select" ? descriptor.options.map((choice) => choice.id) : [];
  if (!offered.includes(choice.effort))
    return `\`${field}.effort\` "${choice.effort}" is not offered for "${slug}" here; it offers ${offered.length === 0 ? "none, so omit it" : quoted(offered)}`;
  return {
    instanceId: provider.instanceId,
    model: slug,
    options: [{ id: option, value: choice.effort }],
  };
};

/**
 * What the file's text says for `channel` on this environment, and every problem with it: the
 * file is read whole, so a notice tells all of it at once, while only the entries on the
 * channel's way fall back.
 */
const resolve = (
  text: string,
  channel: Channel,
  providers: ReadonlyArray<ServerProvider>,
  enabledForProject: ReadonlySet<string>,
  runtimeMode: RuntimeMode,
): {
  readonly selection: ModelSelection | null;
  readonly from: ChannelModel["from"];
  readonly problems: ReadonlyArray<string>;
} => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      selection: null,
      from: "history",
      problems: [`it is not JSON (${error instanceof Error ? error.message : String(error)})`],
    };
  }
  if (!isRecord(parsed))
    return { selection: null, from: "history", problems: ["it is not a JSON object"] };
  const problems: string[] = [];
  const unknown = Object.keys(parsed).filter((key) => key !== "default" && key !== "channels");
  if (unknown.length > 0)
    problems.push(`it has ${quoted(unknown)}, which is neither \`default\` nor \`channels\``);
  const servedAt = (field: string, value: unknown): ModelSelection | null => {
    const choice = readChoice(field, value);
    const selection =
      typeof choice === "string" ? choice : serve(field, choice, providers, enabledForProject);
    if (typeof selection !== "string") return selection;
    problems.push(selection);
    return null;
  };

  const fallback =
    parsed.default === undefined
      ? (problems.push("it has no `default`, which a present file needs"), null)
      : servedAt("default", parsed.default);
  const channels = parsed.channels === undefined ? {} : parsed.channels;
  let entry: ModelSelection | null = null;
  if (!isRecord(channels)) problems.push("`channels` is not an object of channel slugs");
  else
    for (const [slug, value] of Object.entries(channels)) {
      if (!isChannel(slug)) {
        problems.push(`\`channels\` has "${slug}", which is no channel's slug`);
        continue;
      }
      const selection = servedAt(`channels.${slug}`, value);
      if (slug === channel) entry = selection;
    }
  // The wake's runtime mode, unlike the rest, is checked only on its own way: another channel may wake at another.
  const atMode = (field: string, selection: ModelSelection | null) => {
    // As the server's runtime policy reads it: no list offers every mode.
    const modes = providers.find(
      (candidate) => candidate.instanceId === selection?.instanceId,
    )?.supportedRuntimeModes;
    if (selection === null || modes === undefined || modes.length === 0) return selection;
    if (modes.includes(runtimeMode)) return selection;
    problems.push(
      `\`${field}.provider\` "${selection.instanceId}" does not offer runtime mode "${runtimeMode}", which the Star wakes "${channel}" at; it offers ${quoted(modes)}`,
    );
    return null;
  };
  // An unlisted channel takes the default, and so does one whose entry cannot be served.
  if (atMode(`channels.${channel}`, entry) !== null)
    return { selection: entry, from: "channel", problems };
  if (atMode("default", fallback) !== null)
    return { selection: fallback, from: "default", problems };
  return { selection: null, from: "history", problems };
};

/**
 * The model a fresh conversation of `channel` starts with at `runtimeMode`, from the Star's folder:
 * the channel's entry, else the file's `default`, else null for the newest conversation's. A missing
 * file is no problem; one that cannot be read otherwise fails, for the wake to fall back on.
 */
export const channelModel = Effect.fn("Stars.channelModel")(function* (
  star: { readonly root: string; readonly projectId: ProjectId },
  channel: Channel,
  runtimeMode: RuntimeMode,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const text = yield* fs
    .readFileString(path.join(star.root, CHANNEL_MODELS_FILE))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  if (text === undefined)
    return { selection: null, from: "history", broken: null } satisfies ChannelModel;
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const enabledForProject = new Set<string>();
  for (const provider of providers)
    if (
      yield* threads.isProviderInstanceEnabledForProject({
        projectId: star.projectId,
        instanceId: provider.instanceId,
      })
    )
      enabledForProject.add(provider.instanceId);
  const { selection, from, problems } = resolve(
    text,
    channel,
    providers,
    enabledForProject,
    runtimeMode,
  );
  const broken =
    problems.length === 0
      ? null
      : {
          hash: yield* (yield* Digest.Digest).digestHex(
            Digest.sha256,
            new TextEncoder().encode(text),
          ),
          problems,
        };
  return { selection, from, broken } satisfies ChannelModel;
});

/** `channelModel` for a wake, which the file never stops: one that cannot be read is logged, and is no choice, null. */
export const wakeChannelModel = (
  star: { readonly id: string; readonly root: string; readonly projectId: ProjectId },
  channel: Channel,
  runtimeMode: RuntimeMode,
) =>
  channelModel(star, channel, runtimeMode).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.as(
        Effect.logWarning("Could not read a Star's channel models; it wakes as before.", {
          starId: star.id,
          cause,
        }),
        null,
      ),
    ),
  );
