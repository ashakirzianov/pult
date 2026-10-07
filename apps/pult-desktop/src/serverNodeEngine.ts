/**
 * The Node range the server's `package.json` declares in `engines.node`. The
 * server is not in this repo, so its manifest cannot be imported; the desktop
 * checks a remote or WSL Node against this before it runs the server from source.
 */
export const SERVER_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";
