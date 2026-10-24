# Pult

This repo is **Pult**'s shell: VS Code's workbench, vendored through `@codingame/monaco-vscode-api`, in a Vite page centred on threads, with the Pult extension (`../pult-extension`) built in and connected to a T3 Code Extensible server. It runs no server. It is one repo of the **Pult track** (xaxis `pult/about`), beside `../pult-extension` and the fork `../t3code-extensible`. Cross-track conventions live in `../axis/AGENTS.md`.

- Read xaxis `pult/rfc-0` (human-written, never edited by agents) before anything else, then `pult/rfc-2`, the current direction, and the design on `pult/own-shell`. The track's decisions are xaxis `pult/decisions`; its design principles `pult/taste`.
- The history started fresh on 2026-10-23. The previous line, a web client and an Electron shell, is archived as `ashakirzianov/pult-app`; copy from it by hand when something there is wanted (the vendoring script, the icon renderer, the desktop shell).
- Commits are small and semantically scoped, one logical unit each. **Agents push on their own** (`axis/decisions`, `push-gate`): a push publishes, since the repo is public, and deploys nothing. Never commit secrets, tokens, `.env` files or data copied from `~/.t3`.
- Licence: MIT, upstream's text; it stays.

## Glossary

- **user** means Anton, using Pult to direct coding agents. **agent** means a coding agent run inside a T3 Code thread, which may include you.
- **environment** means one running server and the machine, filesystem and state it owns. **project**, **thread**, **turn** are the server's.
- **workbench** means VS Code's, as the vendored package builds it; a **part** is one of its regions (sidebar, editor part, status bar). The **extension** means the Pult extension, run by the workbench's web worker extension host.

## Where code lives

