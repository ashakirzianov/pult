# Installing Pult

How a Pult desktop build is made and installed beside T3 Code, how a client build reaches the installed app, and what only a human can check. Agents build; Anton installs and launches.

## Making a build

Build from a clean checkout of a landed commit, so the build names one commit.

```bash
git status --short                      # must print nothing
vp i
env -u ELECTRON_RUN_AS_NODE vp run dist:desktop:dmg:arm64
```

- The artifacts land in `release/`: a DMG and a zip of `Pult.app`, under upstream's file names (`T3-Code-<version>-arm64.dmg`), which its release tooling expects. Set `T3CODE_DESKTOP_OUTPUT_DIR=<dir>` to write them elsewhere.
- The build is unsigned and not notarized unless `--signed` is passed with Apple credentials; Pult has none. Its executables keep only their linker signatures, so the bundle's signature does not verify until it is signed ad hoc at install.
- It needs the network once, to download Electron for electron-builder.
- An agent shell under T3 Code or Pult inherits `ELECTRON_RUN_AS_NODE=1`, which turns every Electron binary the build spawns into plain Node; unset it as above.
- Packaged builds carry no update feed, so the app never updates itself (DECISIONS.md, `auto-update-off`).

Agents hand a build over in `/Users/devuser/repos/exchange/pult-build/`, with a `COMMIT` file naming the commit it was built from.

## Installing

1. Open the DMG and drag Pult to Applications. It installs beside T3 Code: its own bundle id (`com.pult.pult`), profile, URL scheme (`pult://`), backend port and home (`~/.pult`).
2. Before the first launch, sign it ad hoc, so macOS and the Keychain see one consistent app named `com.pult.pult`: `codesign --force --deep --sign - /Applications/Pult.app`. Repeat this after every reinstall.
3. If macOS still refuses to open it, clear the quarantine flag (`xattr -dr com.apple.quarantine /Applications/Pult.app`), or right-click Pult in Applications and choose Open.
4. Pult starts with an empty home and an empty Keychain item: nothing is carried over from T3 Code.

## Shipping a client build to the installed app

An agent stages a client build; only Anton makes it live (DECISIONS.md, `payload-slot`).

- **Stage** (agent): `vp run pult:stage` builds `apps/pult` and copies it to `~/.pult/payload/builds/<time>-<sha>/client`, then points `staging` at it. It never touches what is live.
- **Deploy** (Anton): View → Deploy Staged Build. The window reloads onto the staged build, and the build it replaced becomes `previous`.
- **Roll back** (Anton): View → Roll Back Build. It swaps `current` and `previous`, so a second Roll Back returns to the newer build.
- With nothing to switch, either item shows a dialog instead. The menu belongs to the shell, so it works even when a deployed client fails to load; a `current` with no `index.html` falls back to the client bundled in the app.

## Human checks

From the four MVP units, the checks agents could not make. Tick them on the first install.

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

**Branding** (`pult/apply-new-branding`)

- [ ] The Dock, the app switcher and the window show the name Pult and Pult's icon.
- [ ] The wordmark and mark look right in a real window.
- [ ] The small icon (`small-icon.png`, used at 32 px and below) reads well in the favicon and small sizes.
- [ ] The dev icons (white fills, a solid black P) look right in a dev run.

## Known gaps

- Some client prose, the server's pairing log line and the DMG background still say T3 Code.
- An SSH environment fetches its remote runtime from upstream's release URL.
- The server CLI's default port, 3773, is still upstream's.
