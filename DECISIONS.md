# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## State

### default-home
**With no `--base-dir`, `--home-dir` or `T3CODE_HOME`, Pult's home is `~/.pult` everywhere a default is decided: the server and CLI, the desktop, the dev modes, and the home the desktop's SSH launch gives the server it runs on a remote host; the names of those flags and variables, and a worktree's own `.t3`, stay upstream's.** 2026-10-03. `~/.t3` is an installed T3 Code's live data, where the fleet runs, and Pult starts as upstream's code; keeping upstream's names keeps the patch on upstream's files small. Anton's ruling. `scripts/noT3HomeDefault.test.ts` fails if a `~/.t3` default comes back. *Rejected:* a migration or copy from `~/.t3`; attaching over SSH to a remote host's T3 Code home; renaming `T3CODE_HOME` and the flags now; naming the home in the identity module (`identity-seam` keeps it out). *See:* `pult/own-home-dir`.

### state-scripts-homes
**The scripts that open the state database directly refuse to write into `~/.pult` and `~/.t3` alike, and `migrate-dev-db` still reads its source snapshot from `~/.t3`.** 2026-10-03. Either home may hold live data, and a test override of one must not lift the other; reading is a read-only snapshot, and `~/.t3` is where the real data is. *Rejected:* moving the source default to the still-empty `~/.pult`. *See:* `pult/own-home-dir`.

## Identity

### identity-seam
**`packages/shared/src/identity.ts` names every value by which the OS, the user and other apps tell Pult from an installed T3 Code (display name `Pult`, bundle id `com.pult.pult`, scheme `pult`, CLI `pult`, Electron userData, Linux desktop ids and window class, boot service, observability service, desktop backend port 3883, each with a dev variant), and every site reads it; env var names, flags, the `t3-code` MCP key, package names, protocol headers and the home (see `default-home`) stay where they are.** 2026-10-04. A Pult app must run beside the installed T3 Code, the live fleet's host, without either disturbing the other, and one module keeps the patch on upstream's files small and is the form worth offering upstream. Anton ruled the values; desktop and web only, mobile is out of scope. Pult has never shipped a desktop profile, so the userData migration from upstream's legacy profiles is gone rather than renamed: those profiles are T3 Code's own, and a display-name profile `Pult` would be the userData `pult` on a case-insensitive disk. `scripts/noUpstreamIdentity.test.ts` fails if a site spells upstream's values again. *Rejected:* renaming the env vars, flags and packages now; keeping the legacy-profile migration under Pult's names. *See:* `pult/identity-seam`.
