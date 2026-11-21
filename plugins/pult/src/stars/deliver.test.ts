import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import { DateTime, DispatchModeLimit, Effect, Exit, FileSystem, Layer, Path } from "../host.ts";
import { CHANNEL_MODELS_FILE } from "./channelModels.ts";
import { type Channel, channelTag } from "./channels.ts";
import * as Delivery from "./deliver.ts";
import * as Stars from "./stars.ts";
import { at, fakeServer, run } from "./testing.ts";

const worker = ThreadId.make("worker");
const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;
const work = { tags: [channelTag("work")] } satisfies Partial<OrchestrationV2ThreadShell>;
const model = (name: string) => ({ instanceId: ProviderInstanceId.make("codex"), model: name });

/** A provider the server serves, its models taking `option` as effort among `low` and `high`. */
const provider = (
  instanceId: string,
  option: string,
  slugs: ReadonlyArray<string>,
  supportedRuntimeModes?: ServerProvider["supportedRuntimeModes"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: instanceId as ProviderDriverKind,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-10T12:00:00.000Z",
  models: slugs.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: option,
          label: "Effort",
          type: "select" as const,
          options: ["low", "high"].map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
  ...(supportedRuntimeModes === undefined ? {} : { supportedRuntimeModes }),
  slashCommands: [],
  skills: [],
});
const PROVIDERS = [
  provider("claudeAgent", "effort", ["claude-fable-5-2", "claude-opus-5-5"]),
  provider("codex", "reasoningEffort", ["gpt-6.2-sol"]),
  // Offers only the narrowest runtime mode, so no wake at `auto`.
  {
    ...provider("codex", "reasoningEffort", ["gpt-6.2-sol"], ["approval-required"]),
    instanceId: ProviderInstanceId.make("codex-narrow"),
  },
];
const FABLE = { provider: "claudeAgent", model: "claude-fable-5-2", effort: "high" };
const SOL = { provider: "codex", model: "gpt-6.2-sol", effort: "low" };
/** The selection a choice of the file launches at. */
const selected = (choice: { provider: string; model: string; effort: string }) => ({
  instanceId: ProviderInstanceId.make(choice.provider),
  model: choice.model,
  options: [
    { id: choice.provider === "codex" ? "reasoningEffort" : "effort", value: choice.effort },
  ],
});

