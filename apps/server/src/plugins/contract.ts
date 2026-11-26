/**
 * The extension contract, version 1: everything an extension can name. Only data crosses it, never
 * a server service, a `Context` or an MCP module; an addition does not bump `CONTRACT` (xaxis
 * `pult/decisions`, `extension-contract`; docs/internals/plugins.md).
 */
import type { ExtensionComposed, ExtensionSlot, ExtensionSlotItem } from "@t3tools/contracts";
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

/** A call of the host refused: what was called, and why. */
export class HostCallError extends Schema.TaggedError<HostCallError>()("HostCallError", {
  call: Schema.String,
  message: Schema.String,
}) {}

/** An action handler's refusal, its message shown to the user. */
export class ActionRefused extends Schema.TaggedError<ActionRefused>()("ActionRefused", {
  message: Schema.String,
}) {}

/** A send handler's refusal, its message the composer's error; the composer keeps its content. */
export class SendRefused extends Schema.TaggedError<SendRefused>()("SendRefused", {
  message: Schema.String,
}) {}

/** The slots an extension publishes into, and their items' shapes (`@t3tools/contracts`'s `extensionUi.ts`). */
export type Slot = ExtensionSlot;
export type SlotItem<S extends Slot> = ExtensionSlotItem<S>;
export type Composed = ExtensionComposed;

/** What a click on an item's action tells its extension. */
export interface UiAction {
  readonly slot: Slot;
  readonly key: string;
  readonly action: string;
  /** The action's input, ISO 8601 for an instant; undefined for an action with none. */
  readonly value: string | undefined;
}

/** What a handled composer's Send hands its extension. */
export interface UiSend {
  readonly slot: Slot;
  readonly key: string;
  readonly message: Composed;
}

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
  /**
   * The page's UI slots. What is published is state: a reconnect or a second page gets the whole
   * set, and it goes when the activation's scope closes. A handler's own publish reaches the page
   * before its answer does, so a pending item is replaced by its new state.
   */
  readonly ui: {
    /** Replaces the extension's whole list for `slot`; a malformed item or a key repeated in it fails the call. */
    readonly publish: <S extends Slot>(
      slot: S,
      items: ReadonlyArray<SlotItem<S>>,
    ) => Effect.Effect<void, HostCallError>;
    /** At `activate`, once: every action of the extension's items. */
    readonly onAction: (
      handle: (action: UiAction) => Effect.Effect<void, ActionRefused>,
    ) => Effect.Effect<void, HostCallError>;
    /** At `activate`, once: every send of a composer the extension handles, answered with the thread it landed in. */
    readonly onSend: (
      handle: (send: UiSend) => Effect.Effect<{ readonly thread: string }, SendRefused>,
    ) => Effect.Effect<void, HostCallError>;
  };
}

/** What an activation may use besides its host: its scope, and the files of the server's disk. */
export type ExtensionServices = Scope.Scope | FileSystem.FileSystem | Path.Path;

/** `main.mjs` exports `activate`; anything but an Effect from it fails the load. */
export type Activate = (host: ExtensionHost) => Effect.Effect<unknown, unknown, ExtensionServices>;
