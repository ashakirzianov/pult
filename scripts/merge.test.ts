import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  checkCopy,
  closure,
  copyDrift,
  hasConflictMarkers,
  importSpecifiers,
  isCode,
  listedEdits,
  merge,
  resolveSpecifier,
} from "./merge.ts";

describe("importSpecifiers", () => {
  it("names every import, type-only and dynamic ones too", () => {
    const source = [
      'import React from "react";',
      'import type { A } from "./a";',
      "import {",
      "  b,",
      "  type C,",
      '} from "../b";',
      'export * from "./c";',
      'export { d } from "~/d";',
      'import "./side.css";',
      'const lazy = import("./lazy");',
      'const wasm = new URL("./x.wasm", import.meta.url);',
      'import model from "./m.glb?url";',
      'const text = "not an import from \\"./nowhere\\"";',
    ].join("\n");
    const specifiers = importSpecifiers(source, "f.ts");
    for (const expected of ["react", "./a", "../b", "./c", "~/d", "./side.css", "./lazy", "./x.wasm", "./m.glb"]) {
      assert.ok(specifiers.includes(expected), expected);
    }
    assert.ok(!specifiers.includes("./nowhere"));
  });

  it("reads a stylesheet's imports and local URLs, not data or remote ones", () => {
    const css =
      '@import "tailwindcss";\n@import "./theme.css";\n.a { background: url(./grain.png); }\n.b { mask: url("data:image/svg+xml,x"); }\n.c { src: url(https://x/y.woff2); }';
    assert.deepStrictEqual(importSpecifiers(css, "f.css"), ["tailwindcss", "./theme.css", "./grain.png"]);
  });
});

describe("resolveSpecifier", () => {
  const files = new Set([
    "thread-view/t3/src/a.ts",
    "thread-view/t3/src/ui/index.tsx",
    "thread-view/t3/src/b.logic.ts",
    "thread-view/t3/src/style.css",
  ]);
  const exists = (file: string) => files.has(file);

  it("resolves relative and `~/` imports by the bundler's suffixes", () => {
    assert.strictEqual(resolveSpecifier("thread-view/t3/src/x/y.ts", "../a", exists),
      "thread-view/t3/src/a.ts");
    assert.strictEqual(resolveSpecifier("thread-view/shell/main.tsx", "../t3/src/ui", exists),
      "thread-view/t3/src/ui/index.tsx");
    assert.strictEqual(resolveSpecifier("thread-view/t3/src/a.ts", "~/b.logic", exists),
      "thread-view/t3/src/b.logic.ts");
    assert.strictEqual(resolveSpecifier("thread-view/t3/src/a.ts", "./style.css", exists),
      "thread-view/t3/src/style.css");
  });

  it("leaves packages and missing files unresolved", () => {
    assert.strictEqual(resolveSpecifier("thread-view/t3/src/a.ts", "react", exists), null);
    assert.strictEqual(resolveSpecifier("thread-view/t3/src/a.ts", "./gone", exists), null);
  });
});

describe("closure", () => {
  const sources: Record<string, string> = {
    "thread-view/shell/main.tsx": 'import "../t3/src/view";',
    "thread-view/shell/runtime.ts": 'import type { R } from "../t3/src/runtime";',
    "thread-view/t3/src/view.tsx":
      'import { runtime } from "./runtime";\nimport font from "./font.woff2?url";',
    "thread-view/t3/src/runtime.ts":
      'import model from "./model.glb?url";\nimport { helper } from "./helper";\nimport "./missing";',
    "thread-view/t3/src/helper.ts": "export const helper = 1;",
    "thread-view/t3/src/font.woff2": "",
    "thread-view/t3/src/model.glb": "",
  };
  const reached = closure({
    roots: ["thread-view/shell/main.tsx", "thread-view/shell/runtime.ts"],
    read: (file) => sources[file]!,
    exists: (file) => file in sources,
    stubs: new Set(["src/runtime.ts"]),
  });

  it("takes source through a stub, which tsc reads, but no asset past it", () => {
    assert.deepStrictEqual([...reached.files].toSorted(), [
      "src/font.woff2",
      "src/helper.ts",
      "src/runtime.ts",
      "src/view.tsx",
    ]);
  });

  it("reports imports that name no file", () => {
    assert.deepStrictEqual(reached.unresolved, ["thread-view/t3/src/runtime.ts: ./missing"]);
  });

  it("tells source from assets", () => {
    assert.strictEqual(isCode("src/a.tsx"), true);
    assert.strictEqual(isCode("src/index.css"), true);
    assert.strictEqual(isCode("src/x.wasm"), false);
  });
});

