import { assert, describe, it } from "@effect/vitest";

import { channelTag, isChannel, taggedChannel } from "./channels.ts";

describe("channels", () => {
  it("are slugs of lowercase letters, digits and hyphens, from a letter or a digit, up to 51", () => {
    for (const slug of ["user", "work", "unit-2", "2026-wave", "a".repeat(51)])
      assert.isTrue(isChannel(slug), slug);
    for (const slug of ["", "-work", "Work", "unit_2", "unit 2", "a".repeat(52)])
      assert.isFalse(isChannel(slug), slug);
    // The longest slug leaves its tag within upstream's 64 characters.
    assert.strictEqual(channelTag("a".repeat(51)).length, 64);
  });

  it("are read from the first channel tag that names a slug, none without one", () => {
    assert.strictEqual(taggedChannel(undefined), undefined);
    assert.strictEqual(taggedChannel(["pult:child:star:abc", "review"]), undefined);
    assert.strictEqual(taggedChannel(["pult:work"]), undefined);
    assert.strictEqual(
      taggedChannel(["pult:channel:Bad", "pult:channel:unit-2", "pult:channel:unit-3"]),
      "unit-2",
    );
  });
});
