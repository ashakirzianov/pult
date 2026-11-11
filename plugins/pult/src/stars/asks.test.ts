import { assert, describe, it } from "@effect/vitest";

import { askName, askTitle } from "./asks.ts";

describe("askTitle", () => {
  const table: ReadonlyArray<readonly [text: string, title: string]> = [
    ["# Rust backend\n\nWhich crate?", "Rust backend"],
    ["### Deep heading", "Deep heading"],
    ["Plain first line\nmore", "Plain first line"],
    ["\n\n  \n  ## After blank lines  \n", "After blank lines"],
    ["#NoSpace", "NoSpace"],
    ["Windows line\r\nnext", "Windows line"],
    ["Not a # heading", "Not a # heading"],
    ["---\ntitle: front matter\n---\n", "---"],
    // Nothing left of the line, or no line at all: the name.
    ["###\nbelow", "the-name"],
    ["", "the-name"],
    [" \n\t\n", "the-name"],
  ];
  it.each(table)("titles %j %j", (text, title) =>
    assert.strictEqual(askTitle("the-name", text), title),
  );
});

describe("askName", () => {
  it("is the name of a .md file without it, and none for any other", () => {
    assert.strictEqual(askName("rust-backend.md"), "rust-backend");
    assert.strictEqual(askName(".hidden.md"), ".hidden");
    assert.strictEqual(askName(".md"), undefined);
    assert.strictEqual(askName("notes.txt"), undefined);
    assert.strictEqual(askName("draft.md.swp"), undefined);
  });
});
