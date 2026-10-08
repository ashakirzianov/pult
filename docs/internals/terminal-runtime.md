# Terminal runtime

The environment server owns PTYs, session lifetime, and retained output. Pult's client, web and desktop alike, attaches through the environment connection, which lets it reconnect to or share a running session. Renderer choices stay local to the client and do not change terminal contracts.

## Output

Terminal history is incremental: live events carry only new chunks, and snapshots are the materialization boundary. The client's terminal buffer is capped at 512 KiB in the vendored [terminal output state](../../vendor/t3code/packages/client-runtime/src/state/terminalOutput.ts), separately from the server's own retention. Measure throughput with full scrollback when changing this path.

## Renderer ownership

The web client drives the official `libghostty-vt` C ABI, compiled to WebAssembly, from the [Ghostty adapter](../../apps/pult/src/terminal/ghostty/README.md). The adapter owns drawing and input integration, and React stays out of terminal frames. It shares one WebAssembly instance per browser tab while each terminal owns and frees its own handles. The canonical pin is [`native/libghostty-vt/VERSION`](../../native/libghostty-vt/VERSION); the artifacts must be rebuilt when it changes. The wasm embeds the revision in its build info so the ABI test can detect drift without a second pin.

Restoring scrollback must not send terminal replies to the current shell. Historical device queries can otherwise provoke fresh replies that appear as junk at the prompt. The server strips query/response traffic from retained history, and the [web renderer](../../apps/pult/src/terminal/ghostty/core.ts) detaches its PTY writer during replay. Preserve the renderer's half when changing renderer code.