describe("conflict markers and listed edits", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("finds the markers git merge-file leaves, not a heading's underline", () => {
    assert.strictEqual(hasConflictMarkers("src/a.ts", bytes("<<<<<<< copy\na\n=======\nb\n>>>>>>> pin\n")), true);
    assert.strictEqual(hasConflictMarkers("src/a.ts", bytes("a\n>>>>>>> pin\n")), true);
    assert.strictEqual(hasConflictMarkers("README.md", bytes("Title\n=======\n")), false);
    assert.strictEqual(hasConflictMarkers("src/x.wasm", bytes("<<<<<<< copy\n")), false);
  });

  it("reads EDITS.md's bullets, not its prose", () => {
    const edits =
      "Each edit is a bullet (`` - `src/x.ts`: why ``).\n\n- `src/a.ts`: why\n* `src/b.tsx`: why\n";
    assert.deepStrictEqual([...listedEdits(edits)], ["src/a.ts", "src/b.tsx"]);
  });

  it("names markers, unlisted edits and stale listings", () => {
    const drift = copyDrift({
      files: [
        { file: "src/same.ts", copy: bytes("a"), upstream: bytes("a") },
        { file: "src/edited.ts", copy: bytes("b"), upstream: bytes("a") },
        { file: "src/listed.ts", copy: bytes("b"), upstream: bytes("a") },
        { file: "src/ours.ts", copy: bytes("b"), upstream: undefined },
        { file: "src/index.css", copy: bytes("<<<<<<< copy\n"), upstream: bytes("a") },
        { file: "src/stale.ts", copy: bytes("a"), upstream: bytes("a") },
      ],
      listed: new Set(["src/listed.ts", "src/stale.ts", "src/gone.ts", "src/index.css"]),
    });
    assert.deepStrictEqual(drift.map((line) => line.split(":")[0]), [
      "edited    thread-view/t3/src/edited.ts",
      "edited    thread-view/t3/src/ours.ts",
      "conflict  thread-view/t3/src/index.css",
      "listed    thread-view/t3/src/stale.ts",
      "listed    thread-view/t3/src/gone.ts",
    ]);
  });
});

// A fork with apps/web at two commits, and a checkout of this repo whose copy
// is at the first with two edits: to a file upstream changes too, and to one
// upstream deletes and the entry no longer reaches.
describe("merge", () => {
  const write = (root: string, file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  };
  const read = (root: string, file: string) =>
    NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  const git = (cwd: string, ...args: Array<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd, encoding: "utf8" },
    ).trim();

  const temporary: Array<string> = [];
  const temporaryDir = (prefix: string) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    temporary.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of temporary) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  const setUp = () => {
    const fork = temporaryDir("pult-merge-fork-");
    git(fork, "init", "--quiet");
    write(fork, "apps/web/src/a.ts", "export const a = 1;\n");
    write(fork, "apps/web/src/b.ts", "export const b = 1;\n");
    git(fork, "add", "-A");
    git(fork, "commit", "--quiet", "-m", "one");
    const first = git(fork, "rev-parse", "HEAD");
    write(fork, "apps/web/src/a.ts", "export const a = 2;\n");
    NodeFS.rmSync(NodePath.join(fork, "apps/web/src/b.ts"));
    git(fork, "add", "-A");
    git(fork, "commit", "--quiet", "-m", "two");
    const second = git(fork, "rev-parse", "HEAD");

    const root = temporaryDir("pult-merge-root-");
    write(root, "vendor/t3code/PIN", `${second}\n`);
    write(root, "thread-view/t3/UPSTREAM", `${first}\n`);
    write(root, "thread-view/t3/EDITS.md", "# Edits\n");
    write(root, "thread-view/t3/src/a.ts", "export const a = 3;\n");
    write(root, "thread-view/t3/src/b.ts", "export const b = 3;\n");
    write(root, "thread-view/shell/main.tsx", 'import { a } from "../t3/src/a";\n');
    return { fork, root, first, second };
  };

  it("records the pin only once no conflict markers remain, and keeps an edit upstream deleted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fork, root, first, second } = setUp();
        const copy = (file: string) => `thread-view/t3/${file}`;

        const conflicted = yield* merge(fork, root);
        assert.strictEqual(conflicted._tag, "Merged");
        assert.deepStrictEqual(conflicted.marked, ["src/a.ts"]);
        assert.deepStrictEqual(conflicted._tag === "Merged" && conflicted.kept, [
          { file: "src/b.ts", deletedUpstream: true },
        ]);
        assert.strictEqual(read(root, copy("UPSTREAM")).trim(), first);
        assert.match(read(root, copy("src/a.ts")), /^<{7} copy$/m);
        assert.strictEqual(read(root, copy("src/b.ts")), "export const b = 3;\n");
        assert.deepStrictEqual(
          (yield* checkCopy(fork, root)).map((line) => line.split(/[:(]/)[0]!.trim()),
          [
            `merging   ${copy("MERGING")}`,
            `conflict  ${copy("src/a.ts")}`,
            `edited    ${copy("src/a.ts")}`,
            `edited    ${copy("src/b.ts")}`,
          ],
        );

        // Run again with a marker left, it still records nothing.
        assert.deepStrictEqual((yield* merge(fork, root)).marked, ["src/a.ts"]);
        assert.strictEqual(read(root, copy("UPSTREAM")).trim(), first);

        // Resolved, keeping the copy's side, and both edits listed.
        write(root, copy("src/a.ts"), "export const a = 3;\n");
        write(root, copy("EDITS.md"), "# Edits\n\n- `src/a.ts`: a test\n- `src/b.ts`: a test\n");
        const finished = yield* merge(fork, root);
        assert.deepStrictEqual([finished._tag, finished.marked], ["Finished", []]);
        assert.strictEqual(read(root, copy("UPSTREAM")).trim(), second);
        assert.strictEqual(NodeFS.existsSync(NodePath.join(root, copy("MERGING"))), false);
        assert.deepStrictEqual(yield* checkCopy(fork, root), []);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});
