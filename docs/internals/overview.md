# Architecture

Pult is a client. Execution stays in the environment that owns the workspace: a running T3 Code Extensible server, which Pult's web client (`apps/pult`) and Electron shell (`apps/pult-desktop`) control over authenticated RPC. A client must never substitute its own filesystem, provider credentials, or machine state for the environment's. Pult bundles no server; the desktop attaches to one (`DECISIONS.md`, `no-local-server`).

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and domain state belongs in the vendored `client-runtime` (`vendor/t3code/packages/client-runtime`); Pult's client supplies platform services and UI. See [connection runtime](./connection-runtime.md) and [remote environments](./remote.md).

The [RPC contract](../../vendor/t3code/packages/contracts/src/rpc.ts) is the boundary between Pult and independently versioned servers. Subscriptions send the state a client needs, so a client viewing one thread does not pay for every thread's history. Authentication of a socket does not authorize every method on it: every RPC declares a required scope, which the server checks before any handler runs.

### Pull request linking compatibility

Servers upgrade independently of Pult. Negotiate linking through the environment descriptor, never through a server version or an assumed coordinated release: the multi-link surfaces (the pull requests panel, the command palette's linked pull requests) appear only when `capabilities.threadPullRequests` is true, and the client accepts snapshots that omit `pullRequests`.

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay on their owning server. The web and desktop settings target is URL state, resolved against current connections and project membership. An unavailable target must not fall back to another environment. **All environments** is an explicit bulk edit of connected, loaded servers, not a durable global default or a promise to synchronize offline or future environments. Project-group targets similarly select known environment-local checkouts; the group itself does not store inherited defaults.

## What the server's state means

The server's event log is the source of truth for orchestration state. A command acknowledgement means the intent committed, not that the provider, checkpoint, or other follow-up work finished. A provider turn ending and its follow-up work settling are separate milestones: a late checkpoint or diff must not keep the client showing provider work as active. Thread settlement is server-owned; the client renders the persisted result and does not derive settlement from its own clocks or PR caches.

## Electron shell

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity` is too late: Chromium caches the first registration, including failures. The identity must match the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's `Exec` path before portal registration: AppImage updates can remove the previous executable, which makes the old entry invalid even though its filename is correct. The later URL handler avoids rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous shortcut-registration result only confirms submission; it does not confirm desktop consent or an active binding.

Native modules never load in the Electron main process on the startup path, and the two the snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children (`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out to `osascript` instead of a native addon. A crash or stall in any of these must not take the app down, so new native capability goes in a child with a deadline, not an `import` in main.

See the glossary in [AGENTS.md](../../AGENTS.md) for shared terms and the [development runbook](../operations/development.md) for setup and checks.
