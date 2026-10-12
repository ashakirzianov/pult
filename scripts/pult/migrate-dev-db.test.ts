import { assert, describe, it } from "vite-plus/test";

import { migrateArgs } from "./migrate-dev-db.ts";

describe("migrateArgs", () => {
  it("targets the checkout's .t3 ahead of the other arguments", () => {
    assert.deepStrictEqual(migrateArgs(["--projects", "3"], "/work/tree/.t3"), [
      "--base-dir",
      "/work/tree/.t3",
      "--projects",
      "3",
    ]);
  });

  it("keeps an explicit --base-dir, in either spelling", () => {
    assert.deepStrictEqual(migrateArgs(["--base-dir", "/tmp/x"], "/work/tree/.t3"), [
      "--base-dir",
      "/tmp/x",
    ]);
    assert.deepStrictEqual(migrateArgs(["--base-dir=/tmp/x"], "/work/tree/.t3"), [
      "--base-dir=/tmp/x",
    ]);
  });
});
