---
track: pult
label: repo:t3code-extensible
---

# T3 Code Extensible

This repo is **T3 Code Extensible**, a minimal fork of T3 Code that loads fully trusted plugins into the server process. It is the host Anton's fleet runs on, and Pult (`~/repos/pult`) is its client; Pult's server side is a plugin here. `DECISIONS.md` holds the rulings; `docs/internals/plugins.md` is the plugin contract; `examples/plugins/hello` is the reference plugin.

- **The patch surface is one loader.** Upstream is `pingdotgg/t3code`, remote `upstream`, fetch-only; we merge it regularly and offer our changes back one pull request at a time. Keep every change inside the plugin loader, the plugin host entry, their docs and tests, or a hook point a plugin needs (`DECISIONS.md`, `plugin-reload`: a change to existing server behaviour is a hook point here, never a wrap in a plugin). Upstream's `AGENTS.md` stays byte-for-byte untouched; it is imported below for the codebase's conventions. A new server feature that is not about plugins belongs upstream, not here.
- **The installed app is this fork, and `~/.t3` is its live data.** The fork keeps upstream's identity, so its build replaces the installed T3 Code app and runs against `~/.t3` with the fleet's threads (`DECISIONS.md`, `fork-identity`). Never start a server from this checkout against `~/.t3`, never open `~/.t3/userdata` read-write, never reload or edit `~/.t3/plugins` by hand while the fleet runs; a dev run uses the worktree's own `.t3`, and `vp run migrate-dev-db` seeds it from a read-only snapshot. Never kill a process found by pattern-matching a name or path.
- **Plugins are code the server trusts completely.** A plugin runs in-process with the server's services, with no manifest, capabilities or consent, and contributes no UI (`DECISIONS.md`, `plugins-in-process`). It imports only `@t3code/plugin-host`, the server bundle's stable entry; the loader refuses a build using another copy of Effect or built for another server build, and swaps builds only on an explicit admin request. When a plugin needs something the host does not expose, extend `src/pluginHost.ts` or add a hook point, with a test, and record the reason.
- **Builds.** `node_modules/.bin/vp` if `vp` is not on PATH; unset `ELECTRON_RUN_AS_NODE` before a desktop build. Finished artifacts go to `~/repos/exchange/t3code-extensible-build/` with a `COMMIT` note naming the commit; Anton installs them. An unsigned macOS build is signed ad hoc, and a build names an update feed only when a repository is configured (`DECISIONS.md`, `ad-hoc-signing`, `update-feed`).
- Commits: small and semantically scoped, one logical unit each. **Never push unless asked.** `origin` is `github.com/ashakirzianov/t3code-extensible`.
- Issues live in xaxis under the Pult track, `pult/<slug>`, labelled `repo:t3code-extensible` (the frontmatter above; the track is `pult/about`); this repo has no track of its own. A standing note belongs in `docs/`, never the tracker.
- Licence: upstream's MIT text stays.

@AGENTS.md
