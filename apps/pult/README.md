# Pult's shell

Pult is a client for coding agents, centred on threads, with editing a convenience. Its shell is VS Code's workbench, vendored through [`@codingame/monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api), in a page of its own, with upstream's thread view (`apps/web`) built in and connected to T3 Code servers, this repository's among them. The page runs no server of its own.

The shell's history started on 2026-10-23 in a repository of its own, archived as [`pult-shell`](https://github.com/ashakirzianov/pult-shell), and continues here. The line before it, a web client and an Electron shell copied from T3 Code, is archived as [`pult-app`](https://github.com/ashakirzianov/pult-app).

## Development

The repository's toolchain: Node 26 and pnpm through `vp`.

```bash
vp i            # at the repository's root
vp dev          # in apps/pult: http://localhost:5190/
```

See [`AGENTS.md`](./AGENTS.md) for the map, how to connect, and the conventions.

## Licence

MIT: see [LICENSE](./LICENSE).
