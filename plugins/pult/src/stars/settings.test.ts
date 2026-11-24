import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  Digest,
  Effect,
  FileSystem,
  Layer,
  Path,
  ProviderRegistry,
  ThreadManagementService,
} from "../host.ts";
import { channelModel, rotateOnContext, SHARED_SETTINGS_FILE, settingsFile } from "./settings.ts";

const effortModel = (slug: string, option: string, values: ReadonlyArray<string>) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: option,
        label: "Effort",
        type: "select" as const,
        options: values.map((id) => ({ id, label: id })),
      },
    ],
  },
});

const provider = (
  instanceId: string,
  driver: string,
  models: ServerProvider["models"],
  status: ServerProvider["status"] = "ready",
): ServerProvider => ({
  instanceId: instanceId as ProviderInstanceId,
  driver: driver as ProviderDriverKind,
  enabled: status !== "disabled",
  installed: true,
  version: "test",
  status,
  auth: { status: "authenticated" },
  checkedAt: "2026-11-20T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

const SOL_MODEL = effortModel("gpt-6.2-sol", "reasoningEffort", ["low", "medium", "xhigh"]);

/**
 * Claude and Codex as the server offers them, a Cursor that takes no effort here, and Codex
 * instances that offer the model yet cannot serve it: disabled, failing its check, off for the
 * Star's project, one listing no models, and one offering only the narrowest runtime mode.
 */
const PROVIDERS: ReadonlyArray<ServerProvider> = [
  provider("claudeAgent", "claudeAgent", [
    effortModel("claude-fable-5-2", "effort", ["low", "medium", "high"]),
    { ...effortModel("claude-opus-5-5", "effort", ["high", "max"]), aliases: ["opus"] },
  ]),
  provider("codex", "codex", [SOL_MODEL]),
  provider("cursor", "cursor", [
    { slug: "composer", name: "composer", isCustom: false, capabilities: null },
  ]),
  provider("codex-disabled", "codex", [SOL_MODEL], "disabled"),
  provider("codex-failing", "codex", [SOL_MODEL], "error"),
  provider("codex-off", "codex", [SOL_MODEL]),
  provider("codex-empty", "codex", []),
  {
    ...provider("codex-narrow", "codex", [SOL_MODEL]),
    supportedRuntimeModes: ["approval-required"],
  },
];

/** The instances settings turn off for the Star's project. */
const OFF_FOR_PROJECT: ReadonlySet<string> = new Set(["codex-off"]);

const FABLE = "provider: claudeAgent\nmodel: claude-fable-5-2\neffort: high\n";
const SOL = "provider: codex\nmodel: gpt-6.2-sol\neffort: low\n";

/** The files of a Star folder: the shared one and each channel's, by slug; none where undefined. */
interface Files {
  readonly shared?: string;
  readonly channels?: Readonly<Record<string, string>>;
}

/** A Star folder holding `files`, and what `read` makes of it. */
const inFolder = <A, E, R>(files: Files, read: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const write = (file: string, text: string) =>
      Effect.andThen(
        fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true }),
        () => fs.writeFileString(path.join(root, file), text),
      );
    if (files.shared !== undefined) yield* write(SHARED_SETTINGS_FILE, files.shared);
    for (const [channel, text] of Object.entries(files.channels ?? {}))
      yield* write(settingsFile(channel), text);
    return yield* read(root);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(PROVIDERS) }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          isProviderInstanceEnabledForProject: ({ projectId, instanceId }) =>
            Effect.succeed(projectId === "project-1" && !OFF_FOR_PROJECT.has(instanceId)),
        }),
      ),
    ),
  );

/** The channel's model from a Star folder holding `files`, for a wake at `runtimeMode`. */
const resolveWith = (files: Files, channel: string, runtimeMode: RuntimeMode = "full-access") =>
  inFolder(files, (root) =>
    channelModel({ root, projectId: ProjectId.make("project-1") }, channel, runtimeMode),
  );

const sha256 = (text: string) =>
  Effect.flatMap(Digest.Digest, (digest) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(text)),
  ).pipe(Effect.provide(NodeCrypto.layer));

const selection = (instanceId: string, model: string, effort?: [string, string]) => ({
  instanceId: instanceId as ProviderInstanceId,
  model,
  ...(effort === undefined ? {} : { options: [{ id: effort[0], value: effort[1] }] }),
});

