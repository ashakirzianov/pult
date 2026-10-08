# Pult

Pult is a third-party client for T3 Code Extensible, a minimal fork of [T3 Code](https://github.com/pingdotgg/t3code). This repo holds a web client (`apps/pult`) and an Electron desktop shell (`apps/pult-desktop`); it has no server of its own, and attaches to a running one.

The current direction is a VS Code extension against stock T3 Code servers, in its own repo, `pult-extension`: see [RFC 1](./docs/pult/rfc-1.md).

## Development

Pult uses [Vite+](https://viteplus.dev/guide/): install the `vp` command-line tool, then the dependencies, and start a dev run.

```bash
curl -fsSL https://vite.plus | bash    # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

A dev run starts the server of a T3 Code Extensible checkout (`PULT_T3CODE_CHECKOUT`, by default `~/repos/t3code-extensible`) from source. See [`docs/operations/development.md`](./docs/operations/development.md) for the details, [`AGENTS.md`](./AGENTS.md) for the repo's map and conventions, and [`docs/pult/`](./docs/pult) for Pult's own docs.

## Licence

MIT, as upstream's: see [LICENSE](./LICENSE).
