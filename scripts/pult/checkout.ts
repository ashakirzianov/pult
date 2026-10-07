// @effect-diagnostics nodeBuiltinImport:off - resolves a path before an Effect runtime exists.
//
// The checkout of T3 Code Extensible that Pult vendors its protocol packages
// from (scripts/pult/vendor.ts) and whose server the dev modes run
// (scripts/dev-runner.ts): PULT_T3CODE_CHECKOUT, from the environment or .env,
// by default ~/repos/t3code-extensible.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { loadRepoEnv } from "../lib/public-config.ts";

export const T3CODE_CHECKOUT_VARIABLE = "PULT_T3CODE_CHECKOUT";
const DEFAULT_CHECKOUT = "~/repos/t3code-extensible";

/** The fork checkout named by PULT_T3CODE_CHECKOUT (environment or .env), or the default. */
export function t3codeCheckoutPath(): string {
  const raw = loadRepoEnv()[T3CODE_CHECKOUT_VARIABLE]?.trim() || DEFAULT_CHECKOUT;
  return NodePath.resolve(raw.replace(/^~(?=$|[/\\])/, NodeOS.homedir()));
}
