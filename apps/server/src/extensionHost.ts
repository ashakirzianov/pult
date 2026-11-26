/**
 * `@pult/extension-host`, the bundle entry `dist/extensionHost.mjs`: the contract and the Effect
 * namespaces extensions use, grown on first use; no server module and neither MCP module, so an
 * extension cannot name a server service. `PluginLoader.test.ts` pins its export names.
 */
export * from "./plugins/contract.ts";
export * as Effect from "effect/Effect";
export * as FileSystem from "effect/FileSystem";
export * as Path from "effect/Path";
export * as Schema from "effect/Schema";
export { Tool, Toolkit } from "effect/ai";
