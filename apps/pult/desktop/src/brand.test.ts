// Run with `node --test desktop/src/brand.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { brandReleaseUrl, T3CODE_DESKTOP_BRAND } from "../../../desktop/src/app/DesktopBrand.ts";
import brand from "./brand.ts";

NodeTest.describe("pult: desktop brand", () => {
  NodeTest.it("sends startup recovery to Pult's releases, never upstream's", () => {
    const pult = { ...T3CODE_DESKTOP_BRAND, ...brand };
    NodeAssert.equal(pult.releases.page, "https://github.com/ashakirzianov/pult/releases");
    NodeAssert.equal(
      brandReleaseUrl("0.0.2", pult),
      "https://github.com/ashakirzianov/pult/releases/tag/pult-v0.0.2",
    );
  });
});
