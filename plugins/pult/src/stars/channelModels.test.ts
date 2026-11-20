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
import { CHANNEL_MODELS_FILE, channelModel } from "./channelModels.ts";

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

const FABLE = { provider: "claudeAgent", model: "claude-fable-5-2", effort: "high" };
const SOL = { provider: "codex", model: "gpt-6.2-sol", effort: "low" };

/** The channel's model from a Star folder holding `file` (none where undefined), for a wake at `runtimeMode`. */
const resolveWith = (
  file: string | object | undefined,
  channel: string,
  runtimeMode: RuntimeMode = "full-access",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    if (file !== undefined) {
      yield* fs.makeDirectory(path.join(root, ".pult"));
      yield* fs.writeFileString(
        path.join(root, CHANNEL_MODELS_FILE),
        typeof file === "string" ? file : JSON.stringify(file),
      );
    }
    return yield* channelModel(
      { root, projectId: ProjectId.make("project-1") },
      channel,
      runtimeMode,
    );
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

const sha256 = (text: string) =>
  Effect.flatMap(Digest.Digest, (digest) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(text)),
  ).pipe(Effect.provide(NodeCrypto.layer));

describe("a channel's model", () => {
  it.effect("is today's, the newest conversation's, without a file", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveWith(undefined, "work"), {
        selection: null,
        from: "history",
        broken: null,
      });
    }),
  );

  it.effect("is the channel's entry, else the default, effort as each driver takes it", () =>
    Effect.gen(function* () {
      const file = {
        default: FABLE,
        channels: {
          captures: SOL,
          release: { provider: "claudeAgent", model: "opus" },
          editor: { provider: "cursor", model: "composer" },
        },
      };
      assert.deepStrictEqual(yield* resolveWith(file, "captures"), {
        selection: {
          instanceId: "codex" as ProviderInstanceId,
          model: "gpt-6.2-sol",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        from: "channel",
        broken: null,
      });
      // An alias is the model's slug; no effort is the model's own default, no options carried.
      assert.deepStrictEqual((yield* resolveWith(file, "release")).selection, {
        instanceId: "claudeAgent" as ProviderInstanceId,
        model: "claude-opus-5-5",
      });
      // A driver with no effort mapping takes a model alone.
      assert.deepStrictEqual((yield* resolveWith(file, "editor")).selection, {
        instanceId: "cursor" as ProviderInstanceId,
        model: "composer",
      });
      // `user` and `work` are channels like any other: unlisted, they take the default.
      for (const channel of ["user", "work"])
        assert.deepStrictEqual(yield* resolveWith(file, channel), {
          selection: {
            instanceId: "claudeAgent" as ProviderInstanceId,
            model: "claude-fable-5-2",
            options: [{ id: "effort", value: "high" }],
          },
          from: "default",
          broken: null,
        });
    }),
  );

  it.effect(
    "falls back from an entry this environment cannot serve, every problem told with the content's hash",
    () =>
      Effect.gen(function* () {
        const bad = {
          unknownProvider: { provider: "gemini", model: "x" },
          disabled: { provider: "codex-disabled", model: "gpt-6.2-sol" },
          failing: { provider: "codex-failing", model: "gpt-6.2-sol" },
          offForProject: { provider: "codex-off", model: "gpt-6.2-sol" },
          emptyCatalog: { provider: "codex-empty", model: "gpt-6.2-sol" },
          narrowModes: { provider: "codex-narrow", model: "gpt-6.2-sol" },
          unknownModel: { provider: "codex", model: "gpt-9" },
          unknownEffort: { provider: "codex", model: "gpt-6.2-sol", effort: "max" },
          effortNotMapped: { provider: "cursor", model: "composer", effort: "high" },
          shape: { provider: "codex", model: "gpt-6.2-sol", reasoningEffort: "low" },
          notObject: "gpt-6.2-sol",
        };
        for (const [kind, choice] of Object.entries(bad)) {
          // The channel's entry falls to the default.
          const text = JSON.stringify({ default: FABLE, channels: { unit: choice } });
          const toDefault = yield* resolveWith(text, "unit");
          assert.strictEqual(toDefault.from, "default", kind);
          assert.strictEqual(toDefault.selection?.model, "claude-fable-5-2", kind);
          assert.strictEqual(toDefault.broken?.hash, yield* sha256(text), kind);
          assert.strictEqual(toDefault.broken?.problems.length, 1, kind);
          assert.match(toDefault.broken!.problems[0]!, /^`channels\.unit/u, kind);
          // A broken entry is told on another channel's wake too, which still takes its own.
          const other = yield* resolveWith(
            { default: FABLE, channels: { unit: choice, captures: SOL } },
            "captures",
          );
          assert.strictEqual(other.from, "channel", kind);
          assert.strictEqual(other.broken?.problems.length, 1, kind);
          // The default falls to today's.
          const toHistory = yield* resolveWith({ default: choice }, "work");
          assert.deepStrictEqual(
            { selection: toHistory.selection, from: toHistory.from },
            { selection: null, from: "history" },
            kind,
          );
          assert.match(toHistory.broken!.problems[0]!, /^`default/u, kind);
        }
        // A provider offering only the wake's runtime mode serves it.
        assert.strictEqual(
          (yield* resolveWith({ default: bad.narrowModes }, "work", "approval-required")).from,
          "default",
        );
        // What it names and what this environment accepts.
        const told = yield* resolveWith(
          {
            default: FABLE,
            channels: { a: bad.unknownProvider, b: bad.unknownModel, c: bad.unknownEffort },
          },
          "work",
        );
        assert.deepStrictEqual(told.broken?.problems, [
          '`channels.a.provider` "gemini" is not a provider here; this environment serves "claudeAgent", "codex", "cursor", "codex-empty", "codex-narrow"',
          '`channels.b.model` "gpt-9" is not offered by "codex" here; it offers "gpt-6.2-sol"',
          '`channels.c.effort` "max" is not offered for "gpt-6.2-sol" here; it offers "low", "medium", "xhigh"',
        ]);
      }),
  );

  it.effect("is today's for every channel where the file does not parse or has no default", () =>
    Effect.gen(function* () {
      for (const text of ['{"default": {"provider": "codex",', "[]", "{}"]) {
        for (const channel of ["user", "captures"]) {
          const resolved = yield* resolveWith(text, channel);
          assert.deepStrictEqual(
            { selection: resolved.selection, from: resolved.from },
            { selection: null, from: "history" },
            text,
          );
          assert.strictEqual(resolved.broken?.hash, yield* sha256(text), text);
        }
      }
      // A file with no default still serves its listed channels.
      const listedOnly = yield* resolveWith({ channels: { captures: SOL } }, "captures");
      assert.strictEqual(listedOnly.from, "channel");
      assert.deepStrictEqual(listedOnly.broken?.problems, [
        "it has no `default`, which a present file needs",
      ]);
      // Keys it does not know and slugs that are no channel's are told, the rest served.
      const strays = yield* resolveWith(
        { default: FABLE, prefixes: {}, channels: { "Unit-2": SOL } },
        "work",
      );
      assert.strictEqual(strays.from, "default");
      assert.deepStrictEqual(strays.broken?.problems, [
        'it has "prefixes", which is neither `default` nor `channels`',
        '`channels` has "Unit-2", which is no channel\'s slug',
      ]);
      const nullChannels = yield* resolveWith({ default: FABLE, channels: null }, "work");
      assert.strictEqual(nullChannels.from, "default");
      assert.deepStrictEqual(nullChannels.broken?.problems, [
        "`channels` is not an object of channel slugs",
      ]);
    }),
  );
});
