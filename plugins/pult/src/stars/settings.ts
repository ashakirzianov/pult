// A Star's channel settings (xaxis `pult/decisions`, `star-channel-settings`): a shared file and one per
// channel, flat `key: value` lines read strictly, the channel's winning key by key. The model falls
// back from the merged choice to the shared file's to the newest conversation's; what was wrong comes
// back with the files' hash, for a notice once per content.
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
import type { Channel } from "./channels.ts";
import { CHANNELS_DIRECTORY, entry } from "./record.ts";
import type { RotateOnContext } from "./sleep.ts";

/** Every channel's settings, beneath each channel's own. */
export const SHARED_SETTINGS_FILE = `${CHANNELS_DIRECTORY}/settings.yaml`;

/** One channel's settings, which win over the shared file's key by key. */
export const settingsFile = (channel: Channel) => `${CHANNELS_DIRECTORY}/${channel}/settings.yaml`;

/** When a conversation ends for its size where no file says, or a file says what Pult cannot read. */
const DEFAULT_ROTATE_ON_CONTEXT = 250_000;

const KEYS: ReadonlySet<string> = new Set(["provider", "model", "effort", "rotate-on-context"]);

/** The option each driver takes effort as; a driver not here takes a model alone. */
const EFFORT_OPTION: ReadonlyMap<ProviderDriverKind, string> = new Map([
  ["claudeAgent" as ProviderDriverKind, "effort"],
  ["codex" as ProviderDriverKind, "reasoningEffort"],
]);

/** How many of an environment's models a problem lists. */
const LISTED_MODELS = 12;

export interface ChannelModel {
  /** The selection a fresh conversation of the channel starts with; null for the newest conversation's. */
  readonly selection: ModelSelection | null;
  /** Where it came from: the merged settings, the shared file's alone, or neither. */
  readonly from: "settings" | "shared" | "history";
  /** What is wrong with the files on this environment; null where nothing is or there is no file. */
  readonly broken: BrokenFile | null;
}

export interface BrokenFile {
  /** The files' content as SHA-256 hex, so the Star is told once per content. */
  readonly hash: string;
  /** One sentence each, naming the key, its file, its value and what this environment accepts. */
  readonly problems: ReadonlyArray<string>;
}

/** A key's value and the file it was read from. */
interface Field {
  readonly value: string;
  readonly file: string;
}

type Fields = ReadonlyMap<string, Field>;

interface Choice {
  readonly provider: Field;
  readonly model: Field;
  readonly effort: Field | undefined;
}

/** Both files as read: each one present with its text, the shared file's fields, the merge, and what is wrong with them. */
interface SettingsRead {
  readonly texts: ReadonlyArray<{ readonly file: string; readonly text: string }>;
  readonly shared: Fields;
  readonly merged: Fields;
  readonly rotateOnContext: RotateOnContext;
  readonly problems: ReadonlyArray<string>;
}

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `"${value}"`).join(", ");

const at = (key: string, field: Field) => `\`${key}\` in \`${field.file}\``;

/** A file's fields, its lines read strictly: blank lines and `#` comments aside, each a known key once. */
const parseFile = (file: string, text: string, problems: string[]): Map<string, Field> => {
  const fields = new Map<string, Field>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const parsed = entry(line);
    if (parsed === undefined) {
      problems.push(`\`${file}\`'s line "${line}" is not \`key: value\``);
      continue;
    }
    if (!KEYS.has(parsed.key)) {
      problems.push(
        `\`${file}\` has \`${parsed.key}\`, which is none of \`provider\`, \`model\`, \`effort\` and \`rotate-on-context\``,
      );
      continue;
    }
    if (fields.has(parsed.key)) {
      problems.push(`\`${file}\` gives \`${parsed.key}\` twice`);
      continue;
    }
    fields.set(parsed.key, { value: parsed.value, file });
  }
  return fields;
};

