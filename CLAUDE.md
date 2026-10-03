# Pult

This repo is **Pult**, a fork of T3 Code, and the **Pult track** in Anton's multi-track workspace: see `TRACK.md`. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else.
- **Upstream is `pingdotgg/t3code`, remote `upstream`, fetch-only** (its push URL is disabled). We keep taking its server changes, so keep our patch surface on upstream's files small: Pult's own code lives in its own folders, and its docs under `docs/pult/`. Upstream's `AGENTS.md` stays byte-for-byte untouched so merges never conflict on it. It is imported below for the codebase's conventions; where it speaks of T3 Code's product, it is not speaking of Pult's.
- **Nothing separates Pult's state from T3 Code's yet.** This is still upstream's code, so its default home is `~/.t3`, and that is where the live fleet runs (Bach, inside the installed T3 Code app). Never open `~/.t3/userdata` read-write, never start a server or run the CLI against it, and never kill a process found by pattern-matching a name or path. Until Pult has a home of its own (`pult/own-home-dir`), every server, dev run and CLI call takes an explicit isolated directory (`--base-dir`, or `T3CODE_HOME`); the `test-t3-app` skill does this for you.
- Commits: small and semantically scoped, one logical unit each. **Never push unless asked.** `origin` is `github.com/ashakirzianov/pult`.
- Issues live in xaxis as `pult/<slug>` (see `TRACK.md` frontmatter and the global conventions in `~/.claude/CLAUDE.md`). A standing note belongs in `docs/`, never the tracker.
- Licence: upstream's MIT text stays.

@AGENTS.md
