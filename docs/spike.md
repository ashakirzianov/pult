# The shell spike

The first attempt at Pult's own shell, built overnight on 2026-10-16 on the orphan branch `shell`, with permission to be deleted. It answers the five questions of xaxis `pult/own-shell` empirically; the plan agreed with Anton is written there. This document is how to run it, what works, what does not, and the answers with their evidence.

## What it is

A Vite page that mounts VS Code's workbench, vendored through `@codingame/monaco-vscode-api` **37.6.1**, which carries **VS Code 1.138.0** (commit `7debcd0e2acdea1c52de81bf9ee1620444407dda`). The Pult extension (`pult-extension`, built) is registered as a built-in web extension and runs in the web worker extension host, connected to a T3 Code dev server. Around the workbench the page draws a thread-centred layout of its own: a rail of threads, the selected thread in the centre, VS Code's editor groups on the right. Browser only; no Electron.

- `src/main.ts` boots: workers, IndexedDB user data, the in-memory workspace file, the Pult extension, the page layout, then `initialize()` of the workbench into the right column.
- `src/services.ts` is the list of service overrides (the full workbench plus what the extension and the editor need; terminal, SCM, debug, testing, notebooks and chat left out) and the Open VSX gallery URLs.
- `src/pultExtension.ts` registers the extension's manifest with `ExtensionHostKind.LocalWebWorker` and a URL per file of its `dist/` and `media/`; `vite/pultExtension.ts` serves those files untouched from the extension's checkout.
- `src/threads/` is question 1: a shell-rendered editor pane (`pane.tsx`), the in-process store the extension pushes into (`store.ts`), and the React view (`ThreadView.tsx`).
- `src/shell/` is the layout sketch: `Rail.tsx`, `Centre.tsx`, `mount.tsx`, `shell.css`.
- `src/secrets.ts` persists extension secrets; `src/configuration.json` is the shell's settings defaults; `src/debug.ts` is the `window.pult` console handle.
- `scripts/drive.ts` drives the page in headless Chromium, with a persistent profile, for screenshots and for the extension's prompts.

## Running it

Node 24 and pnpm. Three processes:

1. **The extension, built on its `shell-spike` branch.** The spike needs one small addition to the extension (`src/shellBridge.ts`, see question 1), committed on branch `shell-spike` of `pult-extension`, in the worktree `~/repos/pult-extension-wt-shell-spike`. Build it there: `cd extension && pnpm i && pnpm build`. The shell finds the extension at `../pult-extension/extension` by default; point `PULT_EXTENSION_DIR` at the worktree's `extension/` to get the bridge.
2. **A dev server**, from the main `pult` checkout: `T3CODE_DEV_ALLOWED_ORIGINS=http://localhost:5190 vp run dev`. It prints a pairing URL for its web port (5733 tonight). Never the live server.
3. **The shell:** `pnpm i && PULT_EXTENSION_DIR=~/repos/pult-extension-wt-shell-spike/extension pnpm dev`, then open http://localhost:5190/. The first load pre-bundles the workbench and takes a while; later loads take a few seconds.

Then connect: Cmd+Shift+P, "Pult: Connect to Environment", paste the pairing link. A pairing-code session lacks the `filesystem:*` scopes, so files of a project do not open through `pult:` with it; a session token does: `t3 auth session issue --ttl 7d --json` in the fork's checkout with `T3CODE_HOME` set to the dev home, and connect with `http://localhost:5733/#token=<token>`.

In the page, `window.pult` has `exec(command, ...args)`, `commands(prefix)`, `status()` (extension activation and errors), `threads()` (the store the extension pushes) and `read(uri)`. The headless driver: `node scripts/drive.ts 'wait:5000' 'eval:pult.threads()' 'shot:/tmp/shell.png'`; its steps are documented at the top of the file.

## What works

- The workbench renders in the page with the activity bar, status bar, menu bar, command centre, layout controls, breadcrumbs and title bar off; the command palette, quick open, keybindings, themes, grammars and the editor groups are stock.
- The Pult extension activates in the worker extension host with no errors, registers all its commands and views, connects to the dev server, lists threads in its picker, opens its webview thread tabs, serves the `pult:` filesystem (a project file opens in the stock editor), and keeps its connection across reloads.
- A thread renders in a pane the shell draws itself, in an editor group, with plain React and no webview; the extension's thread model reaches it in-process over a command.
- A VS Code server of the same commit connects as the remote, and a Node extension installed there runs and answers a command.
- The layout sketch: rail, thread, editor groups, with the explorer as a drawer on Cmd+B.

