# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Identity

### identity-seam
**`packages/shared/src/identity.ts` names every value by which the OS, the user and other apps tell Pult from an installed T3 Code (display name `Pult`, bundle id `com.pult.pult`, scheme `pult`, Electron userData, Linux desktop ids and window class, observability service, desktop backend port 3883, each with a dev variant), and every site in the desktop, the client and the scripts reads it, while `apps/server` is upstream's bytes and reads none of it (`server-side-home`); env var names, flags, the `t3-code` MCP key, package names, protocol headers and the home stay where they are, and the CLI and boot-service names are the server's, so Pult has none.** 2026-10-04. A Pult app must run beside the installed T3 Code, the live fleet's host, without either disturbing the other, and one module keeps the patch on upstream's files small and is the form worth offering upstream. Anton ruled the values; desktop and web only, mobile is out of scope. Pult has never shipped a desktop profile, so the userData migration from upstream's legacy profiles is gone rather than renamed: those profiles are T3 Code's own, and a display-name profile `Pult` would be the userData `pult` on a case-insensitive disk. `scripts/noUpstreamIdentity.test.ts` fails if a site spells upstream's values again. *Rejected:* renaming the env vars, flags and packages now; keeping the legacy-profile migration under Pult's names. *See:* `pult/identity-seam`.

### brand-icons
**Pult's desktop and web icons, prod and dev, are rendered with sharp by `scripts/pult/render-icons.ts` (`icons:export`, `icons:check`) from the sources in `assets/pult/` into `assets/pult/{prod,dev}` and `apps/pult/public`, and the build tables, the desktop and the launcher read them there; renders at 32 px and below use `small-icon.png`, and dev is black and white (`icon.svg` with its four coloured fills white, and a solid black P).** 2026-10-04. Anton supplied SVGs and a PNG rather than Icon Composer projects, so a script renders every size; the small-size reading of `small-icon.png` is the lead's and is not yet confirmed by Anton, so it sits in one constant in the script. Upstream's `assets/dev`, `assets/prod` and their exporter stay as upstream ships them, unread, so upstream merges do not conflict there; iOS, nightly and mobile stay upstream's. A white P would vanish into the white body at favicon size, so dev's P is black. *Rejected:* overwriting upstream's files in place; an Icon Composer project now (`pult/icon-composer-project`). *See:* `pult/apply-new-branding`.

## Client

### client-folder
**Pult's client is `apps/pult` (package `@pult/client`), a copy of upstream's `apps/web`; the dev modes, `pult:stage` and the desktop artifact build it, and `apps/web` stays upstream's bytes, built for nothing of Pult's.** 2026-10-04. Upstream merges then never conflict in `apps/web`, and Pult's client changes freely; upstream's client changes reach `apps/pult` only when someone carries them over. The root config names `apps/web` in its lint overrides and its `~` alias, and `scripts/pult/rootViteConfig.ts` extends both to `apps/pult` by wrapping upstream's lines rather than rewriting them; the identity guard skips `apps/web`. *Rejected:* editing `apps/web` in place. *See:* `pult/client-deploy` (ruling 2), `pult/apply-new-branding`.

## Deploy

### payload-slot
**Agents stage a client build into `<home>/payload/` (one `builds/<build-id>/` per build, plus the links `staging`, `current` and `previous`), and only the human makes one live, from the desktop shell's View menu.** 2026-10-06. A switch can reload the human's window. Anton's ruling. *Rejected:* an agent-runnable deploy command; a server part sharing the slot (2026-10-05), gone with `server-side-home`. *See:* `pult/client-deploy`, `pult/drop-client-hot-swap`.

### client-dir-override
**The desktop window serves the client from `T3CODE_CLIENT_DIR` while it holds an `index.html`, checked on every request, and the bundled client otherwise; Pult's default is `<home>/payload/current/client`.** 2026-10-06. The desktop reads files per request, so a switch is one link rename with no restart, and the bundled client is the recovery path. *Rejected:* the server half of this override (2026-10-04), gone with `no-local-server`. *See:* `pult/client-deploy`, `pult/drop-client-hot-swap`.

### payload-roll-back
**Roll Back swaps `current` and `previous`, so a second Roll Back returns to the build that was rolled back from.** 2026-10-04. A roll back that drops the newer build would leave no way back to it short of staging it again. *Rejected:* a roll back that leaves `previous` empty. *See:* `pult/client-deploy`.

## Server

### server-side-home
**Pult's server side is a plugin on T3 Code Extensible, a separate minimal fork of upstream; the Pult repo carries no server patch, and `apps/server` stays upstream's bytes, built for nothing.** 2026-10-06. The part reached the server only through the client API, so it could neither attribute a message to an agent nor send a notification, and every further need would have grown the seam; a plugin inside the server process reaches everything, and the fork's patch is one loader. Anton's ruling. *Rejected:* the supervised server part of 2026-10-05 (`pult/dynamic-server-part`); a standalone MCP server registered in each provider's own config, whose caller would be self-reported and whose tools would appear in every session of that CLI on the machine. *See:* `pult/t3code-extensible`, `pult/standalone-mcp-server`.

### no-local-server
**Pult bundles, starts and configures no server; a packaged desktop runs with upstream's local environment off, whatever its settings file says, and attaches to a running server with a credential from `t3 auth session issue` or `t3 pair`, or a pairing link.** 2026-10-06. Anton runs the server once and keeps it running, and a local-server feature would add bundling, settings and UI for little gain; upstream already supports a desktop without a local environment. Development runs keep the local environment, since they start the repo's `apps/server` against the worktree's `.t3`. Anton's ruling. *Rejected:* "Start a local server" in the first version; the local-environment toggle in Pult's client. *See:* `pult/third-party-client`.

### protocol-packages-pinned
**Pult takes `contracts`, `client-runtime` and `shared` from the fork at a pinned commit, the same commit the Pult plugin is built against, and does not merge upstream.** 2026-10-06. The packages are workspace-private and define the wire protocol, which must match the server exactly; a pin is a bump, a merge is conflicts. Mechanism still open. *See:* `pult/third-party-client`.

## Packaging

### auto-update-off
**Packaged Pult builds carry no update feed, so the app ships without `app-update.yml` and never checks for updates; `PULT_UPDATE_FEED_ENABLED` in `scripts/build-desktop-artifact.ts` turns it back on when Pult has releases of its own.** 2026-10-04. A feed taken from the environment (`GITHUB_REPOSITORY`, `T3CODE_DESKTOP_UPDATE_REPOSITORY`) could name upstream's releases, and an update from there would replace Pult with T3 Code; with no feed the app's own check reports updates as unavailable, so the desktop code stays upstream's. The mock update server for local testing still works. *Rejected:* disabling the updater in the desktop app itself, which patches upstream's updater for a fact the build already decides. *See:* `pult/first-install`.

### ad-hoc-signing
**An unsigned macOS build is signed ad hoc (`mac.identity: "-"`) with hardened runtime off; a `--signed` build is untouched.** 2026-10-06. Without it the bundle carries only linker signatures and does not verify, so every install needed a manual `codesign --force --deep --sign -`; an ad hoc signature has no team id, and hardened runtime's library validation would then refuse Electron's frameworks. *Rejected:* the manual `codesign` step at install, the lead's interim call of 2026-10-04. *See:* `pult/identity-leftovers`, `pult/first-install`.
