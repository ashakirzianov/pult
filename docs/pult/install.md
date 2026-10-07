# Installing Pult

How a Pult desktop build is made and installed beside T3 Code, how a client build reaches the installed app, and what only a human can check. Agents build; Anton installs and launches. Pult runs no server of its own: it attaches to a running T3 Code Extensible server (DECISIONS.md, `server-side-home`, `no-local-server`).

## Making a build

Build from a clean checkout of a landed commit, so the build names one commit.

```bash
git status --short                      # must print nothing
vp i
env -u ELECTRON_RUN_AS_NODE vp run dist:desktop:dmg:arm64
```

- The artifacts land in `release/`: `Pult-<version>-arm64.dmg` and a zip of `Pult.app`. Set `T3CODE_DESKTOP_OUTPUT_DIR=<dir>` to write them elsewhere.
- Without `--signed` (and Apple credentials, which Pult has none of), the build is signed ad hoc as `com.pult.pult`, without hardened runtime, and is not notarized (DECISIONS.md, `ad-hoc-signing`).
- It needs the network once, to download Electron for electron-builder.
- An agent shell under T3 Code or Pult inherits `ELECTRON_RUN_AS_NODE=1`, which turns every Electron binary the build spawns into plain Node; unset it as above.
- Packaged builds carry no update feed, so the app never updates itself (DECISIONS.md, `auto-update-off`).

Agents hand a build over in `/Users/devuser/repos/exchange/pult-build/`, with a `COMMIT` file naming the commit it was built from.

## Installing

1. Open the DMG and drag Pult to Applications. It installs beside T3 Code: its own bundle id (`com.pult.pult`), profile, URL scheme (`pult://`) and home (`~/.pult`).
2. If macOS refuses to open it, clear the quarantine flag (`xattr -dr com.apple.quarantine /Applications/Pult.app`), or right-click Pult in Applications and choose Open.
3. Pult starts with an empty home and an empty Keychain item: nothing is carried over from T3 Code.

## Connecting to a server

Pult runs no server and starts none: it attaches to a T3 Code server that is already running, on this machine or another, and remembers it in its own home. Pairing is the setup in this version.

1. Make a pairing link on the host: `t3 pair`, or copy the `pairingUrl:` line the server prints when it starts. A link is single-use and expires (five minutes by default; `t3 pair --ttl 1h` for longer).
2. On first launch, with nothing saved, Pult opens its setup wizard with “Add a computer” expanded: paste the link into “Pairing link”. Later, Settings → Connections → “Add environment” opens a dialog whose “Remote link” fields take a pasted pairing URL the same way.
3. With a server saved, Pult connects to it on every launch. The same pairing adds a second server, and Connections removes one.

Development runs are the exception: `vp run dev` starts the T3 Code Extensible checkout's server (`PULT_T3CODE_CHECKOUT`, default `~/repos/t3code-extensible`) from source against the worktree's `.t3` as a local environment, so the client can be worked on without a server of Anton's. `dev:desktop` still expects a bundled server and does not open a window until `pult/desktop-dev-mode` lands.

The protocol packages are vendored verbatim under `vendor/t3code/packages/` from the T3 Code Extensible fork at the commit in `vendor/t3code/PIN` (`b98fd8ad27`, upstream `f4f148eb67`), the same commit the server it pairs with is built from; `vp run vendor:sync` bumps them and `vendor:check` fails when the copy drifts.

## Shipping a build to the installed app

A build holds the client. An agent stages it; only Anton makes it live (DECISIONS.md, `payload-slot`).

- **Stage** (agent): `vp run pult:stage` builds `apps/pult` and copies it to `~/.pult/payload/builds/<time>-<sha>/client`, then points `staging` at the build. It never touches what is live.
- **Deploy** (Anton): View → Deploy Staged Build. The window reloads onto the staged build, and the build it replaced becomes `previous`.
- **Roll back** (Anton): View → Roll Back Build. It swaps `current` and `previous`, so a second Roll Back returns to the newer build.
- With nothing to switch, either item shows a dialog instead. The menu belongs to the shell, so it works even when a deployed client fails to load; a `current` with no `index.html` falls back to the client bundled in the app.

## Human checks

From the MVP units, the checks agents could not make. Tick them on the first install.

**Beside T3 Code** (`pult/identity-seam`)

- [ ] Pult and the installed T3 Code run at the same time, with separate Dock entries, single-instance locks and profiles.
- [ ] macOS hands `pult://` links to Pult and `t3code://` links to T3 Code.
- [ ] Pult's secrets start empty in its own Keychain item, and T3 Code's are untouched.
- [ ] Clerk / T3 Connect sign-in and the Codex auth handoff, if used, accept `pult://` redirects; upstream's Clerk allowlist may not include them.

**Home** (`pult/own-home-dir`)

- [ ] Pult's state lands in `~/.pult`, and `~/.t3` is unchanged.

**Connecting** (`pult/third-party-client`)

- [ ] A first launch opens the setup wizard on the pairing form, and a link from `t3 pair` on the host connects.
- [ ] No server process starts with Pult, and Settings → Connections offers no local environment to turn on.
- [ ] A relaunch reconnects to the saved server without pairing again.

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

- Some client prose and the DMG background still say T3 Code.
- An SSH environment launches upstream's T3 Code release on the host, not T3 Code Extensible, so RPCs added in the fork are absent there.
- A zero-step credential from `t3 auth session issue`, in place of a pairing link, is a later change.
