# Development

## First checkout

Install `vp` as the [root README](../../README.md) says. The checkout requires Node 24. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate a new browser.

## Choosing a dev process

Use `vp run dev` for server and web. `vp run dev:desktop` starts the Electron client, but it still waits for a bundled server that is not in this repo and never opens its window (`pult/desktop-dev-mode`). `dev:server` and `dev:web` start those processes separately. The server is not in this repo: `dev` and `dev:server` run `node --watch apps/server/src/bin.ts` in the T3 Code Extensible checkout that `PULT_T3CODE_CHECKOUT` names (environment or `.env`, by default `~/repos/t3code-extensible`), so that checkout needs its dependencies installed. `vp run migrate-dev-db` seeds this checkout's `.t3` with that checkout's migration script.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`. Add `--browser` to open a browser automatically.

### State and ports

The main checkout and each linked worktree default to their own gitignored `.t3/userdata`, even when `T3CODE_HOME` is set; `~/.pult` is the installed desktop's. An explicit `--home-dir` wins. Never run a development server against the live `~/.t3/userdata`. See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths, but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL for that origin. Give the tester the complete URL, including its token. The dev runner removes its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level. `T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/pult/src/bootstrap.ts) and [Tailwind plugin](../../apps/pult/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports on that hostname. Any service you visit there can receive the reusable admin credential, including services unrelated to Pult. If you run untrusted services on that hostname, keep normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

`scripts/setup-worktree.ts`, which the `t3.json` Setup Worktree action runs and a worktree made by hand runs as `node scripts/setup-worktree.ts`, links that file to each worktree's `.env`. The dev runner reads repository env files at startup and passes the value to the server in web modes, never in `dev:desktop`. `.env.local` and inherited process environment values override `.env`, so no per-worktree export is needed after setup.

For a launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration, then open its printed startup pairing URL once per browser profile on that hostname. Later web dev servers on the same hostname accept the shared cookie across ports. The cookie expires after 30 days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a commit, pull request, or public output. Each dev server hashes the value and seeds its own auth database record at startup; servers share no SQLite data, signing keys, environment IDs, sessions, pairing grants or revocation state, so a local revocation persists across restarts and does not affect another worktree. Removing or rotating the value and restarting invalidates the old credential and its WebSocket tickets. A rejected normal credential never falls back to the reusable one. Desktop and non-dev servers ignore the value.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Run the full suite only when asked.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then unused runtime exports in `apps/pult-desktop`, `apps/pult` and `packages/pult`. Exported types and Effect schemas are allowed without consumers. The schema preprocessor recognizes schema types, including aliases and schema classes; functions that create or decode schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit `@public` annotation, which Knip recognizes. Completely unused files remain checked too. Named exports in web UI component modules are kept as complete component sets. Knip ignores unused exports in `apps/pult/src/components/ui/*.tsx`, while still reporting an entire unused file. Use `vp run knip --workspace apps/pult` to audit one workspace, including exports, or `vp run knip:production --workspace apps/pult` to find code kept alive only by tests. Review callers before deleting code; production mode can also report development scripts and test fixtures. Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

How a build reaches Anton is [`docs/pult/install.md`](../pult/install.md). Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage` to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust. For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**. Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive passed as `--wsl-runtime`.

### Signing and passkeys

Add `--signed` after configuring the platform credentials. macOS passkeys need a signed, provisioned app.
