/**
 * The extension contract, version 1: everything an extension can name. Only data crosses it, never
 * a server service, a `Context` or an MCP module; an addition does not bump `CONTRACT` (xaxis
 * `pult/decisions`, `extension-contract`; docs/internals/plugins.md).
 */
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

/** The contract number this server serves; an extension's `extension.json` names the one it was built against. */
export const CONTRACT = 1;

/** `<home>/plugins/<name>/extension.json`, beside `main.mjs`, read before any of the extension's code runs. */
export const Manifest = Schema.Struct({
  /** The extension's own version, listed and never interpreted. */
  version: Schema.String,
  contract: Schema.Number,
  /** The Effect version the extension compiled against, `x.y.z`. */
  effect: Schema.String,
});
export type Manifest = typeof Manifest.Type;

/** A thread as data; times are ISO strings. */
export const Thread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
});
export type Thread = typeof Thread.Type;

/** Who calls a tool: always a thread, since no extension tool is offered to an outside client. */
export const ToolCaller = Schema.Struct({
  thread: Thread,
  /** The thread's worktree, else its project's root; null when the project is gone. */
  folder: Schema.NullOr(Schema.String),
  /** Whether work a fenced link started made the call. */
  fenced: Schema.Boolean,
});
export type ToolCaller = typeof ToolCaller.Type;

/** Upstream's two rules for a tool acting as, or reading as, its calling thread. */
export const ToolAccess = Schema.Literals(["acts-as-caller", "reads-as-caller"]);
export type ToolAccess = typeof ToolAccess.Type;

export interface ToolHandler<T extends Tool.Any> {
  readonly access: ToolAccess;
  readonly handle: (
    params: Tool.Parameters<T>,
    caller: ToolCaller,
  ) => Effect.Effect<Tool.Success<T>, Tool.Failure<T>>;
}

export type ToolHandlers<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]: ToolHandler<Tools[Name]>;
};

/** What `activate` gets. */
export interface ExtensionHost {
  readonly name: string;
  /** `<stateDir>/plugins/<name>/`, made before `activate`. */
  readonly dataDir: string;
  readonly tools: {
    /**
     * Registers a toolkit of tools declared with no `dependencies`, each named `<name>_*`, on the
     * server's MCP server, for the activation's scope. Every tool is offered to threads and never
     * to an outside client.
     */
    readonly register: <Tools extends Record<string, Tool.Any>>(
      toolkit: Toolkit.Toolkit<Tools>,
      handlers: ToolHandlers<Tools>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
}

/** What an activation may use besides its host: its scope, and the files of the server's disk. */
export type ExtensionServices = Scope.Scope | FileSystem.FileSystem | Path.Path;

/** `main.mjs` exports `activate`; anything but an Effect from it fails the load. */
export type Activate = (host: ExtensionHost) => Effect.Effect<unknown, unknown, ExtensionServices>;
