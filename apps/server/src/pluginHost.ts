/**
 * What an in-process plugin may import. This file is a second bundle entry,
 * `dist/pluginHost.mjs`, that shares its chunks with `dist/bin.mjs`, so a
 * plugin built with `@t3code/plugin-host` external gets the server's own
 * module instances. See docs/internals/plugins.md.
 */
export * as Cause from "effect/Cause";
export * as Context from "effect/Context";
// The Pult plugin's schedules: a file that is no schedule is told to its Star once per content, keyed by its hash.
export * as Digest from "effect/crypto/Digest";
// The Pult plugin's Stars: the sleep rule and the transcripts read the records' times.
export * as DateTime from "effect/DateTime";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
// The Pult plugin's Stars: their folders, records and transcripts.
export * as FileSystem from "effect/FileSystem";
export * as Fiber from "effect/Fiber";
export * as Layer from "effect/Layer";
export * as Option from "effect/Option";
// The Pult plugin's Stars: their folders, records and transcripts.
export * as Path from "effect/Path";
export * as Result from "effect/Result";
export * as Schema from "effect/Schema";
export * as Scope from "effect/Scope";
// The Pult plugin's Stars: a lock per server for creation and upkeep, and one per Star.
export * as Semaphore from "effect/Semaphore";
// The Pult plugin's Stars: ids for new Stars, their projects and commands.
export * as SecureRandom from "effect/crypto/SecureRandom";
export * as Stream from "effect/Stream";
export { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
// A plugin declares its tools as the built-in toolkits declare theirs, with Tool and Toolkit,
// McpToolAccess and toolkitRegistration below, so upstream's access checks run for them too.
// McpServer stays for the loader's context and for an installed plugin built on addTool, whose
// tools skip those checks (docs/internals/plugins.md).
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the plugin surface re-exports it.
export { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

export * as ServerConfig from "./config.ts";
// The Pult plugin's Star messages: a thread sender's limits, checked again under the target's lock.
export * as DispatchModeLimit from "./orchestration-v2/DispatchModeLimit.ts";
export * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
// The Pult plugin's Star messages: work a fenced link started never messages a Star, whose threads carry no link.
export * as McpLinkOrigin from "./mcp/linkOrigin.ts";
export * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
// The Pult plugin's Star messages: pult_star_message is declared through the server's access wrapper.
export * as McpToolAccess from "./mcp/McpToolAccess.ts";
export { toolkitRegistration } from "./mcp/McpHttpServer.ts";
// The Pult plugin's Star messages: upstream's rule that a thread's target be no broader than it.
export * as McpThreadAccess from "./mcp/threadAccess.ts";
export * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
// The Pult plugin's Stars: projects found, created, adopted and titled.
export * as ProjectService from "./project/ProjectService.ts";
// The Pult plugin's Stars: the pass that puts conversations to sleep, once a minute.
export * as Scheduler from "./scheduling/Scheduler.ts";
// The Pult plugin's Stars: the transcripts' folder and label.
export * as ServerEnvironment from "./environment/ServerEnvironment.ts";
// The Pult plugin's Star messages: a delivery waits for startup recovery before it sends or wakes.
export * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
// The Pult plugin's Star messages: a wake launches a Star's fresh conversation.
export * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
export * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
// The Pult plugin's schedules: the watch of the Stars directory says when a Star's schedules changed.
export * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
export type { PluginHost, PluginRouteHandler } from "./plugins/PluginLoader.ts";

import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_COMMIT__: string | undefined;

/**
 * The server build a plugin was built against. A plugin's build script writes
 * the same shape to its `builtFor` export; the loader refuses a plugin built
 * for another version, or another commit when both sides know theirs.
 */
export interface ServerBuild {
  readonly version: string;
  readonly commit: string | undefined;
}

export const serverBuild: ServerBuild = {
  version: packageJson.version,
  commit: typeof __T3CODE_BUILD_COMMIT__ === "string" ? __T3CODE_BUILD_COMMIT__ : undefined,
};

/**
 * Proof that a plugin shares this module graph. A plugin re-exports this as
 * `identity`; one that bundled its own Effect would otherwise resolve the
 * host's services silently and run on a second runtime.
 */
export const hostIdentity: { readonly host: "@t3code/plugin-host" } = Object.freeze({
  host: "@t3code/plugin-host",
});
export const identity = hostIdentity;
