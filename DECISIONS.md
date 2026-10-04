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

## Deploy

### payload-slot
**Agents stage a build into `<home>/payload/` (one `builds/<build-id>/` per build, holding `client/` and later the server part beside it, plus the links `staging`, `current` and `previous`), and only the human makes one live, from the desktop shell's View menu (Deploy Staged Build, Roll Back Build); the client and the server part share the slot and its switch.** 2026-10-04. A switch can reload the human's window, and one switch cannot leave the client and the part out of step. Anton's ruling. `vp run pult:stage` builds and stages; it never touches `current`. *Rejected:* an agent-runnable deploy command; two independent slots. *See:* `pult/client-deploy`, `pult/dynamic-server-part`.

### client-dir-override
**The server (`--client-dir`, `T3CODE_CLIENT_DIR`) and the desktop window (`T3CODE_CLIENT_DIR`) serve the client from one override directory while it holds an `index.html`, checked on every request, and the bundled client otherwise; Pult's default for it is `<home>/payload/current/client`.** 2026-10-04. Both sides already read files per request, so a switch is one atomic link rename with no restart and no runtime machinery, and the bundled client is the recovery path when a deployed one is broken; the flag is upstream-shaped so it can be offered upstream. *Rejected:* the desktop loading the client from the local server, which shows nothing when the backend is down; `VITE_DEV_SERVER_URL` as the deploy path, which flips the whole app into development mode. *See:* `pult/client-deploy`.

### payload-roll-back
**Roll Back swaps `current` and `previous`, so a second Roll Back returns to the build that was rolled back from.** 2026-10-04. A roll back that drops the newer build would leave no way back to it short of staging it again. *Rejected:* a roll back that leaves `previous` empty. *See:* `pult/client-deploy`.
