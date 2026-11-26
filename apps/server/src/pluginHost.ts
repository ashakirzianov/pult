/**
 * The raw tier: the server modules Pult's bundled plugin imports, by path through its `src/host.ts`,
 * for what of it has not moved onto the extension contract. Never an extension's (`../extensionHost.ts`).
 * See docs/internals/plugins.md.
 */
export * as Cause from "effect/Cause";
// The Pult plugin's install-at-rest: the desktop's opt-in, `T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST`.
export * as Config from "effect/Config";
export * as Context from "effect/Context";
// The Pult plugin's schedules: a file that is no schedule is told to its Star once per content, keyed by its hash.
export * as Digest from "effect/crypto/Digest";
// The Pult plugin's Stars: the sleep rule and the transcripts read the records' times.
export * as DateTime from "effect/DateTime";
// The Pult plugin's kept xaxis checkout: the automatic-fetch interval it moves at.
export * as Duration from "effect/Duration";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
// The Pult plugin's Stars: their folders, records and transcripts.
export * as FileSystem from "effect/FileSystem";
export * as Fiber from "effect/Fiber";
export * as Layer from "effect/Layer";
export * as Option from "effect/Option";
// The Pult plugin's Stars: their folders, records and transcripts.
export * as Path from "effect/Path";
// The Pult plugin's install-at-rest: the last reason it logged, so a quiet night logs it once.
export * as Ref from "effect/Ref";
export * as Schema from "effect/Schema";
// The Pult plugin's Stars: a lock per server for creation and upkeep, and one per Star.
export * as Semaphore from "effect/Semaphore";
// The Pult plugin's Stars: ids for new Stars, their projects and commands.
export * as SecureRandom from "effect/crypto/SecureRandom";
export * as Stream from "effect/Stream";
export { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
// A plugin declares its tools as the built-in toolkits declare theirs, with Tool and Toolkit,
// McpToolAccess and toolkitRegistration below, so upstream's access checks run for them too.
// McpServer stays for the loader's context.
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the plugin surface re-exports it.
export { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

export * as ServerConfig from "./config.ts";
// The Pult plugin's install-at-rest: the desktop app's update it runs and commits, merged out of the
// server's runtime dependencies for the plugins.
export * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
// The Pult plugin's install-at-rest: a fresh host sample, and the desktop's update state.
export * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
// The Pult plugin's install-at-rest: the host's idle time, merged out of the server's runtime
// dependencies for the plugins.
export * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
// The Pult plugin's Stars: the user's home, against which the live install's Stars directory is refused to other homes.
export * as HostProcess from "@t3tools/shared/HostProcess";
// The Pult plugin's Star messages: a thread sender's limits, checked again under the target's lock.
// The user's message into a thread or a Star's wake, its uploads claimed, which reads a text upload with `DocumentText` (`plugins/pult/src/stars/deliver.ts`).
export * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
export * as DocumentText from "./provider/DocumentText.ts";
export * as DispatchModeLimit from "./orchestration-v2/DispatchModeLimit.ts";
export * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
// The Pult plugin's Star messages: work a fenced link started never messages a Star, whose threads carry no link.
export * as McpLinkOrigin from "./mcp/linkOrigin.ts";
// The Pult plugin's Star messages: pult_star_message is declared through the server's access wrapper.
export * as McpToolAccess from "./mcp/McpToolAccess.ts";
export { toolkitRegistration } from "./mcp/McpHttpServer.ts";
// The Pult plugin's Star messages: upstream's rule that a thread's target be no broader than it.
export * as McpThreadAccess from "./mcp/threadAccess.ts";
// The Pult plugin's settle reactions: a settled or archived thread's previews close, and the
// listening servers its agent started stop.
export * as PortScanner from "./preview/PortScanner.ts";
export * as PreviewManager from "./preview/Manager.ts";
// The Pult plugin's schedules: a watcher's command, run in its Star's folder.
export * as ProcessRunner from "./processRunner.ts";
// The Pult plugin's Stars: projects found, created, adopted and titled.
export * as ProjectService from "./project/ProjectService.ts";
// The Pult plugin's usage limits: pult_usage_limits reads this server's providers and hub sources.
export * as ProviderRegistry from "./provider/ProviderRegistry.ts";
// The Pult plugin's Stars: the pass that puts conversations to sleep, once a minute.
export * as Scheduler from "./scheduling/Scheduler.ts";
// The Pult plugin's install-at-rest: it installs once the server has been at rest long enough.
export * as ServerActivity from "./serverActivity.ts";
// The Pult plugin's install-at-rest: the user's `autoUpdateDesktopApp`; its settle reactions: a project's settle script.
export * as ServerSettings from "./serverSettings.ts";
// The Pult plugin's Stars: the transcripts' folder and label.
export * as ServerEnvironment from "./environment/ServerEnvironment.ts";
// The Pult plugin's Star messages: a delivery waits for startup recovery before it sends or wakes.
export * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
// The Pult plugin's Star messages: a wake launches a Star's fresh conversation.
export * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
// The Pult plugin's Stars: one open conversation per channel, a launch into one that has it refused.
export * as ThreadLaunchGuard from "./orchestration-v2/ThreadLaunchGuard.ts";
export * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
// The Pult plugin's usage limits: pult_usage_limits reads this server's providers and hub sources.
export * as UsageLimitSources from "./usage/UsageLimitSources.ts";
// The Pult plugin's kept xaxis checkout: the interval it moves at.
export * as VcsAutomaticFetchInterval from "./vcs/VcsAutomaticFetchInterval.ts";
// The Pult plugin's kept xaxis checkout: the status it refreshes after a move.
export * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
// The Pult plugin's kept xaxis checkout: the CLI's registry, Get latest, and a refusal's code.
export * as XaxisCli from "./vcs/XaxisCli.ts";
export * as XaxisVcsDriver from "./vcs/XaxisVcsDriver.ts";
// The Pult plugin's schedules: the watch of the Stars directory says when a Star's schedules changed.
export * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
export type { PluginHost, PluginRouteHandler } from "./plugins/PluginLoader.ts";