## What does not, or not yet

- The thread's turns and composer are not in the shell-rendered pane; the pane shows the thread's shell (title, project, branch, run state) and a placeholder. Mounting upstream's thread view there needs the shell to own the connection (see question 1).
- Secrets persist in `localStorage` (a spike choice); a desktop wrapper would use the keychain through Electron's safeStorage.
- Production build: the extension is served from its checkout by the dev server plugin only; `vite build` would need the files copied. Not attempted.
- Opening a thread pane in a second editor column (`pult-shell.openThreadPane <id> 2`) replaced the preview editor in group 1 instead of splitting; the editor service's column handling for a custom input was not investigated.
- The webview thread tab's page, once opened, briefly complained about the Vite client's WebSocket under its CSP; harmless, and gone in a production build.
- With a remote connected the page logs `Bad progress location: workbench.scm` once, from a server built-in extension reporting to an SCM view the shell does not have.

## The answers

### 1. Can the workbench host a pane the shell renders itself, inside its editor groups?

**Yes.** `@codingame/monaco-vscode-workbench-service-override/common` exports `registerEditorPane`, `registerEditor`, `registerEditorSerializer`, `SimpleEditorPane`, `SimpleEditorInput` and `registerCustomView`, all below the extension API: they register with the workbench's own `EditorPane` and `EditorInput` registries. `src/threads/pane.tsx` registers `pult.shell.threadPane`; its `initialize()` returns a `div` and `renderInput()` mounts a React root into it. The editor group gives it a tab, splitting, drag, restore (through the serializer) and layout. Screenshot: `docs/spike/pane-in-editor-group.png`, the sandbox thread rendered in group 1 with the React pane; `docs/spike/sketch-pane-and-explorer.png` shows the same thread in the centre column and in a pane at once.

The data path is the finding worth keeping. An extension's `vscode.commands.executeCommand` reaches commands registered in the main thread with `CommandsRegistry.registerCommand`, so the extension pushes its thread model into the page by executing `pult-shell.threads` with a plain payload on every change, and the shell's React reads a store (`src/threads/store.ts`). The extension side is 50 lines (`src/shellBridge.ts` on `shell-spike`), inert outside the shell since it checks `vscode.env.appName === "Pult"`. The reverse direction is ordinary: the shell executes the extension's commands (`pult.newThread`, `pult.connect`, `pult.openThread`). This is where a small Pult extension API would sit, too: see below.

What the pane does not have tonight is the thread's turns. The extension's webview page carries the connection through the host's socket; a shell-rendered thread view would mount upstream's `ThreadApp` with a socket of the page's own, which means the shell, not the extension, owns the connection and hands it to both the pane and the extension. That is the next build, not a question.

### 2. How much chrome comes off, and what remains?

Everything named in the brief comes off, by configuration defaults alone (`src/configuration.json`, passed as `configurationDefaults`), with no patching:

| Part | How | Remains |
|---|---|---|
| Activity bar | `workbench.activityBar.location: hidden` | nothing |
| Status bar | `workbench.statusBar.visible: false` | the part exists at 0 px; extensions' status items are unseen (the extension's connection item among them) |
| Menu bar | `window.menuBarVisibility: hidden` | nothing in web |
| Command centre, layout controls | `window.commandCenter: false`, `workbench.layoutControl.enabled: false` | nothing |
| Title bar | empty title bar plus hidden menu, the rule in `shouldShowCustomTitleBar` for web; the title bar service override is not even loaded | the part at 0 px. Moving editor actions or the activity bar into it brings it back, by VS Code's own rule |
| Breadcrumbs, minimap | settings | nothing |
| Sidebar (explorer, search, outline, timeline) | `setPartVisibility(Parts.SIDEBAR_PART, false)` at start | comes back on Cmd+B as a drawer beside the editor groups, which is what the sketch wants |
| Panel, auxiliary bar | not shown by default | available if a feature wants them |

What remains with everything off is the editor part alone: tab bar, editor group containers, the editor placeholder watermark, the quick input widget on demand, notifications toasts, context menus and dialogs. Everything the extension contributes to the activity bar (the Pult container and its Threads view) is reachable through commands (`pult.threads.focus` opens the sidebar with it) but unseen, which is right for the sketch: the rail replaces the picker. Themes recolour the editor part; the sketch's own columns use their own CSS.

