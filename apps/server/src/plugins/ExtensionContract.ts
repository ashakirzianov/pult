// @effect-diagnostics anyUnknownInErrorContext:off -- an extension types its own tools; here each is a Tool.Any.
/**
 * The extension contract's calls (`contract.ts`), implemented over the server's own path:
 * `tools.register` declares each tool through `McpToolAccess` and registers it with
 * `toolkitRegistration`, so upstream's checks run for an extension's calls unchanged.
 */
import {
  CommandId,
  MessageHeader,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  withMessageHeader,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- read for the names it already has; registration goes through toolkitRegistration.
import { McpSchema, McpServer, type Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { fencingLinkOrigin } from "../mcp/linkOrigin.ts";
import { loadCaller } from "../mcp/threadAccess.ts";
import * as DispatchModeLimit from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  type ExtensionHost,
  HostCallError,
  type Project,
  type Thread,
  type ThreadEvent,
  type ThreadMessage,
  type ToolCaller,
  type ToolHandler,
} from "./contract.ts";
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

/** The services the contract's calls use, resolved once by the loader, so a missing one fails at startup. */
export interface Services {
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly projects: ProjectService.ProjectService["Service"];
  readonly ui: ExtensionUi["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
}

const failedAs =
  (call: string) =>
  (error: { readonly message: string }): HostCallError =>
    new HostCallError({ call, message: error.message });

const decodeHeader = Schema.decodeUnknownEffect(MessageHeader);
const isHostCallError = Schema.is(HostCallError);

const send = Effect.fn("ExtensionContract.send")(function* (
  name: string,
  threads: Services["threads"],
  message: ThreadMessage,
) {
  const failed = (text: string) => new HostCallError({ call: "threads.send", message: text });
  if (message.key === "") return yield* failed("the key is empty");
  const header =
    message.header === undefined
      ? undefined
      : yield* decodeHeader({ extension: name, ...message.header }).pipe(
          Effect.mapError((error) => failed(`the header does not decode: ${error.message}`)),
        );
  const shell = yield* threads.getThreadShell(ThreadId.make(message.threadId));
  if (shell === null) return yield* failed(`there is no thread "${message.threadId}"`);
  const id = `${name}:${message.key}`;
  if (yield* threads.hasReceipt(CommandId.make(id))) return;
  const base = {
    projectId: shell.projectId,
    threadId: shell.id,
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    mode: "queue" as const,
  };
  if ("text" in message) {
    yield* threads
      .sendToThread({
        ...base,
        text: message.text,
        attachments: [],
        ...(header === undefined ? {} : { context: withMessageHeader(undefined, header) }),
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.provideService(DispatchModeLimit.DispatchModeLimit, undefined));
    return;
  }
  const { composed } = message;
  if (composed.runtimeMode !== null || composed.interactionMode !== null)
    return yield* Effect.die(
      new Error("todo: a handled message's runtime or interaction mode, which a send cannot apply"),
    );
  const context =
    header === undefined ? composed.context : withMessageHeader(composed.context, header);
  // Through the intake, which claims the uploaded attachments into the thread.
  yield* ThreadMessageIntake.sendToThread({
    ...base,
    text: composed.text,
    attachments: composed.attachments,
    ...(context === undefined ? {} : { context }),
    ...(composed.model === null ? {} : { modelSelection: composed.model }),
    createdBy: "user",
    creationSource: "web",
  }).pipe(Effect.provideService(DispatchModeLimit.DispatchModeLimit, undefined));
});

const THREAD_EVENTS = {
  "thread.settled": "settled",
  "thread.unsettled": "unsettled",
  "thread.archived": "archived",
  "thread.deleted": "deleted",
} as const;

const projectOf = (project: {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly archivedAt?: string | null | undefined;
}): Project => ({
  id: project.id,
  workspaceRoot: project.workspaceRoot,
  archivedAt: project.archivedAt ?? null,
});

/** The host an extension named `name` gets; its calls run with the server's `context`. */
export const make = (
  name: string,
  dataDir: string,
  context: Context.Context<McpServer.McpServer>,
  { threads, projects, ui, random }: Services,
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
  threads: {
    get: (id) =>
      threads.getThreadShell(ThreadId.make(id)).pipe(
        Effect.map((shell) => (shell === null ? null : threadOf(shell))),
        Effect.mapError(failedAs("threads.get")),
      ),
    send: (message) =>
      send(name, threads, message).pipe(
        // The intake's services: the loader's context is the server's whole one.
        Effect.provide(
          context as unknown as Context.Context<Effect.Services<ReturnType<typeof send>>>,
        ),
        Effect.catchIf(
          (error) => !isHostCallError(error),
          (error) => Effect.fail(failedAs("threads.send")(error)),
        ),
      ),
  },
  threadEvents: threads.streamDomainEvents.pipe(
    Stream.filter((event) => Object.hasOwn(THREAD_EVENTS, event.type)),
    Stream.map((event): ThreadEvent => ({
      _tag: THREAD_EVENTS[event.type as keyof typeof THREAD_EVENTS],
      threadId: event.threadId,
    })),
    // Upstream's own stream fails only as the server stops; an extension's subscriber ends with it.
    Stream.catchCause(() => Stream.empty),
  ),
  projects: {
    list: () =>
      projects.listShells().pipe(
        Effect.map((shells) => shells.map(projectOf)),
        Effect.mapError(failedAs("projects.list")),
      ),
    create: Effect.fn("ExtensionContract.createProject")(
      function* ({ title, workspaceRoot }) {
        const newId = random.uuidV4();
        return yield* projects.create({
          commandId: CommandId.make(yield* newId),
          projectId: ProjectId.make(yield* newId),
          title,
          workspaceRoot,
        });
      },
      Effect.map(projectOf),
      Effect.mapError(failedAs("projects.create")),
    ),
  },
  ui: {
    publish: (slot, items) => ui.publish(name, slot, items),
    onAction: (handle) => ui.onAction(name, handle),
    onSend: (handle) => ui.onSend(name, handle),
  },
});