describe("a channel's model", () => {
  it.effect("is the newest conversation's without a file", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveWith({}, "work"), {
        selection: null,
        from: "history",
        broken: null,
      });
      // A file that chooses no model is no choice, and nothing wrong.
      assert.deepStrictEqual(
        yield* resolveWith({ channels: { main: "rotate-on-context: never\n" } }, "main"),
        { selection: null, from: "history", broken: null },
      );
    }),
  );

  it.effect(
    "is the channel's file over the shared one key by key, effort as each driver takes it",
    () =>
      Effect.gen(function* () {
        const files = {
          shared: FABLE,
          channels: {
            captures: SOL,
            // Its model over the shared provider and effort.
            main: "model: claude-opus-5-5\n",
            release:
              "# Opus at the model's own effort.\nprovider: claudeAgent\nmodel: opus\neffort:\n",
            editor: "provider: cursor\nmodel: composer\n",
          },
        };
        assert.deepStrictEqual(yield* resolveWith(files, "captures"), {
          selection: selection("codex", "gpt-6.2-sol", ["reasoningEffort", "low"]),
          from: "settings",
          broken: null,
        });
        assert.deepStrictEqual(
          (yield* resolveWith(files, "main")).selection,
          selection("claudeAgent", "claude-opus-5-5", ["effort", "high"]),
        );
        // An empty effort is a problem; the shared file's own choice serves.
        const release = yield* resolveWith(files, "release");
        assert.strictEqual(release.from, "shared");
        assert.deepStrictEqual(release.broken?.problems, [
          "`effort` in `.pult/channels/release/settings.yaml` is empty; omit it for the model's default",
        ]);
        // A driver with no effort mapping takes a model alone.
        const editor = yield* resolveWith({ channels: files.channels }, "editor");
        assert.deepStrictEqual(editor.selection, selection("cursor", "composer"));
        // An unlisted channel takes the shared file; an alias is the model's slug.
        assert.deepStrictEqual(yield* resolveWith(files, "unit-2"), {
          selection: selection("claudeAgent", "claude-fable-5-2", ["effort", "high"]),
          from: "settings",
          broken: null,
        });
        assert.deepStrictEqual(
          (yield* resolveWith({ shared: "provider: claudeAgent\nmodel: opus\n" }, "unit-2"))
            .selection,
          selection("claudeAgent", "claude-opus-5-5"),
        );
      }),
  );

  it.effect(
    "falls back from a choice this environment cannot serve, every problem told with the files' hash",
    () =>
      Effect.gen(function* () {
        const bad = {
          unknownProvider: "provider: gemini\nmodel: x\n",
          disabled: "provider: codex-disabled\nmodel: gpt-6.2-sol\n",
          failing: "provider: codex-failing\nmodel: gpt-6.2-sol\n",
          offForProject: "provider: codex-off\nmodel: gpt-6.2-sol\n",
          emptyCatalog: "provider: codex-empty\nmodel: gpt-6.2-sol\n",
          narrowMode: "provider: codex-narrow\nmodel: gpt-6.2-sol\n",
          unknownModel: "provider: codex\nmodel: gpt-9\n",
          unknownEffort: "provider: codex\nmodel: gpt-6.2-sol\neffort: max\n",
          effortNotMapped: "provider: cursor\nmodel: composer\neffort: high\n",
          effortAlone: "effort: max\n",
        };
        for (const [kind, text] of Object.entries(bad)) {
          // The channel's file falls to the shared file's own choice.
          const toShared = yield* resolveWith({ shared: FABLE, channels: { unit: text } }, "unit");
          assert.strictEqual(toShared.from, "shared", kind);
          assert.strictEqual(toShared.selection?.model, "claude-fable-5-2", kind);
          assert.strictEqual(
            toShared.broken?.hash,
            yield* sha256(`${SHARED_SETTINGS_FILE}\n${FABLE}\0${settingsFile("unit")}\n${text}`),
            kind,
          );
          assert.strictEqual(toShared.broken?.problems.length, 1, kind);
          assert.include(toShared.broken!.problems[0]!, "in `.pult/channels/", kind);
          // Another channel's wake tells nothing of it.
          const other = yield* resolveWith({ shared: FABLE, channels: { unit: text } }, "captures");
          assert.deepStrictEqual([other.from, other.broken], ["settings", null], kind);
          // The shared file falls to the newest conversation's.
          const toHistory = yield* resolveWith({ shared: text }, "work");
          assert.deepStrictEqual(
            { selection: toHistory.selection, from: toHistory.from },
            { selection: null, from: "history" },
            kind,
          );
          assert.include(toHistory.broken!.problems[0]!, "in `.pult/channels/settings.yaml`", kind);
        }
        // What it names and what this environment accepts.
        const told = (text: string) =>
          Effect.map(
            resolveWith({ channels: { unit: text } }, "unit"),
            (model) => model.broken?.problems,
          );
        assert.deepStrictEqual(yield* told(bad.unknownProvider), [
          '`provider` in `.pult/channels/unit/settings.yaml` "gemini" is not a provider here; this environment serves "claudeAgent", "codex", "cursor", "codex-empty", "codex-narrow"',
        ]);
        assert.deepStrictEqual(yield* told(bad.unknownModel), [
          '`model` in `.pult/channels/unit/settings.yaml` "gpt-9" is not offered by "codex" here; it offers "gpt-6.2-sol"',
        ]);
        assert.deepStrictEqual(yield* told(bad.unknownEffort), [
          '`effort` in `.pult/channels/unit/settings.yaml` "max" is not offered for "gpt-6.2-sol" here; it offers "low", "medium", "xhigh"',
        ]);
        assert.deepStrictEqual(yield* told(bad.narrowMode), [
          '`provider` in `.pult/channels/unit/settings.yaml` "codex-narrow" does not offer runtime mode "full-access", which the Star wakes "unit" at; it offers "approval-required"',
        ]);
        assert.deepStrictEqual(
          (yield* resolveWith({ channels: { unit: bad.narrowMode } }, "unit", "approval-required"))
            .from,
          "settings",
        );
        // Half a choice after the merge is none.
        assert.deepStrictEqual(yield* told("provider: codex\n"), [
          "`provider` in `.pult/channels/unit/settings.yaml` has no `model` in either file; the two go together",
        ]);
      }),
  );

  it.effect("reads its files strictly, telling every problem at once and serving the rest", () =>
    Effect.gen(function* () {
      const strays = yield* resolveWith(
        {
          shared: `${FABLE}prefixes: [a]\nnot a line\n`,
          channels: {
            unit: "model: claude-opus-5-5\nmodel: claude-fable-5-2\nrotate-on-context: 250000\n",
          },
        },
        "unit",
      );
      assert.strictEqual(strays.selection?.model, "claude-opus-5-5");
      assert.deepStrictEqual(strays.broken?.problems, [
        "`.pult/channels/settings.yaml` has `prefixes`, which is none of `provider`, `model`, `effort` and `rotate-on-context`",
        '`.pult/channels/settings.yaml`\'s line "not a line" is not `key: value`',
        "`.pult/channels/unit/settings.yaml` gives `model` twice",
        '`rotate-on-context` in `.pult/channels/unit/settings.yaml` "250000" is neither thousands of tokens written with a `k`, as `250k`, nor `never`; Pult reads it as `250k`',
      ]);
    }),
  );
});

describe("a channel's rotate-on-context", () => {
  const rotation = (files: Files, channel: string) =>
    inFolder(files, (root) => rotateOnContext({ id: "star-1", root }, channel));

  it.effect(
    "is the channel's file over the shared one, 250k where none says or Pult cannot read it",
    () =>
      Effect.gen(function* () {
        const files = {
          shared: "rotate-on-context: 120k\n",
          channels: { main: "rotate-on-context: never\n", unit: "rotate-on-context: 1M\n" },
        };
        assert.strictEqual(yield* rotation(files, "main"), "never");
        assert.strictEqual(yield* rotation(files, "work"), 120_000);
        assert.strictEqual(yield* rotation(files, "unit"), 250_000);
        assert.strictEqual(yield* rotation({}, "work"), 250_000);
        assert.strictEqual(yield* rotation({ shared: "rotate-on-context: 0k\n" }, "work"), 250_000);
      }),
  );
});
