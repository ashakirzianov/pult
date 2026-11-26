// Bundles main.mjs into dist/hello/ beside its extension.json: `@pult/extension-host` stays
// external, everything else is inlined, and the manifest names the contract and the Effect
// version of the server built from this checkout.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { build } from "esbuild";

// `CONTRACT` in apps/server/src/plugins/contract.ts.
const contract = 1;
const { version } = JSON.parse(
  NodeFS.readFileSync(new URL("package.json", import.meta.url), "utf8"),
);
const server = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const effect = server("effect/package.json").version;
const out = new URL("dist/hello/", import.meta.url);

await build({
  entryPoints: [new URL("main.mjs", import.meta.url).pathname],
  outfile: new URL("main.mjs", out).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@pult/extension-host"],
});
NodeFS.writeFileSync(
  new URL("extension.json", out),
  `${JSON.stringify({ version, contract, effect }, null, 2)}\n`,
);
console.log(`dist/hello/ built: hello ${version}, contract ${contract}, Effect ${effect}`);
