# Pult

Pult is a client for coding agents, centred on threads, with editing a convenience. It is VS Code's workbench, vendored through [`@codingame/monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api), in a page of its own, with the [Pult extension](https://github.com/ashakirzianov/pult-extension) built in and connected to a running [T3 Code Extensible](https://github.com/ashakirzianov/t3code-extensible) server. It runs no server of its own.

This history starts on 2026-10-23. The previous line, a web client and an Electron shell copied from T3 Code, is archived as [`pult-app`](https://github.com/ashakirzianov/pult-app).

## Development

Node 24 and pnpm. A built checkout of `pult-extension` beside this one, or named by `PULT_EXTENSION_DIR`.

```bash
pnpm i
pnpm dev        # http://localhost:5190/
```

See [`AGENTS.md`](./AGENTS.md) for the map, how to connect, and the conventions.

## Licence

MIT: see [LICENSE](./LICENSE).
