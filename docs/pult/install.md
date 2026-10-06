# Installing Pult

How a Pult desktop build is made and installed beside T3 Code, how a client build and the server part reach the installed app, and what only a human can check. Agents build; Anton installs and launches.

## Making a build

Build from a clean checkout of a landed commit, so the build names one commit.

```bash
git status --short                      # must print nothing
vp i
env -u ELECTRON_RUN_AS_NODE vp run dist:desktop:dmg:arm64
```

- The artifacts land in `release/`: a DMG and a zip of `Pult.app`, under upstream's file names (`T3-Code-<version>-arm64.dmg`), which its release tooling expects. Set `T3CODE_DESKTOP_OUTPUT_DIR=<dir>` to write them elsewhere.
- Without `--signed` (and Apple credentials, which Pult has none of), the build is signed ad hoc as `com.pult.pult`, without hardened runtime, and is not notarized (DECISIONS.md, `ad-hoc-signing`).
- It needs the network once, to download Electron for electron-builder.
- An agent shell under T3 Code or Pult inherits `ELECTRON_RUN_AS_NODE=1`, which turns every Electron binary the build spawns into plain Node; unset it as above.
- Packaged builds carry no update feed, so the app never updates itself (DECISIONS.md, `auto-update-off`).

Agents hand a build over in `/Users/devuser/repos/exchange/pult-build/`, with a `COMMIT` file naming the commit it was built from.

## Installing

1. Open the DMG and drag Pult to Applications. It installs beside T3 Code: its own bundle id (`com.pult.pult`), profile, URL scheme (`pult://`), backend port and home (`~/.pult`).
2. If macOS refuses to open it, clear the quarantine flag (`xattr -dr com.apple.quarantine /Applications/Pult.app`), or right-click Pult in Applications and choose Open.
3. Pult starts with an empty home and an empty Keychain item: nothing is carried over from T3 Code.

## Shipping a build to the installed app

A build holds the client and the server part (`apps/pult-part`), switched together. An agent stages it; only Anton makes it live (DECISIONS.md, `payload-slot`).

- **Stage** (agent): `vp run pult:stage` builds `apps/pult` and `apps/pult-part` and copies them to `~/.pult/payload/builds/<time>-<sha>/client` and `.../part`, then points `staging` at the build. It never touches what is live.
- **Deploy** (Anton): View → Deploy Staged Build. The window reloads onto the staged build, and the build it replaced becomes `previous`. Within about 2 seconds the server restarts the part from the new build; if it does not come up in 15 seconds, the server runs the previous build's part (DECISIONS.md, `server-part-deploy`).
- **Roll back** (Anton): View → Roll Back Build. It swaps `current` and `previous`, so a second Roll Back returns to the newer build.
- With nothing to switch, either item shows a dialog instead. The menu belongs to the shell, so it works even when a deployed client fails to load; a `current` with no `index.html` falls back to the client bundled in the app.

## Human checks

From the MVP units, the checks agents could not make. Tick them on the first install.

**Beside T3 Code** (`pult/identity-seam`)

- [ ] Pult and the installed T3 Code run at the same time, with separate Dock entries, single-instance locks and profiles.
- [ ] macOS hands `pult://` links to Pult and `t3code://` links to T3 Code.
- [ ] Pult's secrets start empty in its own Keychain item, and T3 Code's are untouched.
- [ ] `pult service install` installs `com.pult.pult.service` beside T3 Code's agent without replacing it.
- [ ] Clerk / T3 Connect sign-in and the Codex auth handoff, if used, accept `pult://` redirects; upstream's Clerk allowlist may not include them.

**Home** (`pult/own-home-dir`)

- [ ] Pult's state lands in `~/.pult`, and `~/.t3` is unchanged.

**Deploy** (`pult/client-deploy`)

- [ ] After `vp run pult:stage`, View → Deploy Staged Build reloads the window onto the staged build.
- [ ] Roll Back Build reloads back, and a second Roll Back returns to the newer build.
- [ ] With nothing staged, Deploy Staged Build shows a dialog.

**Server part** (`pult/dynamic-server-part`)

- [ ] After deploying a build staged by `vp run pult:stage`, a new agent session lists `pult_part_status` among its `t3-code` tools, and calling it reports the deployed build, the calling thread, and `hostApiStatus: 200`.
- [ ] A client fetches `/api/pult/part/status` (signed in) and gets the deployed build's JSON; signed out, it gets 401.
- [ ] After a second deploy or a Roll Back, the same session's `pult_part_status` reports the other build: the tool survives the part's restart.
- [ ] Quitting Pult leaves no `main.mjs` process behind.

**Branding** (`pult/apply-new-branding`)

- [ ] The Dock, the app switcher and the window show the name Pult and Pult's icon.
- [ ] The wordmark and mark look right in a real window.
- [ ] The small icon (`small-icon.png`, used at 32 px and below) reads well in the favicon and small sizes.
- [ ] The dev icons (white fills, a solid black P) look right in a dev run.

## Known gaps

- Some client prose, the server's pairing log line and the DMG background still say T3 Code.
- An SSH environment fetches its remote runtime from upstream's release URL.
- The server CLI's default port, 3773, is still upstream's.
- The server part runs on the server's own Node runtime, so a server built as a single executable (`build:exe`) cannot run it.
- The proxy's WebSocket leg is not yet verified end to end.