There is a second, deeper option found while reading: the workbench override ships a `/session` variant, `@codingame/monaco-vscode-workbench-service-override/session`, which is VS Code 1.138's own agent-sessions workbench with `SESSIONS_PART` and `CUSTOM_VIEW_GRID_PART` in its layout and an `agentHost` protocol. Not tried; it is built around Copilot's agent host, so it would be a model to compare the sketch against rather than a base to adopt.

### 3. Does the extension's host code run unchanged in the vendored web extension host?

**Yes, unchanged.** The built `dist/web/extension.js` from `pult-extension` `main` (commit 444c78b) activated on the first try: `status()` shows `pult.pult` activated with no messages and no runtime errors; all 22 commands registered; the Threads view, its welcome content, the custom editor and the `pult:` filesystem provider work; the connection flow (HTTP probe, ticket, WebSocket) ran against the dev server from the worker host's origin without a CORS change beyond the dev runner's allowed origin.

Two things broke around it, both in the shell, neither in the extension:

- **Secrets did not survive a reload.** VS Code's `BrowserSecretStorageService` is in memory unless the embedder passes a `secretStorageProvider` in the construction options; the extension's credential was gone on every reload and the picker said "Connection credential … is unavailable". `src/secrets.ts` is a `localStorage` provider; with it the connection reconnects silently after a reload.
- **Webview assets.** The thread tab's page loads `thread.js`, its chunks and fonts through `vscode-resource` URLs that the webview service worker resolves through the file service; they resolve because every file of `dist/` is registered with `registerFileUrl`. The vendored workbench ships its own webview host page (in `monaco-vscode-view-common-service-override`), so no Microsoft CDN is involved. Listing 2,132 files at registration is cheap since each is fetched lazily.

The one change made to the extension is the bridge of question 1, an addition on `shell-spike`, not a fix. Note that a built-in registered this way runs in Production extension mode, so `activate()` returns no test API; the headless load's hooks are not available in the shell.

### 4. Does the package track VS Code closely enough to be a dependency?

**Closely in time, selectively in versions, and on one person.** From the release list and npm (`gh api`, `npm view`, gathered tonight):

- **Lag.** 15 of the 18 majors from v20 to v37 shipped within six days of the VS Code release they carry (v28 and v30 on the same day). But VS Code has shipped weekly since 1.111 and the package carried 11 of the 32 releases from 1.111 to 1.142. The longest hold was 1.128 from 2026-07-09 to 2026-09-17 while VS Code shipped 1.129 to 1.137. Today VS Code stable is 1.142.0 (2026-10-14); the package is on 1.138.0.
- **Cadence.** 107 npm versions in the last 12 months, between 3 and 16 a month; 15 in the first half of October alone.
- **Breaking churn.** Each VS Code bump is a semantic-release major with a one-line note ("update to vscode 1.138"). In twelve months the only API-shaped breaks were v24 ("make the extension host worker use the regular worker loading workflow") and v36 (a monaco-editor update with new entries); no renamed packages, removed exports or `initialize` signature changes were listed. The README is behind the code, though: `vscode/localExtensionHost` no longer exists, and the demo is the real documentation.
- **Size.** `@codingame/monaco-vscode-api` is 49 MB unpacked with 6,946 files; the workbench override 2.8 MB; 187 `@codingame/monaco-vscode-*` packages exist at 37.6.1 (77 service overrides, 80 default extensions, 14 language packs), about 290 MB all told. This shell installs 62 of them; `node_modules/.pnpm` is 236 MB. Vite serves the dev page from thousands of small modules, so the first load pre-bundles for a minute; afterwards a reload is a few seconds.
- **Divergence.** `vscode-patches/` holds 115 patches, 25,862 lines, touching 568 VS Code files (+5,865/−3,606). That is the fork Pult would otherwise carry itself, and it is why a bump is their work, not ours.
- **Bus factor.** 434 commits in the last year from 7 authors; Loïc Mangeonjean made 413 (95%), with CodinGame and CoderPad addresses. No funding statement; 513 stars, one open issue, pushed yesterday.

The reading: as a dependency it is a monthly-or-so bump that is one person's job upstream, with the risk concentrated in that person. The alternative, a Pult fork of VS Code, is the 115 patches done by us. Vendor.

### 5. Does a remote extension host path exist, for Node extensions on the environment host?

