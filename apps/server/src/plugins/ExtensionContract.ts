// @effect-diagnostics anyUnknownInErrorContext:off -- an extension types its own tools; here each is a Tool.Any.
/**
 * The extension contract's calls (`contract.ts`), implemented over the server's own path:
 * `tools.register` declares each tool through `McpToolAccess` and registers it with
 * `toolkitRegistration`, so upstream's checks run for an extension's calls unchanged.
 */
import { OrchestratorMcpFailure, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- read for the names it already has; registration goes through toolkitRegistration.
import { McpSchema, McpServer, type Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { fencingLinkOrigin } from "../mcp/linkOrigin.ts";
import { loadCaller } from "../mcp/threadAccess.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ExtensionHost, Thread, ToolCaller, ToolHandler } from "./contract.ts";
import type { ExtensionUi } from "./ExtensionUi.ts";

const unreachable = (value: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
};

const iso = (at: DateTime.Utc | null) => (at === null ? null : DateTime.formatIso(at));

const threadOf = (shell: OrchestrationV2ThreadShell): Thread => ({
  id: shell.id,
  projectId: shell.projectId,
  worktreePath: shell.worktreePath,
  settledAt: iso(shell.settledAt),
  archivedAt: iso(shell.archivedAt),
  deletedAt: iso(shell.deletedAt),
});

/** The calling thread as data; both access rules have already required a thread. */
const callerOf = Effect.gen(function* () {
  const loaded = yield* loadCaller();
  const shell = loaded.caller;
  if (shell === undefined)
    return yield* Effect.die(new Error("unreachable: a call with no thread"));
  const project = yield* (yield* ProjectService.ProjectService)
    .getShell(shell.projectId)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  return {
    thread: threadOf(shell),
    folder:
      shell.worktreePath ??
      Option.getOrNull(Option.map(project, (each) => each.workspaceRoot as string)),
    fenced: fencingLinkOrigin(loaded) !== undefined,
  } satisfies ToolCaller;
});

const register = Effect.fn("ExtensionContract.register")(function* (
  name: string,
  context: Context.Context<McpServer.McpServer>,
  declared: Readonly<Record<string, Tool.Any>>,
  handlers: Readonly<Record<string, ToolHandler<Tool.Any> | undefined>>,
) {
  const tools: Array<Tool.Any> = [];
  const declarations: Record<string, unknown> = {};
  for (const tool of Object.values(declared)) {
    // An extension never replaces a built-in tool, or another extension's, by name.
    if (!tool.name.startsWith(`${name}_`))
      return yield* Effect.die(
        new Error(`Extension "${name}" registers "${tool.name}", which is not named ${name}_*.`),
      );
    // Nor one the server already has: `foo` and `foo_bar` may both name `foo_bar_x`.
    if (
      Context.get(context, McpServer.McpServer).tools.some((each) => each.tool.name === tool.name)
    )
      return yield* Effect.die(
        new Error(`Extension "${name}" registers "${tool.name}", which the server already has.`),
      );
    const handler = handlers[tool.name];
    if (handler === undefined)
      return yield* Effect.die(new Error(`Extension "${name}" has no handler for "${tool.name}".`));
    const handle = (params: unknown) =>
      Effect.flatMap(callerOf, (caller) => handler.handle(params, caller));
    declarations[tool.name] =
      handler.access === "acts-as-caller"
        ? McpToolAccess.actsAsCaller(handle)
        : handler.access === "reads-as-caller"
          ? McpToolAccess.readsAsCaller(handle)
          : unreachable(handler.access);
    tools.push(
      tool
        .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
        .setFailure(Schema.Union([tool.failureSchema, OrchestratorMcpFailure])),
    );
  }
  const checked = Toolkit.make(...tools);
  yield* Layer.build(
    toolkitRegistration(checked, McpToolAccess.toLayer(checked, declarations as never)),
  ).pipe(Effect.provide(context));
});

/** The host an extension named `name` gets; its calls run with the server's `context`. */
export const make = (
  name: string,
  dataDir: string,
  context: Context.Context<McpServer.McpServer>,
  ui: ExtensionUi["Service"],
): ExtensionHost => ({
  name,
  dataDir,
  tools: {
    register: (toolkit, handlers) =>
      register(
        name,
        context,
        toolkit.tools,
        handlers as Readonly<Record<string, ToolHandler<Tool.Any>>>,
      ),
  },
  ui: {
    publish: (slot, items) => ui.publish(name, slot, items),
    onAction: (handle) => ui.onAction(name, handle),
    onSend: (handle) => ui.onSend(name, handle),
  },
});
