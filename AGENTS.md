---
track: pult
label: repo:pult
---

# Pult

Pult is a fork of T3 Code with its own client: the shell at `apps/pult`, on VS Code's workbench, and the server changes it needs in `apps/server`, kept additive and offered upstream when generic.

This repository is the **Pult track**'s (xaxis `pult/about`), beside `../pult-star` (the Stars' generative art, local only). Read xaxis `pult/rfc-0` (human-written, never edited by agents) before anything else, then `pult/rfc-2`, the current direction. The track's decisions are xaxis `pult/decisions`; its design principles `pult/taste`. Cross-track conventions live in `../axis/AGENTS.md`.

## Where code lives

- `apps/pult`: the shell, a Vite page on VS Code's workbench with upstream's thread view built in; its map and its own conventions are `apps/pult/AGENTS.md`. `apps/pult/view` is the app around the thread view, `apps/pult/desktop` the Electron wrapper.
- `apps/web`: upstream's web app, which is also the shell's thread view, built in place by the shell's Vite. Pult's hook points in it are slots and contexts that leave it upstream's without them, each commented at the hook with Pult's use.
- `apps/server`: upstream's server with the fork's changes: the plugin loader and the plugin host entry (`src/pluginHost.ts`; the contract is `docs/internals/plugins.md`, the reference plugin `examples/plugins/hello`), and the RPCs Pult needs.
- `packages/*`: upstream's packages, `contracts`, `client-runtime`, `shared` and the rest; the shell depends on them as `workspace:*`.
- `apps/desktop`, `apps/mobile`, `apps/marketing`, `infra/`: upstream's.
- **Work in `apps/server`, `apps/web` or `packages/` follows upstream's instructions, `docs/upstream/AGENTS.md`** (its conventions, how the server works, dev servers, test data, verifying). It is upstream's root `AGENTS.md` byte for byte, so its links are relative to the repository's root, and where it says "we" it means upstream's maintainers.

## Rules

- **The patch surface is the loader, the view's hook points, and Pult's own directories.** Upstream is `pingdotgg/t3code`, remote `upstream`, fetch-only; we merge it regularly and offer our changes back one pull request at a time, from a branch carrying only the change. Outside `apps/pult` (and later `plugins/pult`), keep every change inside the plugin loader, the plugin host entry, their docs and tests, a hook point a plugin or the shell needs (`pult/decisions`, `plugin-reload`: a change to existing server behaviour is a hook point, never a wrap in a plugin), or an RPC Pult needs. Server changes are additive, new RPCs and fields behind feature flags, so T3 Code's own clients keep working with Pult's server (`pult/decisions`, `server-compatibility`); a generic one is offered upstream.
- **The installed app is this repository's server, and `~/.t3` is its live data.** The fork keeps upstream's identity, so its build replaces the installed T3 Code app and runs against `~/.t3` with the fleet's threads (`pult/decisions`, `fork-identity`). Hazard 2 below.
- **Plugins are code the server trusts completely.** A plugin runs in-process with the server's services, with no manifest, capabilities or consent, and contributes no UI (`pult/decisions`, `plugins-in-process`). It imports only `@t3code/plugin-host`, the server bundle's stable entry; the loader refuses a build using another copy of Effect or built for another server build, and swaps builds only on an explicit admin request. When a plugin needs something the host does not expose, extend `src/pluginHost.ts` or add a hook point, with a test, and record the reason.
- **Builds.** `node_modules/.bin/vp` if `vp` is not on PATH; unset `ELECTRON_RUN_AS_NODE` before a desktop build. Finished artifacts go to `~/repos/exchange/t3code-extensible-build/` with a `COMMIT` note naming the commit; Anton installs them. An unsigned macOS build is signed ad hoc, and a build names an update feed only when a repository is configured (`pult/decisions`, `ad-hoc-signing`, `update-feed`).
- Commits are small and semantically scoped, one logical unit each. **Agents push on their own** (`axis/decisions`, `push-gate`): a push publishes, since the repository is public, and deploys nothing. `origin` is `github.com/ashakirzianov/t3code-extensible`, to be renamed `ashakirzianov/pult`. Never commit secrets, tokens, `.env` files or data copied from `~/.t3`.
- Issues live in xaxis under the Pult track, `pult/<slug>`, labelled `repo:pult` (the frontmatter above). A standing note about the code belongs in `docs/` or beside the code, never the tracker; a design, direction or decision, of use without the repository, lives in xaxis under `pult/`.
- Licence: upstream's MIT text stays.

## The ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port after confirming its working directory is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the live server's database, in use while you work. Never start a server from this repository against `~/.t3`, never open `~/.t3/userdata` read-write, never reload or edit `~/.t3/plugins` by hand while the fleet runs. A dev run uses the worktree's own `.t3` (or `--home-dir`), and `vp run migrate-dev-db` seeds it from a read-only snapshot. Connecting the shell to the live server as a client, with a pairing link, is fine: that is what it is for.
3. **Two copies of the workbench, or of anything the view shares with the shell.** Vite must see one copy of every `@codingame/*` package, and the shell and `apps/web` one copy of React, Effect, the router and the protocol packages: the shell's dependencies it shares with `apps/web` take the catalog or `apps/web`'s ranges, and `resolve.dedupe` in `apps/pult/vite.config.ts` is the belt. A second copy breaks the workbench's singletons, or the view's contexts, in ways that look like anything else.
4. **Electron's identity and environment.** The shell's dev-identity app (`pult-dev`, "Pult (Dev)") never shares `userData`, its Keychain item or its scheme with an installed Pult (`pult`); a run on another dev server gets a `userData` of its own (`apps/pult/AGENTS.md`). An agent's shell may carry `ELECTRON_RUN_AS_NODE=1`, which turns `electron` into a bare Node: the desktop scripts unset it, so launch Electron through them, not by hand.
5. **Baking in origins**, upstream's third: never set `VITE_HTTP_URL` or `VITE_WS_URL` for upstream's web dev (`docs/upstream/AGENTS.md`).

## Running and verifying

- Node 26 and pnpm 12, through `vp`. `vp i` installs; a worktree gets it from the `t3.json` setup action (`scripts/setup-worktree.ts`), so wait for `.t3/setup-done` rather than racing it.
- The shell: `apps/pult/AGENTS.md`, Running. The server and upstream's apps: `docs/upstream/AGENTS.md`, Dev servers.
- `vp run typecheck` in the packages you changed, `vp lint` and knip over them; a hook point in `apps/web` is checked by both `apps/web`'s and `apps/pult`'s typecheck. **Do not run repo-wide checks** unless asked. There is no CI of ours yet; upstream's inherited workflows are disabled.

## Upstream merges

One builder, in a worktree, never a merge in progress on `main`: `git fetch upstream`, `git merge upstream/main` with `rerere` on, conflicts resolved in the server's and the view's hook points; keep our `AGENTS.md` and refresh `docs/upstream/AGENTS.md` with `git show upstream/main:AGENTS.md > docs/upstream/AGENTS.md`; `vp i` (the lockfile committed when upstream moved a dependency); `vp run typecheck` in `apps/pult`, `apps/web` and `apps/server`; the page run against a dev server of the worktree; re-check `.github/workflows` for workflows upstream added and disable them on GitHub; then fast-forward `main`.
