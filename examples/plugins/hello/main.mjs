/**
 * The reference extension: one tool, `hello_whoami`, answering with its calling thread and that
 * thread's folder. `pnpm build` bundles it into `dist/hello/` beside its `extension.json`; copy
 * that folder to `<home>/plugins/hello/` and restart the server. See docs/internals/plugins.md.
 */
import { Effect, Schema, Tool, Toolkit } from "@pult/extension-host";

const Whoami = Tool.make("hello_whoami", {
  description: "Answers with the thread that called it and that thread's folder.",
  // No `parameters`: Tool.make's default, Tool.EmptyParams, advertises an empty object.
  success: Schema.Struct({ threadId: Schema.String, folder: Schema.NullOr(Schema.String) }),
});

export const activate = (host) =>
  Effect.gen(function* () {
    yield* host.tools.register(Toolkit.make(Whoami), {
      hello_whoami: {
        access: "reads-as-caller",
        handle: (_params, caller) =>
          Effect.succeed({ threadId: caller.thread.id, folder: caller.folder }),
      },
    });
    yield* Effect.addFinalizer(() => Effect.logInfo("hello extension closed"));
    yield* Effect.logInfo("hello extension loaded", { dataDir: host.dataDir });
  });