/** `250k` as tokens, or `never`; a problem, and the default, for anything else. */
const parseRotate = (field: Field | undefined, problems: string[]): RotateOnContext => {
  if (field === undefined) return DEFAULT_ROTATE_ON_CONTEXT;
  if (field.value === "never") return "never";
  const thousands = /^([1-9][0-9]{0,5})k$/u.exec(field.value)?.[1];
  if (thousands !== undefined) return Number(thousands) * 1000;
  problems.push(
    `${at("rotate-on-context", field)} "${field.value}" is neither thousands of tokens written with a \`k\`, as \`250k\`, nor \`never\`; Pult reads it as \`250k\``,
  );
  return DEFAULT_ROTATE_ON_CONTEXT;
};

/** The two files of `channel` in the Star's folder, read and merged; a missing file is none, one that cannot be read fails. */
const readSettings = Effect.fn("Stars.readSettings")(function* (root: string, channel: Channel) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) =>
    fs.readFileString(path.join(root, file)).pipe(
      Effect.map((text) => ({ file, text })),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    );
  const shared = yield* read(SHARED_SETTINGS_FILE);
  const own = yield* read(settingsFile(channel));
  const problems: string[] = [];
  const sharedFields =
    shared === undefined ? new Map<string, Field>() : parseFile(shared.file, shared.text, problems);
  const ownFields =
    own === undefined ? new Map<string, Field>() : parseFile(own.file, own.text, problems);
  const merged = new Map([...sharedFields, ...ownFields]);
  const rotateOnContext = parseRotate(merged.get("rotate-on-context"), problems);
  return {
    texts: [shared, own].filter((each) => each !== undefined),
    shared: sharedFields,
    merged,
    rotateOnContext,
    problems,
  } satisfies SettingsRead;
});

/** The choice the fields name, none where they name no model, a problem where they name half of one. */
const choiceOf = (fields: Fields): Choice | string | undefined => {
  const provider = fields.get("provider");
  const model = fields.get("model");
  const effort = fields.get("effort");
  if (provider === undefined && model === undefined)
    return effort === undefined
      ? undefined
      : `${at("effort", effort)} names no model: give \`provider\` and \`model\` with it, or remove it`;
  if (provider === undefined || model === undefined) {
    const [given, missing] = provider === undefined ? ["model", "provider"] : ["provider", "model"];
    return `${at(given, (provider ?? model)!)} has no \`${missing}\` in either file; the two go together`;
  }
  for (const [key, field] of [
    ["provider", provider],
    ["model", model],
  ] as const)
    if (field.value === "") return `${at(key, field)} is empty`;
  if (effort?.value === "")
    return `${at("effort", effort)} is empty; omit it for the model's default`;
  return { provider, model, effort };
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

/** The selection `choice` is on this environment at `runtimeMode`, with fresh options: its effort or none; a problem where it cannot be served. */
const serve = (
  choice: Choice,
  channel: Channel,
  providers: ReadonlyArray<ServerProvider>,
  enabledForProject: ReadonlySet<string>,
  runtimeMode: RuntimeMode,
): ModelSelection | string => {
  const provider = providers.find((candidate) => candidate.instanceId === choice.provider.value);
  if (provider === undefined || !serves(provider, enabledForProject)) {
    const served = providers
      .filter((candidate) => serves(candidate, enabledForProject))
      .map((candidate) => candidate.instanceId);
    return `${at("provider", choice.provider)} "${choice.provider.value}" is ${provider === undefined ? "not a provider" : "not served"} here; this environment serves ${served.length === 0 ? "none" : quoted(served)}`;
  }
  // As the server's runtime policy reads it: no list offers every mode.
  const modes = provider.supportedRuntimeModes;
  if (modes !== undefined && modes.length > 0 && !modes.includes(runtimeMode))
    return `${at("provider", choice.provider)} "${provider.instanceId}" does not offer runtime mode "${runtimeMode}", which the Star wakes "${channel}" at; it offers ${quoted(modes)}`;

  // Only an advertised model, unlike `t3_thread_launch`, which takes any slug from a provider listing none.
  const wanted = choice.model.value;
  const model =
    provider.models.find((candidate) => candidate.slug === wanted) ??
    provider.models.find((candidate) =>
      candidate.aliases?.some((alias) => alias.toLowerCase() === wanted.toLowerCase()),
    );
  if (model === undefined)
    return `${at("model", choice.model)} "${wanted}" is not offered by "${provider.instanceId}" here; it offers ${provider.models.length === 0 ? "none now" : quoted(provider.models.slice(0, LISTED_MODELS).map((candidate) => candidate.slug))}${provider.models.length > LISTED_MODELS ? " and more" : ""}`;
  const slug = model.slug;
  const effort = choice.effort;
  if (effort === undefined) return { instanceId: provider.instanceId, model: slug };
  const option = EFFORT_OPTION.get(provider.driver);
  if (option === undefined)
    return `${at("effort", effort)} "${effort.value}" cannot be set for "${provider.instanceId}", whose driver takes no effort through these files; omit it`;
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === option,
  );
  const offered = descriptor?.type === "select" ? descriptor.options.map((each) => each.id) : [];
  if (!offered.includes(effort.value))
    return `${at("effort", effort)} "${effort.value}" is not offered for "${slug}" here; it offers ${offered.length === 0 ? "none, so omit it" : quoted(offered)}`;
  return {
    instanceId: provider.instanceId,
    model: slug,
    options: [{ id: option, value: effort.value }],
  };
};

