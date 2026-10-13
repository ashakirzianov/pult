---
track: pult
label: repo:pult
---

# Pult

This repo is **Pult**, a client for T3 Code Extensible (`~/repos/t3code-extensible`): a web client (`apps/pult`), an Electron shell that serves it (`apps/pult-desktop`), and the tooling to build and deploy them. The server is not here; it is a running T3 Code Extensible, which Pult reaches over its WebSocket and HTTP protocol, typed by the vendored packages. It is one repo of the **Pult track** (xaxis `pult/about`), beside `../pult-extension` and the fork. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else, then `docs/pult/rfc-1.md`, the current direction.
- The track's decisions are xaxis `pult/decisions`: one log for its three repos, grouped by area. Record a new one there, in the entry shape of `../axis/workflow/global-agents.md`.
- `docs/pult/install.md` is how a build reaches Anton. Agents stage a client build (`vp run pult:stage`); only Anton makes one live, from the desktop's View menu.
- Commits are small and semantically scoped, one logical unit each. `origin` is `github.com/ashakirzianov/pult`; there is no `upstream` remote.
- Licence: upstream's MIT text stays.

## Review posture

**High-level.** Anton reviews direction, interfaces and module boundaries (the RFCs, `pult/decisions`, the seams with the server and the vendored packages), not implementation. Agents commit on their own and surface design deltas introduced during implementation rather than landing them silently. **Never push unless asked:** the repo is public, so pushing is Anton's call.

## Glossary

- **you** means the agent reading this file and changing Pult.
- **user** means Anton, using Pult to direct coding agents.
- **agent** means a coding agent run inside a T3 Code thread. Depending on context, that may include you.
- **provider** means the agent runtime the server talks to, such as Codex or Claude.
- **client** means Pult's web or desktop UI.
- **environment** means one running server and the machine, filesystem, credentials and state it owns. Pult's packaged desktop runs with no local environment and attaches to one.
- **project**, **thread**, **turn** are the server's: a workspace record rooted at a directory, the durable conversation for a project, one user-to-agent cycle.
- **T3 home** means the server's base data directory (`~/.t3` for the live server, a checkout's `.t3` in development). Pult's own desktop state lives in `~/.pult`.

## Where code lives

- `apps/pult` - the React/Vite client (`@pult/client`), Pult's own copy of upstream's `apps/web` taken at upstream `f4f148eb67`. Shared client logic the server's own client also uses is in the vendored `client-runtime`.
- `apps/pult-desktop` - the Electron shell (`@pult/desktop`): window, IPC, the payload slot and client-dir override, SSH and Tailscale connections.
- `packages/pult` - `@pult/shared`: the identity seam, the payload slot, the scheme-reading auth helpers.
- `vendor/t3code/packages` - `contracts`, `client-runtime`, `shared`, `ssh`, `tailscale`; `vendor/t3code/patches` - the fork's patches to the packages this repo installs, applied through `pnpm-workspace.yaml`, whose `catalog`, `overrides`, `packageExtensions` and `patchedDependencies` blocks `vendor.ts` writes from the fork's. All of it is copied verbatim from the fork at the commit in `vendor/t3code/PIN`. Read them, never edit them, those blocks included (`pult/decisions`, `protocol-packages-pinned`): a bump is a new PIN, `vp run vendor:sync`, `vp i`, and fixing what the types say; `vendor:check` fails on drift.
- `scripts` - the dev runner, the desktop artifact build, staging, icons, the vendoring script and the guards (`noUpstreamIdentity`, `noT3HomeDefault`).
- `docs/pult` - Pult's own docs; `docs/internals` and `docs/operations` - upstream-derived pages (see Documentation).

Everything outside `vendor/` is Pult's own: change it freely, there is no upstream merge. An upstream client or desktop change reaches Pult only when someone carries it over by hand from the fork's history.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs other dev servers at once. Kill only a PID you captured at spawn.
2. **Writing to the live install.** `~/.t3/userdata` is the live server's database, the installed T3 Code Extensible's, in use while you work. Reading it and copying from it are fine (see Test data). Never start a server against it, never open it read-write, never clean it up. `scripts/noT3HomeDefault.test.ts` keeps Pult's own defaults off `~/.t3`.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and breaks every remote browser.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling client work done, walk this list and say which entries applied:

