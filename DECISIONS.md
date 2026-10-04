# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## State

### default-home
**With no `--base-dir`, `--home-dir` or `T3CODE_HOME`, Pult's home is `~/.pult` everywhere a default is decided: the server and CLI, the desktop, the dev modes, and the home the desktop's SSH launch gives the server it runs on a remote host; the names of those flags and variables, and a worktree's own `.t3`, stay upstream's.** 2026-10-03. `~/.t3` is an installed T3 Code's live data, where the fleet runs, and Pult starts as upstream's code; keeping upstream's names keeps the patch on upstream's files small. Anton's ruling. `scripts/noT3HomeDefault.test.ts` fails if a `~/.t3` default comes back. *Rejected:* a migration or copy from `~/.t3`; renaming `T3CODE_HOME` and the flags now; a module naming the home, product and app id, which comes with the MVP's branding. *See:* `pult/own-home-dir`.

### state-scripts-homes
**The scripts that open the state database directly refuse to write into `~/.pult` and `~/.t3` alike, and `migrate-dev-db` still reads its source snapshot from `~/.t3`.** 2026-10-03. Either home may hold live data, and a test override of one must not lift the other; reading is a read-only snapshot, and `~/.t3` is where the real data is. *Rejected:* moving the source default to the still-empty `~/.pult`. *See:* `pult/own-home-dir`.
