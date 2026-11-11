# Plugins

A plugin is code the server imports into its own process and runs with its own services: fully trusted, no manifest, no capabilities, no consent, and no UI. The decisions behind that shape are in the Plugins area of xaxis `pult/decisions`. The loader is [`PluginLoader.ts`](../../apps/server/src/plugins/PluginLoader.ts), the HTTP surface [`plugins/http.ts`](../../apps/server/src/plugins/http.ts), and the sample [`examples/plugins/hello`](../../examples/plugins/hello/main.mjs).

## Bundled plugins

A plugin that must change in step with the server ships inside it. [`bundled.ts`](../../apps/server/src/plugins/bundled.ts) lists them by name, each a dynamic import of a workspace package that exports only `activate` (Pult's is `plugins/pult`), and the pack inlines them into the server's bundle. At startup the loader activates each through the same activation an installed build gets, listed as build `bundled`; it skips the identity and build checks, which one module graph and one commit make true by construction. An activation that fails lists the plugin as `failed`, and the server runs on. A bundled plugin is not reloadable (`reload` answers `409`), and `<home>/plugins/<name>` under its name is ignored. A bundled plugin imports the server's modules by relative path to `src/pluginHost.ts`, so it needs no resolve hook, and `apps/server`'s typecheck follows that import into it: an upstream merge that breaks what the plugin uses fails there.

## Layout of an installed plugin

```
<home>/plugins/<name>/
  builds/<build-id>/main.mjs
  current -> builds/<build-id>
```

`<home>` is the server's base directory (`--base-dir`, `T3CODE_HOME`). At startup the loader imports each plugin's `current` build; a `current` pointing at a build that is not there lists the plugin as `failed` with the build-not-found error and does not stop startup. Names and build ids are single path segments (`[A-Za-z0-9][A-Za-z0-9._-]*`).

## What a plugin exports

- `identity`, re-exported from `@t3code/plugin-host`.
- `builtFor`, the `ServerBuild` (`{ version, commit }`) it was built against.
- `activate(host)`, returning an Effect or a promise. The Effect runs with the server's whole context provided and a `Scope` the loader owns; register tools with `yield* McpServer.McpServer` then `addTool`, serve `/api/plugins/<name>/<path>` with `host.serve`, and clean up with `Effect.addFinalizer`. A promise that resolves to a function gets that function as its finalizer. Activation should register and return; long work forks into the scope. Nothing in the plugin's memory survives a reload.

A tool a plugin adds is replaced by name on every activation and never removed within a run, so register tools last: a build that fails after `addTool` has already replaced the handler. A tool handler that throws reaches the agent as an RPC defect and the server survives, so a plugin fails its tools with a result (`isError`), not a throw. A plugin declares its tools as the built-in toolkits declare theirs: a `Toolkit` of `Tool`s, handlers built with `McpToolAccess.toLayer` from its declarations (`writesThreads`, `startsThreads` and the rest), registered by building `toolkitRegistration(toolkit, handlers)` with `Layer.build` in the activation's scope. The build shares the server's layer memo, so the toolkit lands on the server's own `McpServer`, and upstream's checks run for its calls as for a built-in tool's (the Pult plugin's `pult_star_message` is the first). A tool registered with `addTool` instead, as the sample does, skips those checks and reads `McpInvocationContext` itself. For Claude, plugin tools are pre-approved in non-read-only sandboxes (`mcp__t3-code__*`) and absent from the read-only allow-list.

The route `host.serve` registers takes effect only when the build is swapped in, so a build that serves and then fails leaves the running build's route in place.

## Building against the host

[`src/pluginHost.ts`](../../apps/server/src/pluginHost.ts) is a second entry of the server bundle, `dist/pluginHost.mjs`, sharing chunks with `dist/bin.mjs`. A plugin imports it as `@t3code/plugin-host`; the loader maps that bare specifier to the entry with a `module.registerHooks` resolve hook. A plugin build marks that specifier external and bundles everything else; `examples/plugins/hello/build.mjs` is the reference (`pnpm build <build-id>` in that folder). The bundle inlines Effect into hashed chunks, so the entry is the only stable address for the server's modules; it exports the Effect namespaces, the MCP modules with the access wrapper (`McpToolAccess`, its thread helpers as `McpThreadAccess`, `toolkitRegistration`, `Tool` and `Toolkit`), `ServerConfig`, the shared `HostProcess` (the user's home), the orchestration service tags with `ThreadLaunchService` and `DispatchModeLimit`, `ServerRuntimeStartup`, `ProjectService`, `ServerEnvironment`, the server's `Scheduler` (merged out of the orchestration runtime for plugins), `WorkspaceEntries` with its watch, Effect's `Digest`, `serverBuild`, and `identity`.

## The two refusals

Both happen before `activate`, so the running build is untouched.

- **Identity.** `module.identity !== hostIdentity`. A plugin that bundled its own Effect still resolves the host's services through its own `Context` and runs them on a second runtime; the spike showed this failing silently, which is why the check is by object identity.
- **Build.** `builtFor.version` must equal the server's, and the commits must match when both are known. The commit is baked into the bundle at pack time (`__T3CODE_BUILD_COMMIT__`); a server run from source has none and is matched on version alone.

## Reload

Nothing watches the filesystem. `POST /api/plugins/<name>/reload` with `{ "build": "<build-id>" }` (scope `access:write`) imports the build from a fresh URL (so the same id re-imports), runs `activate`, and on success points `current` at it and closes the previous build's scope; the repoint and the swap run uninterruptibly, as one step. On failure it answers `409` with the error and its cause, and the previous build keeps running; `404` is an unknown plugin or build. A `current` that cannot be written is a failure too (`PluginCurrentLinkError`): the new build is closed again rather than left running where the next startup would not find it. `GET /api/plugins` (scope `orchestration:read`) lists `{ name, build, status, error, loadedAt }`, where `build` is the running build, `status` is `loaded`, `failed` (the last attempt failed; `build` may still be running) or `none`, and `error` describes the last failure. Plugin routes under `/api/plugins/<name>/` need `orchestration:read` for `GET` and `HEAD` and `access:write` for any other method; the handler receives the session's scopes to gate further.
