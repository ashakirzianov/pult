# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Direction

### client-shape
**Pult's next client is a VS Code extension against stock T3 Code servers, beside the web client `apps/pult`; an own shell on VS Code's workbench, or on its editor layer below it, waits for a specific need the extension cannot meet.** 2026-10-07. The UI ideas are file editing, file citations and diff citations, which VS Code's extension API covers (a virtual filesystem, the diff editor, comments on ranges, decorations) while the server already speaks read, write, list and search; a fork would own the workbench and its monthly upstream, and Tabs IDE's experience shows that cost lands in hosting the workbench, not patching it. The proof is daily use for all development. Anton's ruling. *Rejected:* a fork of VS Code now; Monaco inside the web client; dropping the web client. *See:* `docs/pult/rfc-1.md`, `pult/vscode-extension`.

### server-side-home
**Pult's server-side needs are built in T3 Code Extensible (`~/repos/t3code-extensible`), as RPCs offered upstream when generic and as a fork plugin only when Pult-specific; this repo carries no server code.** 2026-10-07. Under RFC 1 the client is a VS Code extension against stock servers, and its first server need, filesystem RPCs for a virtual workspace, is one every third-party client wants; the fork can open pull requests upstream and runs the live host meanwhile. Anton's ruling. *Rejected:* a Pult plugin as the shape of every server-side need; a supervised server part (`pult/dynamic-server-part`); a standalone MCP server registered in each provider's own config (`pult/standalone-mcp-server`); a copy of `apps/server` kept in this repo. *See:* `pult/filesystem-rpcs`, `pult/t3code-extensible`, `docs/pult/rfc-1.md`.

## Upstream

### protocol-packages-pinned
**Pult takes the fork's protocol and connection packages (`contracts`, `client-runtime`, `shared`, `ssh`, `tailscale`) verbatim at the commit in `vendor/t3code/PIN`, together with the fork's dependency patches and its `overrides`, `packageExtensions` and `patchedDependencies` blocks, and merges nothing else from upstream or the fork; everything outside `vendor/` is Pult's own, and a Pult-only patch or override cannot live in those blocks, since the next sync removes it.** 2026-10-07, patches and blocks 2026-10-12. The packages define the wire protocol, which must match the server exactly, and `client-runtime` relies on the fork's `effect` patch, so a pinned copy of all of it never conflicts and `vendor:check` sees every drift, while merges conflicted in every file Pult patched and hand-copied patches drifted unseen. A Pult plugin, when one exists, is built against the same commit. Anton's ruling. *Rejected:* merging upstream or the fork (the practice until 2026-10-06; with it, keeping `apps/web` beside `apps/pult` as upstream's bytes); a git submodule; a git dependency, which cannot resolve `workspace:*` and `catalog:`. *See:* `pult/vendored-packages`, `pult/client-deploy`.

### identity-seam
**Env var names, flags, the vendored packages' names and protocol headers stay upstream's (`T3CODE_*`, `--base-dir`, `@t3tools/*`); only the values that tell Pult from an installed T3 Code are Pult's own, in `packages/pult/src/identity.ts`.** 2026-10-04. The servers Pult starts read those names, the fork's in a dev run and upstream's release over SSH, and so do the vendored packages, so a rename would split Pult from them. Anton ruled the values. *Rejected:* renaming them now. *See:* `pult/identity-seam`.

## Desktop

### no-local-server
**Pult bundles, starts and configures no server; a packaged desktop runs with the local environment off, whatever its settings file says, and attaches to a running server with a pairing link (`t3 pair`, or the server's `pairingUrl:` line).** 2026-10-06. Anton runs the server once and keeps it running, and a local-server feature would add bundling, settings and UI for little gain; upstream already supports a desktop without a local environment. Anton's ruling. *Rejected:* "Start a local server" in the first version; the local-environment toggle in Pult's client. *See:* `pult/third-party-client`.