/** When the channel's conversations end for their size, for every look; files that cannot be read are logged, and are `250k`. */
export const rotateOnContext = (
  star: { readonly id: string; readonly root: string },
  channel: Channel,
) =>
  readSettings(star.root, channel).pipe(
    Effect.map((read): RotateOnContext => read.rotateOnContext),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.as(
        Effect.logWarning("Could not read a Star's channel settings; it rotates at 250k.", {
          starId: star.id,
          channel,
          cause,
        }),
        DEFAULT_ROTATE_ON_CONTEXT,
      ),
    ),
  );

/**
 * The model a fresh conversation of `channel` starts with at `runtimeMode`, from the Star's folder:
 * the merged choice, else the shared file's own, else null for the newest conversation's; with every
 * problem of both files on the wake's way. A file that cannot be read fails, for the wake to fall back on.
 */
export const channelModel = Effect.fn("Stars.channelModel")(function* (
  star: { readonly root: string; readonly projectId: ProjectId },
  channel: Channel,
  runtimeMode: RuntimeMode,
) {
  const read = yield* readSettings(star.root, channel);
  if (read.texts.length === 0)
    return { selection: null, from: "history", broken: null } satisfies ChannelModel;
  const threads = yield* ThreadManagementService.ThreadManagementService;
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
  const problems = [...read.problems];
  const served = (fields: Fields): ModelSelection | null => {
    const choice = choiceOf(fields);
    if (choice === undefined) return null;
    const selection =
      typeof choice === "string"
        ? choice
        : serve(choice, channel, providers, enabledForProject, runtimeMode);
    if (typeof selection !== "string") return selection;
    if (!problems.includes(selection)) problems.push(selection);
    return null;
  };
  // The shared file's own choice is another only where the channel's file names part of one.
  const ownChoice = ["provider", "model", "effort"].some(
    (key) => read.merged.get(key)?.file === settingsFile(channel),
  );
  const merged = served(read.merged);
  const shared = merged === null && ownChoice ? served(read.shared) : null;
  const [selection, from]: [ModelSelection | null, ChannelModel["from"]] =
    merged !== null
      ? [merged, "settings"]
      : shared !== null
        ? [shared, "shared"]
        : [null, "history"];
  const broken =
    problems.length === 0
      ? null
      : {
          hash: yield* (yield* Digest.Digest).digestHex(
            Digest.sha256,
            new TextEncoder().encode(
              read.texts.map(({ file, text }) => `${file}\n${text}`).join("\0"),
            ),
          ),
          problems,
        };
  return { selection, from, broken } satisfies ChannelModel;
});

/** `channelModel` for a wake, which the files never stop: ones that cannot be read are logged, and are no choice, null. */
export const wakeChannelModel = (
  star: { readonly id: string; readonly root: string; readonly projectId: ProjectId },
  channel: Channel,
  runtimeMode: RuntimeMode,
) =>
  channelModel(star, channel, runtimeMode).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.as(
        Effect.logWarning("Could not read a Star's channel settings; it wakes as before.", {
          starId: star.id,
          cause,
        }),
        null,
      ),
    ),
  );