- `src/main.ts` boots, in order: workers, IndexedDB user data, the workspace file, the connection, the thread pane and its command, the left panel, the extension, the workbench into the page, then the status bar sync and the restored thread selection.
- `src/services.ts` lists the service overrides and the Open VSX gallery; `src/configuration.json` is the shell's settings defaults (chrome off, editor stock); `src/secrets.ts` persists the workbench's secrets, the page's bearer and the extensions' (localStorage, the keychain once there is a desktop wrapper); `src/workers.ts` names the web workers; `src/debug.ts` is the `window.pult` console handle.
- `src/pultExtension.ts` registers the extension as a built-in from its checkout, which `vite/pultExtension.ts` serves file by file (`PULT_EXTENSION_DIR`, or `.env`, default `../pult-extension/extension`). The extension pushes its thread model into the page over the main-thread command `pult-shell.threads` (`src/shellBridge.ts` in the extension, branch `shell-connection` until it lands on its `main`).
- `src/connection/` is the page's one connection (`pult/decisions`, `connection-owner`): the vendored runtime with the environment as its platform registration (`connection.ts`), the probe, the page's platform and its one socket (`platform.ts`, `socket.ts`, `mux.ts`), `pult-shell.connect` and `pult-shell.disconnect` (`commands.ts`, which the extension's Connect and Disconnect defer to), and `bridge.ts`, which offers the connection to the extension over main-thread commands, gated because any extension can run them: HTTP to a route allowlist only, the socket ticket answered with a stand-in, and only requests, acks and interrupts on the socket; the bearer stays in the workbench's secret storage.
- `src/threads/` is the shell-rendered thread: the editor pane (`pane.tsx`, registered with the workbench's own editor registries), which mounts upstream's thread view in-process on the page's connection, as the extension builds it for the shell (its `webview/shell/`, into `dist/shell/`, resolved as `pult-extension/thread-view` by `vite/pultExtension.ts`, and built against the same `vendor/t3code/COMMIT` or refused), and the store the extension fills (`store.ts`).
- `src/threads/selection.ts` is the selected thread and `pult-shell.selectThread`: a switch saves the editor part as the previous thread's editor working set and applies the next one's, keeping the thread tab leftmost. Settings (`pult-shell.selectSettings`, Cmd+,) is a selection of its own, with its own working set.
- `src/threads/statusBar.ts` shows the status bar while a non-thread editor is open, through `workbench.statusBar.visible` in the in-memory configuration layer.
- `src/panel/` is the left panel, the sidebar part: a view container registered with `registerCustomView` holding the React cards and footer (`PanelView.tsx`), and VS Code's stock explorer container swapped in at a thread's or the environment's root by setting the workspace folders, which hold the environment's roots while the cards show too, so files save (`explorer.ts`).
- `src/identity.ts` names Pult; `assets/pult/` holds the brand assets (its README says what is source and what is rendered).
- `vendor/t3code/` holds the fork's `contracts`, `client-runtime` and `shared` at the commit in `vendor/t3code/PIN` as workspace packages, with the fork's patches and its blocks of `pnpm-workspace.yaml` (`pult/decisions`, `protocol-packages-pinned`). Read them, never edit them, those blocks included: a bump is a new PIN, here and in the extension, then `pnpm vendor:sync` and `pnpm i`, and `pnpm vendor:check` fails on drift.
- `scripts/drive.ts` drives the page in headless Chromium; `scripts/vendor.ts` vendors; `scripts/setup-worktree.ts` is what T3 Code runs in a new worktree (`t3.json`).
- Below the extension API: `@codingame/monaco-vscode-workbench-service-override/common` exports `registerEditorPane`, `registerEditorSerializer`, `registerCustomView` and the workbench's services; `@codingame/monaco-vscode-api/vscode/vs/...` reaches VS Code's own modules. Read them in `node_modules/@codingame`, never patch them. A VS Code bump is one version for every `@codingame/*` package at once, plus `monaco-editor` and `vscode` aliases in `package.json`.

## Running

Node 24 and pnpm. The extension must be built (`pnpm i && pnpm build` in its `extension/`); the shell serves it from there.

- `pnpm i`, then `pnpm dev` (`vp dev`: the fork's override makes Vite+'s core the shell's `vite`), then open http://localhost:5190/ (the port is strict; the dev server's allowed origin names it). The first load pre-bundles the workbench for a minute.
- Connect with Cmd+Shift+P, "Pult: Connect to Environment", and a pairing link or `<server>/#token=<token>`. The **live** server (the installed T3 Code Extensible) hands out a pairing link in its Settings, Connections; it accepts bearer tokens from any origin. A **dev** server is `vp run dev` in the fork checkout with `T3CODE_DEV_ALLOWED_ORIGINS=http://localhost:5190`; a session token that opens files comes from `node apps/server/src/bin.ts auth session issue --ttl 7d --json` run there with `T3CODE_HOME` set to the dev home.
- `window.pult` in the console: `status()`, `connection()`, `threads()`, `selected()`, `tabs()`, `exec(command, ...args)`, `commands(prefix)`, `read(uri)`, `bridgedSockets()`, `restartExtensionHost()`. Headless: `node scripts/drive.ts 'wait:5000' 'eval:pult.status()' 'shot:/tmp/shell.png'`; the steps are listed at the top of the file. A development build connects without a prompt from `eval:pult.exec('pult-shell.connect', '<pairing link>')`.
- Stop what you started, by the PID you tracked.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs other dev servers at once. Kill only a PID you captured at spawn.
2. **Writing to the live install.** `~/.t3/userdata` is the live server's database, in use while you work. Never start a server against it, never open it read-write. Connecting the shell to the live server as a client, with a pairing link, is fine: that is what it is for.
3. **Two copies of the workbench.** Vite must see one copy of every `@codingame/*` package: `.npmrc` auto-installs peers, `resolve.dedupe` in `vite.config.ts` pins `vscode`, `react`, `react-dom`, `effect` and the vendored packages (the thread view imports them from the page), and every `@codingame/*` package is at one version. A second copy breaks the workbench's singletons in ways that look like anything else.

## Hit every surface

Before calling work done, walk this list and say which entries applied: the command palette and keybindings (a behaviour reachable from the UI is usually also a command); reverse states (a way in needs a way out and a way to see it); the extension's side (what the shell shows comes from the extension's pushes or the connection the shell owns); docs, where a change makes `AGENTS.md` wrong.

## Verifying

- `pnpm typecheck` for the scope you changed; behaviour through `scripts/drive.ts` against a running dev page, or a browser.
- Test meaningful logic or observable behaviour; do not add tests that mirror the implementation. A test that needs a sleep to pass is wrong.
- **Do not run repo-wide checks** unless asked. There is no CI; the lead integrates by review.
- User-visible changes get one pass in a real browser by the primary agent after integrating. Subagents do not launch their own dev servers unless their task says so.

## Code conventions

The track's design principles are xaxis `pult/taste`. Inferred types over annotations; `any` is the enemy. Comments describe how a thing is used, and move when the code moves. The shell's own UI is React in the page; the workbench's parts are configured and registered into, never patched.