**Yes, and it works.** The remote agent service override (`@codingame/monaco-vscode-remote-agent-service-override`) plus `remoteAuthority` in the construction options is the whole client side; the shell reads `?remoteAuthority=host:port`. Tried tonight: VS Code's own server for the same commit, `server-darwin-arm64` (a 195 MB zip, 586 MB unpacked, from `update.code.visualstudio.com/commit:<sha>/server-darwin-arm64/stable`), with `webEndpointUrlTemplate` set to the shell's origin, run as `bin/code-server --port 8081 --without-connection-token --accept-server-license-terms --host 127.0.0.1 --extensions-dir <dir>`. The workbench connected 1.9 s after navigation, the server launched its extension host process, the extension count rose from 15 to 47 (the server's built-ins), and a hand-written Node extension installed in that directory, `extensionKind: ["workspace"]`, registered `remoteProbe.hello` and returned `{"node":"24.18.1","hostname":…,"pid":16417,"remoteName":"localhost:8081"}` when run from the page. Screenshot: `docs/spike/remote-server.png`.

What this means for Pult: the environment host would run VS Code's server (or the VSCodium `reh` build) beside the T3 Code server, pinned to the commit the shell vendors, and the shell would open the environment's projects as `vscode-remote://` folders with full language intelligence from Node extensions there, instead of (or beside) the extension's `pult:` filesystem. That is a server-side feature of the fork, with a licensing question: the Microsoft server binary is for use with VS Code, so the VSCodium build is the one to plan with. Not built.

## Two notes asked for

**Where a Pult extension API would sit.** Two options exist, and they compose. (a) `getExtension('pult.pult').exports`: the extension's `activate()` returns an object, as it already does in development; other extensions in the same host call it. This is the VS Code-native shape for third-party VSIXes and costs nothing. (b) Main-thread commands, as the bridge of question 1: the shell registers `pult-shell.*` commands below the API, and any extension in any host (worker or remote Node) calls them with `executeCommand`, which crosses hosts for free; return values and plain payloads travel. For the API the plan names (run an RPC, fetch, follow a stream, the bound environment), (a) is the public face and (b) is how the shell, which will own the connection, implements it behind the Pult extension. Streams are the only awkward part over commands (no push); the extension's own `EventEmitter` in its exports covers that for (a).

**Open VSX as the gallery.** Yes. `getExtensionGalleryServiceOverride({ webOnly: false })` is loaded and `productConfiguration.extensionsGallery` points at `open-vsx.org` (`src/services.ts`, the shape the demo uses, `itemUrl` is not part of this version's type). The Extensions view is reachable by command. Not exercised tonight beyond loading; installing a VSIX from it in web means web-capable extensions only, and with a remote server the gallery installs Node extensions there, as in VS Code.

## The layout sketch

A strong first opinion, for Anton to react to. Screenshots: `docs/spike/sketch-thread-and-file.png` (a file of the thread's project open beside it), `docs/spike/sketch-pane-and-explorer.png` (the explorer drawer and the thread as a tab).

- **Three columns, left to right: rail, thread, editor.** The rail is the environment's threads by project, the way a mail client lists conversations: status dot, title, age; a `+` for a new thread; the environment and an Explorer toggle at the bottom. The centre is the selected thread, full height, no tabs, with the composer at the bottom. The right is VS Code's editor part, stock, where the thread's citations open. Nothing above or below.
- **The thread is not a tab.** Switching threads swaps the centre; the editor groups keep their files. A thread can also open as a tab in the groups (question 1's pane) for the cases tabs are for: two threads side by side, or a thread next to the file it discusses while another thread is current.
- **VS Code's views are drawers, not furniture.** The explorer, search, outline and timeline come up on Cmd+B between the thread and the editors and go away. No activity bar ever; the command palette is the index of everything else.
- **Pult's look where the shell is Pult's.** The rail and the centre are the page's own CSS, a dark neutral with the coral of the icon for the selected thread and for a working agent. The editor region keeps VS Code's theme; the seam between the two is a one-pixel border, and it should stay visible rather than be papered over.
- **Open questions the sketch raises.** Whether the rail groups by project or by state (working, waiting on you, settled); whether the composer belongs under the thread or floats; how a citation in the thread points into an editor (a hover, a gutter mark, both); and how much of the thread view's chrome (model picker, mode, worktree) moves to the rail's row or a header.
