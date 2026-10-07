# Pult

This repo is **Pult**, a third-party client of T3 Code Extensible (`~/repos/t3code-extensible`), and the **Pult track** in Anton's multi-track workspace: see `TRACK.md`. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else. `DECISIONS.md` holds the rulings; `docs/pult/install.md` is how a build reaches Anton; `AGENTS.md` below is Pult's own copy of the codebase conventions.
- **Shape.** `apps/pult` is the client (`@pult/client`), `apps/pult-desktop` the Electron shell (`@pult/desktop`), `packages/pult` Pult's shared code (`@pult/shared`: identity, the payload slot, the auth helpers that read the scheme), `scripts/` the build and dev tooling. `vendor/t3code/packages/` holds the five protocol packages copied verbatim from the fork at the commit in `vendor/t3code/PIN`. Everything outside `vendor/` is Pult's own: change it freely, there is no upstream merge. Never edit `vendor/`: a bump is a new PIN, `vp run vendor:sync`, and fixing what the types say; `vendor:check` fails on drift. An upstream client or desktop change reaches Pult only when someone carries it over by hand from the fork's history.
- **No server in this repo.** Pult's server side is a plugin on the fork (`DECISIONS.md`, `server-side-home`), and the installed T3 Code Extensible runs the live fleet at `~/.t3`. A dev run (`vp run dev`) starts that fork checkout's server from source (`PULT_T3CODE_CHECKOUT`, default `~/repos/t3code-extensible`) against the worktree's own `.t3`, never `~/.t3`; `scripts/noT3HomeDefault.test.ts` keeps Pult's defaults off it. Never open `~/.t3/userdata` read-write (reading and copying from it are fine), and never kill a process found by pattern-matching a name or path. The `test-t3-app` skill runs the app against isolated state for you.
- Commits: small and semantically scoped, one logical unit each. **Never push unless asked.** `origin` is `github.com/ashakirzianov/pult`; there is no `upstream` remote.
- Issues live in xaxis as `pult/<slug>` (see `TRACK.md` frontmatter and the global conventions in `~/.claude/CLAUDE.md`). A standing note belongs in `docs/`, never the tracker.
- Licence: upstream's MIT text stays.

@AGENTS.md