- **Entry points.** A behaviour reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding.
- **Clients.** Web and desktop (which wraps web and adds the Electron shell and IPC). Mobile is not Pult's.
- **Contracts.** Anything crossing the wire is typed in the vendored `contracts`. Pult cannot change it; a feature that needs a new wire shape is a fork change (`~/repos/t3code-extensible`), offered upstream when it is generic; a Pult-specific one would be a plugin route (`/api/plugins/pult/*`), and a client reads `GET /api/plugins` before relying on one (`pult/decisions`, `server-side-home`).
- **Reverse states.** If you added a way in, add the way out and the way to see it. A one-way door is a bug.
- **Connection modes.** Local, remote and SSH behave differently; multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate before adding anything.

## Dev servers

- `vp i` installs. A worktree gets this, and the main checkout's `.env`, from `scripts/setup-worktree.ts`: T3 Code runs it through `t3.json`, and a worktree made by hand runs `node scripts/setup-worktree.ts`. If module resolution looks broken, it probably did not run.
- `vp run dev` starts the server and the web client. The server is the T3 Code Extensible checkout's (`PULT_T3CODE_CHECKOUT`, environment or `.env`, default `~/repos/t3code-extensible`), run from source with the checkout's gitignored `.t3` as its home, a worktree's or the main checkout's; that home outranks an ambient `T3CODE_HOME`, and an explicit `--home-dir` wins. `dev:web` starts the client alone. `dev:desktop` starts the Electron client but still expects a bundled server (`pult/desktop-dev-mode`).
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet: run `vp run dev --share` in the background, wait for the `pairingUrl:` line, give that URL to an unpaired browser. If a one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair` run in the checkout with `T3CODE_HOME` set to the checkout's `.t3`. See `docs/operations/development.md`.
- Stop what you started, by the PID you tracked.

## Test data

An empty database is a bad test. `vp run migrate-dev-db`, with your dev server stopped, rebuilds `<checkout>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite` with the checkout's migration script. It keeps recent projects and their stopped threads and drops scheduled tasks, pending work and auth sessions. Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works: `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- Test meaningful logic or observable behaviour. Do not render components to static markup to assert props, or add tests that merely mirror the implementation.
- **Do not run repo-wide checks** unless asked. There is no CI; the lead integrates by review.
- A test that needs a timeout or a sleep to pass is wrong.
- User-visible changes get one integrated pass in the real client, `test-t3-app`, which runs the app against isolated state, by the primary agent after integrating, with permission before any browser or computer use. Subagents do not launch their own dev servers.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `docs/pult/` is for Pult's own procedures, what is useless without the checkout. Designs, direction and decisions live in xaxis under `pult/`, since someone without the repo uses them too. Before adding a paragraph, ask what a maintainer would get wrong without it.
- `docs/internals/` and `docs/operations/` are upstream-derived pages, kept where they describe Pult's code. When a page goes stale, rewrite or remove the affected text; do not append another account.
- An effort's plan may sit beside its design as `docs/<effort>-tasks.md` while the effort runs; when the effort ends, both move to `archive/`. Do not commit research notes or agent scratch files.

## Taste

- Complexity belongs at the boundary. UI stays dumb; what the server can do deterministically, do not ask an agent to do.
- `apps/pult/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. Layout classes belong on the parent. `shadcn/no-restyle` fails lint on violations. See `docs/internals/web-ui.md`.
- Inferred types over annotations. `any` is the enemy. The desktop and scripts use Effect; follow the patterns already in those trees.
- Comments describe how a thing is used, and move when the code moves.
- No continuously repainting animations; they peg the GPU on high-refresh displays. Users notice a dropped frame, a lying spinner and a stale label.
- Do not preserve complexity because it already exists, and do not add machinery because it looks architecturally impressive. Fight scope creep. If a rule here fights the task, say so and get a human sign-off before breaking it.
- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
