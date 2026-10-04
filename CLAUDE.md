# Pult

This repo is **Pult**, a fork of T3 Code, and the **Pult track** in Anton's multi-track workspace: see `TRACK.md`. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else.
- **Upstream is `pingdotgg/t3code`, remote `upstream`, fetch-only** (its push URL is disabled). We keep taking its server changes, so keep our patch surface on upstream's files small: Pult's own code lives in its own folders, and its docs under `docs/pult/`. Upstream's `AGENTS.md` stays byte-for-byte untouched so merges never conflict on it. It is imported below for the codebase's conventions; where it speaks of T3 Code's product, it is not speaking of Pult's.
- **Pult's default home is `~/.pult`; `~/.t3` is the live fleet's.** The installed T3 Code app runs Bach against `~/.t3`. Anything run from this repo with no `--base-dir`, `--home-dir` or `T3CODE_HOME` lands in `~/.pult` (a worktree's dev run in its own `.t3`), and `scripts/noT3HomeDefault.test.ts` keeps it so. An explicit value still wins, so never pass `~/.t3`, and check that `T3CODE_HOME` is not set to it in your shell. Never open `~/.t3/userdata` read-write (reading and copying from it are fine), and never kill a process found by pattern-matching a name or path. The `test-t3-app` skill runs the app against isolated state for you.
- Commits: small and semantically scoped, one logical unit each. **Never push unless asked.** `origin` is `github.com/ashakirzianov/pult`.
- Issues live in xaxis as `pult/<slug>` (see `TRACK.md` frontmatter and the global conventions in `~/.claude/CLAUDE.md`). A standing note belongs in `docs/`, never the tracker.
- Licence: upstream's MIT text stays.

@AGENTS.md