/** One Star over a fake server, and `deliver` as the plugin builds it. */
const harness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
  const server = yield* fakeServer;
  const stars = yield* Stars.make.pipe(Effect.provide(server.layer));
  const { deliver, pageWakeModel } = (yield* Delivery.make.pipe(Effect.provide(server.layer)))(
    stars,
  );
  const star = yield* stars.create({ ifNone: true });
  server.limits.providers = PROVIDERS;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /** Writes the Star's channel models, JSON or text as given. */
  const choose = (file: string | object) =>
    Effect.flatMap(
      fs.makeDirectory(path.dirname(path.join(star.root, CHANNEL_MODELS_FILE)), {
        recursive: true,
      }),
      () =>
        fs.writeFileString(
          path.join(star.root, CHANNEL_MODELS_FILE),
          typeof file === "string" ? file : JSON.stringify(file),
        ),
    );
  /** A conversation that ended an hour ago; `user`'s unless `shell` tags it. */
  const ended = (id = "ended", shell: Partial<OrchestrationV2ThreadShell> = {}) =>
    server.threads.add(star.projectId, id, {
      createdAt: at("2026-11-10T11:00:00.000Z"),
      settledOverride: "settled",
      settledAt: at("2026-11-10T12:00:00.000Z"),
      runtimeMode: "auto",
      interactionMode: "default",
      ...shell,
    });
  /** An open conversation, its cache warm; `user`'s unless `shell` tags it. */
  const open = (
    runs = [run("open-run", "completed")],
    id = "open",
    shell: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    server.threads.add(
      star.projectId,
      id,
      {
        createdAt: at("2026-11-10T12:50:00.000Z"),
        promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z"),
        runtimeMode: "auto",
        ...shell,
      },
      runs,
    );
  const fromPlugin = (key: string, text = "Hello", to: Channel = "user") =>
    deliver({ star, text, from: 'schedule "standup"', to, key, sender: "plugin" });
  /** As a thread through `McpToolAccess.writesThreads`, which provides the caller's limits; to `work` unless it names another. */
  const fromThread = (
    key: string,
    limit: { runtimeMode: "auto" | "full-access"; interactionMode: "default" },
    to: Channel = "work",
  ) =>
    deliver({
      star,
      text: "Done.",
      from: "thread worker",
      to,
      key,
      sender: { thread: worker },
    }).pipe(Effect.provideService(DispatchModeLimit.DispatchModeLimit, limit));
  return {
    ...server,
    stars,
    star,
    deliver,
    pageWakeModel,
    ended,
    open,
    fromPlugin,
    fromThread,
    choose,
    fs,
    path,
  };
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const failureCode = <A>(exit: Exit.Exit<A, { readonly code: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.code
    : undefined;

describe("deliver", () => {
  it.effect("wakes a sleeping Star at its last conversation's model and modes, tagged", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const last = h.ended();
      const delivered = yield* h.fromPlugin("k1", "Time for the standup.");
      assert.deepStrictEqual(delivered, {
        outcome: "launched",
        threadId: ThreadId.make("launched-1"),
      });
      const [launch] = h.launches.launches;
      assert.deepStrictEqual(
        {
          projectId: launch?.projectId,
          title: launch?.title,
          generateTitle: launch?.generateTitle,
          modelSelection: launch?.modelSelection,
          runtimeMode: launch?.runtimeMode,
          interactionMode: launch?.interactionMode,
          workspaceStrategy: launch?.workspaceStrategy,
          tags: launch?.tags,
        },
        {
          projectId: h.star.projectId,
          title: "Time for the standup.",
          generateTitle: true,
          modelSelection: last.shell.modelSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          // `user`'s conversation too is launched tagged.
          tags: ["pult:channel:user"],
        },
      );
      // From the plugin: a server message, no sender thread, no ceiling.
      const [message] = h.threads.messages;
      assert.deepStrictEqual(
        {
          threadId: message?.threadId,
          text: message?.text,
          senderThreadId: message?.senderThreadId,
          createdBy: message?.createdBy,
          creationSource: message?.creationSource,
        },
        {
          threadId: ThreadId.make("launched-1"),
          text: '[From schedule "standup", to your channel user]\n\nTime for the standup.',
          senderThreadId: undefined,
          createdBy: "agent",
          creationSource: "server",
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("starts an idle conversation's turn and queues behind a running one", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      const open = h.open(undefined, "work-open", work);
      assert.deepStrictEqual(yield* h.fromThread("k1", fullAccess), {
        outcome: "started",
        threadId: open.shell.id,
      });
      assert.deepStrictEqual(yield* h.fromThread("k2", fullAccess), {
        outcome: "queued",
        threadId: open.shell.id,
      });
      assert.strictEqual(h.launches.launches.length, 0);
      // From a thread: an MCP message naming its sender, sent under the caller's limits.
      const [message] = h.threads.messages;
      assert.deepStrictEqual(
        {
          text: message?.text,
          senderThreadId: message?.senderThreadId,
          createdBy: message?.createdBy,
          creationSource: message?.creationSource,
          limit: message?.limit,
        },
        {
          text: "[From thread worker, to your channel work]\n\nDone.",
          senderThreadId: worker,
          createdBy: "agent",
          creationSource: "mcp",
          limit: fullAccess,
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "leaves the user's conversation untouched by a worker's message, whether it is idle or running",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const user = h.open();
        // Idle: the message wakes a work thread, tagged, at the user's conversation's model and modes.
        assert.deepStrictEqual(yield* h.fromThread("k1", fullAccess), {
          outcome: "launched",
          threadId: ThreadId.make("launched-1"),
        });
        const [launch] = h.launches.launches;
        assert.deepStrictEqual(
          {
            tags: launch?.tags,
            modelSelection: launch?.modelSelection,
            runtimeMode: launch?.runtimeMode,
          },
          {
            tags: ["pult:channel:work"],
            modelSelection: user.shell.modelSelection,
            runtimeMode: "auto",
          },
        );
        assert.deepStrictEqual(
          user.runs.map((each) => each.id),
          ["open-run"],
        );
        // Running: the next one queues into the work thread.
        user.runs = [{ ...run("user-run", "running"), ordinal: 1 }];
        assert.deepStrictEqual(yield* h.fromThread("k2", fullAccess), {
          outcome: "queued",
          threadId: ThreadId.make("launched-1"),
        });
        assert.strictEqual(h.launches.launches.length, 1);
        assert.deepStrictEqual(
          h.threads.messages.map((each) => each.threadId),
          [ThreadId.make("launched-1"), ThreadId.make("launched-1")],
        );
        assert.deepStrictEqual(
          user.runs.map((each) => each.id),
          ["user-run"],
        );
        assert.strictEqual(user.shell.settledOverride, null);
      }).pipe(Effect.scoped),
  );

  it.effect("wakes a work thread, never queueing into the user's running conversation", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const user = h.open([run("user-run", "running")]);
      assert.deepStrictEqual(yield* h.fromThread("k1", fullAccess), {
        outcome: "launched",
        threadId: ThreadId.make("launched-1"),
      });
      assert.deepStrictEqual(
        h.launches.launches.map((each) => each.tags),
        [["pult:channel:work"]],
      );
      assert.deepStrictEqual(
        h.threads.messages.map((each) => each.threadId),
        [ThreadId.make("launched-1")],
      );
      assert.deepStrictEqual(
        user.runs.map((each) => each.id),
        ["user-run"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "wakes a channel at its newest conversation, else at user's newest, else at the Star's newest in any channel",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        // Only a work conversation so far: a fresh channel and `user` alike take its model and modes.
        h.ended("work-ended", {
          ...work,
          runtimeMode: "full-access",
          interactionMode: "plan",
          modelSelection: model("work-model"),
        });
        yield* h.fromPlugin("k1", "To a fresh channel.", "unit-2");
        // The user's ended later; work's model and modes are still its own.
        h.ended("user-ended", {
          createdAt: at("2026-11-10T11:30:00.000Z"),
          settledAt: at("2026-11-10T12:30:00.000Z"),
          modelSelection: model("user-model"),
        });
        yield* h.fromPlugin("k2", "To work.", "work");
        // A fresh channel takes the model the user set, not whichever channel ran last.
        yield* h.fromPlugin("k3", "To another fresh channel.", "unit-3");
        assert.deepStrictEqual(
          h.launches.launches.map((each) => [
            each.modelSelection.model,
            each.runtimeMode,
            each.interactionMode,
            each.tags,
          ]),
          [
            ["work-model", "full-access", "plan", ["pult:channel:unit-2"]],
            ["work-model", "full-access", "plan", ["pult:channel:work"]],
            ["user-model", "auto", "default", ["pult:channel:unit-3"]],
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("searches a channel's newest ended conversation among the latest 100 settled", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended("work-ended", { ...work, modelSelection: model("work-model") });
      // A hundred of `user`'s settled after it, so work's newest is out of the search's reach.
      for (let index = 0; index < 100; index += 1)
        h.ended(`user-${index}`, {
          settledAt: DateTime.add(at("2026-11-10T12:10:00.000Z"), { seconds: index }),
          modelSelection: model("user-model"),
        });
      yield* h.fromPlugin("k1", "To work.", "work");
      assert.deepStrictEqual(
        h.launches.launches.map((each) => each.modelSelection.model),
        ["user-model"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("wakes one thread for two concurrent messages to a sleeping Star", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      const both = yield* Effect.all([h.fromPlugin("k1"), h.fromPlugin("k2")], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(both.map((each) => each.outcome).toSorted(), ["launched", "queued"]);
      assert.strictEqual(h.launches.launches.length, 1);
      assert.deepStrictEqual(
        both.map((each) => each.threadId),
        [ThreadId.make("launched-1"), ThreadId.make("launched-1")],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "wakes one thread of its own for two messages at once to a sleeping channel, while work is open",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.ended();
        const open = h.open(undefined, "work-open", work);
        const both = yield* Effect.all(
          [h.fromThread("k1", fullAccess, "unit-2"), h.fromThread("k2", fullAccess, "unit-2")],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(both.map((each) => each.outcome).toSorted(), ["launched", "queued"]);
        assert.deepStrictEqual(
          h.launches.launches.map((each) => each.tags),
          [["pult:channel:unit-2"]],
        );
        assert.deepStrictEqual(
          both.map((each) => each.threadId),
          [ThreadId.make("launched-1"), ThreadId.make("launched-1")],
        );
        assert.deepStrictEqual(
          open.runs.map((each) => each.id),
          ["open-run"],
        );
        assert.include(h.threads.messages[0]?.text, "to your channel unit-2]");
      }).pipe(Effect.scoped),
  );

  it.effect("delivers a key once on either path, and finishes a wake cut short", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      // The wake path, cut between the thread and its message, then finished, then replayed.
      h.launches.state.cutNext = true;
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromPlugin("wake"))),
        "orchestration_error",
      );
      assert.strictEqual(h.threads.messages.length, 0);
      assert.deepStrictEqual(yield* h.fromPlugin("wake"), {
        outcome: "launched",
        threadId: ThreadId.make("launched-1"),
      });
      assert.deepStrictEqual(yield* h.fromPlugin("wake"), {
        outcome: "replayed",
        threadId: ThreadId.make("launched-1"),
      });
      assert.strictEqual(h.threads.messages.length, 1);
      // The send path: the Star is awake now.
      assert.strictEqual((yield* h.fromPlugin("send")).outcome, "queued");
      assert.deepStrictEqual(yield* h.fromPlugin("send"), { outcome: "replayed", threadId: null });
      assert.strictEqual(h.threads.messages.length, 2);
      assert.strictEqual(h.launches.launches.length, 3);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "wakes a fresh conversation at the Star's choice for its channel, an edit taking effect at the next wake",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.ended();
        yield* h.choose({ default: FABLE, channels: { captures: SOL } });
        yield* h.fromPlugin("k1", "File these.", "captures");
        // The launch carries the selection with its first message, the modes still the newest's.
        const [launch] = h.launches.launches;
        assert.deepStrictEqual(
          {
            modelSelection: launch?.modelSelection,
            runtimeMode: launch?.runtimeMode,
            initialMessage: launch?.initialMessage?.text,
          },
          {
            modelSelection: selected(SOL),
            runtimeMode: "auto",
            initialMessage: '[From schedule "standup", to your channel captures]\n\nFile these.',
          },
        );
        // An unlisted channel takes the default.
        yield* h.fromPlugin("k2", "Hello", "unit-2");
        assert.deepStrictEqual(h.launches.launches[1]?.modelSelection, selected(FABLE));
        // An edit while the conversation is open changes nothing in it.
        const opus = { provider: "claudeAgent", model: "claude-opus-5-5", effort: "low" };
        yield* h.choose({ default: FABLE, channels: { captures: opus } });
        assert.strictEqual((yield* h.fromPlugin("k3", "More.", "captures")).outcome, "queued");
        assert.strictEqual(h.launches.launches.length, 2);
        // Asleep, the channel wakes at the edited choice.
        const captures = h.threads.byId(ThreadId.make("launched-1"))!;
        captures.shell = {
          ...captures.shell,
          settledOverride: "settled",
          settledAt: at("2026-11-10T13:00:00.000Z"),
        };
        yield* h.fromPlugin("k4", "Again.", "captures");
        assert.deepStrictEqual(h.launches.launches[2]?.modelSelection, selected(opus));
        // Nothing was wrong, so nothing was told.
        assert.isFalse(h.launches.launches.some((each) => each.tags?.includes(channelTag("work"))));
      }).pipe(Effect.scoped),
  );

  it.effect("resumes a wake cut short at the model it recorded, across an edit", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      yield* h.choose({ default: SOL });
      h.launches.state.cutNext = true;
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromPlugin("wake"))),
        "orchestration_error",
      );
      yield* h.choose({ default: FABLE });
      assert.strictEqual((yield* h.fromPlugin("wake")).outcome, "launched");
      assert.deepStrictEqual(
        h.launches.launches.map((each) => each.modelSelection),
        [selected(SOL), selected(SOL)],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "wakes on the fallback where the choice cannot be served, telling work once per content",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const last = h.ended();
        // A provider that does not offer the wake's mode, `auto`, cannot serve it.
        yield* h.choose({
          default: FABLE,
          channels: { captures: { provider: "codex-narrow", model: "gpt-6.2-sol" } },
        });
        yield* h.fromPlugin("k1", "File these.", "captures");
        yield* h.fromPlugin("k2", "Hello", "unit-2");
        assert.deepStrictEqual(
          h.launches.launches.map((each) => [each.tags, each.modelSelection]),
          [
            [["pult:channel:captures"], selected(FABLE)],
            // The notice wakes work, after the lock, on the default too; the second wake tells nothing.
            [["pult:channel:work"], selected(FABLE)],
            [["pult:channel:unit-2"], selected(FABLE)],
          ],
        );
        // Three messages: the two wakes' and the one notice.
        assert.strictEqual(h.threads.messages.length, 3);
        const notice = h.threads.messages[1];
        assert.strictEqual(notice?.threadId, ThreadId.make("launched-2"));
        assert.include(
          notice?.text,
          '`channels.captures.provider` "codex-narrow" does not offer runtime mode "auto"',
        );
        // Without the file, the channel wakes as before.
        yield* h.fs.remove(h.path.join(h.star.root, CHANNEL_MODELS_FILE));
        yield* h.fromPlugin("k3", "Hello", "unit-3");
        assert.deepStrictEqual(h.launches.launches[3]?.modelSelection, last.shell.modelSelection);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "wakes work at history where the file does not parse, the notice queued into that conversation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const last = h.ended();
        yield* h.choose('{"default": ');
        yield* h.fromThread("k1", fullAccess);
        assert.deepStrictEqual(
          h.launches.launches.map((each) => each.modelSelection),
          [last.shell.modelSelection],
        );
        assert.deepStrictEqual(
          h.threads.messages.map((each) => each.threadId),
          [ThreadId.make("launched-1"), ThreadId.make("launched-1")],
        );
        assert.include(h.threads.messages[1]?.text, "it is not JSON");
        // The notice is Pult's, under no ceiling of the thread whose wake found the file broken.
        assert.strictEqual(h.threads.messages[1]?.limit, undefined);
        // A file that cannot be read is no choice either, and tells nothing.
        yield* h.fs.remove(h.path.join(h.star.root, CHANNEL_MODELS_FILE));
        yield* h.fs.makeDirectory(h.path.join(h.star.root, CHANNEL_MODELS_FILE));
        yield* h.fromPlugin("k2", "Hello", "unit-2");
        assert.deepStrictEqual(h.launches.launches[1]?.modelSelection, last.shell.modelSelection);
        assert.strictEqual(h.threads.messages.length, 3);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "shows the page the choice for user and wakes its own launch at it, telling work once with the wakes by message",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const last = h.ended();
        const shown = Effect.map(h.stars.view, (view) => view.stars[0]?.model);
        // No file: the page keeps its own, the newest conversation's.
        assert.deepStrictEqual(yield* shown, last.shell.modelSelection);
        assert.strictEqual(yield* h.pageWakeModel(h.star, "auto", "user"), null);
        yield* h.choose({ default: FABLE, channels: { user: SOL } });
        assert.deepStrictEqual(yield* shown, selected(SOL));
        assert.deepStrictEqual(yield* h.pageWakeModel(h.star, "auto", "user"), selected(SOL));
        // Another channel's tagged draft takes its own: here the default.
        assert.deepStrictEqual(yield* h.pageWakeModel(h.star, "auto", "review"), selected(FABLE));
        // At a mode its provider does not offer, the entry falls to the default, and the page's send tells work.
        yield* h.choose({
          default: FABLE,
          channels: { user: { provider: "codex-narrow", model: "gpt-6.2-sol" } },
        });
        assert.deepStrictEqual(yield* shown, selected(FABLE));
        assert.strictEqual(h.launches.launches.length, 0, "showing the choice tells nothing");
        assert.deepStrictEqual(yield* h.pageWakeModel(h.star, "auto", "user"), selected(FABLE));
        assert.deepStrictEqual(
          h.launches.launches.map((each) => each.tags),
          [["pult:channel:work"]],
        );
        assert.include(h.threads.messages[0]?.text, '"codex-narrow" does not offer runtime mode');
        // The same content is told once, whichever wake finds it next.
        yield* h.pageWakeModel(h.star, "auto", "user");
        yield* h.fromPlugin("k1", "Hello", "unit-2");
        assert.strictEqual(h.threads.messages.length, 2);
      }).pipe(Effect.scoped),
  );

  it.effect("holds a thread to modes no broader than its own, on either path", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const narrow = { runtimeMode: "auto", interactionMode: "default" } as const;
      const last = h.ended();
      last.shell = { ...last.shell, runtimeMode: "full-access" };
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromThread("k1", narrow))),
        "runtime_mode_escalation_denied",
      );
      assert.strictEqual(h.launches.launches.length, 0);
      const open = h.open(undefined, "work-open", work);
      open.shell = { ...open.shell, runtimeMode: "full-access" };
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromThread("k2", narrow))),
        "runtime_mode_escalation_denied",
      );
      assert.strictEqual(h.threads.messages.length, 0);
      // The plugin has no ceiling.
      assert.strictEqual((yield* h.fromPlugin("k3", "Hello", "work")).outcome, "started");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails for a Star never spoken to, and dies for a thread outside the wrapper or no channel's slug",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        assert.strictEqual(failureCode(yield* Effect.exit(h.fromPlugin("k1"))), "thread_not_found");
        const died = <A, E>(exit: Exit.Exit<A, E>) =>
          Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Die";
        const outside = yield* Effect.exit(
          h.deliver({
            star: h.star,
            text: "x",
            from: "y",
            to: "work",
            key: "k2",
            sender: { thread: worker },
          }),
        );
        assert.isTrue(died(outside));
        assert.isTrue(died(yield* Effect.exit(h.fromPlugin("k3", "x", "Not a slug"))));
      }).pipe(Effect.scoped),
  );
});
