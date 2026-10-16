// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, describe, expect } from "@effect/vitest";
import type { ProjectWatchEntriesEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as WorkspaceTreeWatcher from "./WorkspaceTreeWatcher.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcess.Platform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("lists immediate children including ignored and empty directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "tracked.txt");
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env\ntracked.txt\n");
        yield* writeTextFile(cwd, ".env", "secret=value");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* fileSystem.makeDirectory(path.join(cwd, "empty"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
        expect(root.entries).toEqual(
          expect.arrayContaining([
            { path: ".env", kind: "file", ignored: true },
            { path: "node_modules", kind: "directory", ignored: true },
            { path: "src", kind: "directory" },
            { path: "empty", kind: "directory" },
            { path: "tracked.txt", kind: "file" },
          ]),
        );
        expect(root.entries.some((entry) => entry.path.includes("/"))).toBe(false);
        expect(root.entries.some((entry) => entry.path === ".git")).toBe(false);
        expect(root.truncated).toBe(false);
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "node_modules/pkg" })).toEqual({
          entries: [{ path: "node_modules/pkg/index.js", kind: "file", ignored: true }],
          truncated: false,
        });
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "empty" })).toEqual({
          entries: [],
          truncated: false,
        });
      }),
    );

    it.effect("labels the children of wide folders exactly as git does for each child", () =>
      Effect.gen(function* () {
        // Above 1,000 children, listing first asks whether the whole folder is ignored.
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        yield* writeTextFile(
          cwd,
          ".gitignore",
          "node_modules/\ndist/\n\\[id\\]/\n*.map\nfoo\n!foo/\n",
        );
        yield* Effect.forEach(
          [
            "node_modules",
            "dist",
            "[id]",
            "src",
            ...(platform !== "win32" ? [":foo"] : []),
          ].flatMap((directory) =>
            Array.from({ length: 1001 }, (_, index) => `${directory}/pkg-${index}.js`),
          ),
          (relativePath) => writeTextFile(cwd, relativePath),
          { concurrency: 32, discard: true },
        );
        for (const relativePath of [
          "dist/kept.js",
          "dist/vendored/index.js",
          "i/page.tsx",
          "[id]/page.tsx",
          "src/bundle.map",
        ]) {
          yield* writeTextFile(cwd, relativePath);
        }
        yield* git(cwd, ["add", "-f", "dist/kept.js", "dist/vendored/index.js", "i/page.tsx"]);
        if (platform !== "win32") {
          yield* fileSystem.symlink(path.join(cwd, "src"), path.join(cwd, "node_modules/link"));
        }

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const { directoryPath, ignored, except } of [
          { directoryPath: "node_modules", ignored: true, except: [] },
          // A force-tracked file and a folder holding tracked files stay unignored.
          { directoryPath: "dist", ignored: true, except: ["dist/kept.js", "dist/vendored"] },
          // git reads `[id]/page.tsx` as a pathspec, which matches the tracked `i/page.tsx`.
          { directoryPath: "[id]", ignored: true, except: ["[id]/page.tsx"] },
          { directoryPath: "src", ignored: false, except: ["src/bundle.map"] },
          ...(platform !== "win32"
            ? [
                // git refuses to classify paths beyond a symlink, so nothing there is labelled.
                { directoryPath: "node_modules/link", ignored: false, except: [] },
                // A leading `:` is pathspec magic, so git reads `:foo/pkg-0.js` as `foo/pkg-0.js`,
                // which `!foo/` keeps unignored.
                { directoryPath: ":foo", ignored: false, except: [] },
              ]
            : []),
        ]) {
          const { entries } = yield* workspaceEntries.list({ cwd, directoryPath });
          expect(entries.length, directoryPath).toBeGreaterThan(1000);
          expect(
            entries
              .filter((entry) => (entry.ignored === true) !== ignored)
              .map((entry) => entry.path)
              .toSorted(),
            directoryPath,
          ).toEqual(except);
        }
      }),
    );

    it.effect("lists a host folder and its parent, each from its own root", () =>
      // Folder links outside the workspace browse by passing the host folder as
      // `cwd`; walking up passes the parent. Each stays bounded by its own root.
      Effect.gen(function* () {
        const parent = yield* makeTempDir();
        const path = yield* Path.Path;
        yield* writeTextFile(parent, "linked/notes.md");
        yield* writeTextFile(parent, "sibling/readme.md");
        const linked = path.join(parent, "linked");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.list({ cwd: linked, directoryPath: "" })).toEqual({
          entries: [{ path: "notes.md", kind: "file" }],
          truncated: false,
        });
        const up = yield* workspaceEntries.list({ cwd: parent, directoryPath: "" });
        expect(up.entries.map((entry) => entry.path).toSorted()).toEqual(["linked", "sibling"]);
        const escape = yield* workspaceEntries
          .list({ cwd: linked, directoryPath: "../sibling" })
          .pipe(Effect.flip);
        expect(escape._tag).toBe("WorkspaceEntriesReadDirectoryError");
      }),
    );

    it.effect(
      "rejects directory traversal, git internals, and symlinks outside the workspace",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir();
          const outside = yield* makeTempDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".git/HEAD");
          const platform = yield* HostProcess.Platform;
          if (platform !== "win32") yield* fileSystem.symlink(outside, path.join(cwd, "external"));
          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          for (const directoryPath of [
            "../",
            outside,
            ".git",
            "missing",
            ...(platform !== "win32" ? ["external"] : []),
          ]) {
            const error = yield* workspaceEntries.list({ cwd, directoryPath }).pipe(Effect.flip);
            expect(error._tag).toBe("WorkspaceEntriesReadDirectoryError");
          }
        }),
    );

    it.effect(
      "browses a workspace with more than 25,000 entries without truncation",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (let directory = 0; directory < 26; directory++) {
            const directoryPath = path.join(cwd, `folder-${directory}`);
            yield* fileSystem.makeDirectory(directoryPath);
            yield* Effect.forEach(
              Array.from({ length: 1000 }, (_, i) => i),
              (i) => fileSystem.writeFileString(path.join(directoryPath, `file-${i}.txt`), ""),
              { concurrency: 32, discard: true },
            );
          }
          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
          expect(root.entries).toHaveLength(26);
          expect(root.truncated).toBe(false);
          for (const directory of root.entries) {
            const result = yield* workspaceEntries.list({ cwd, directoryPath: directory.path });
            expect(result.entries).toHaveLength(1000);
            expect(result.truncated).toBe(false);
            expect(result.entries).toContainEqual({
              path: `${directory.path}/file-999.txt`,
              kind: "file",
            });
          }
        }),
      60_000,
    );

    it.effect("includes images and other binary files in non-git workspace indexes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const imagePaths = ["photo.png", "photo.jpg", "photo.jpeg"];
        const binaryPaths = [...imagePaths, "document.pdf", "archive.zip", "data.bin"];
        for (const filePath of binaryPaths) {
          yield* writeTextFile(cwd, filePath, "\0binary contents\n");
        }
        yield* writeTextFile(cwd, "notes.txt", "plain text\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const expectedPaths = [...binaryPaths, "notes.txt"].toSorted();
        const listed = yield* workspaceEntries.list({ cwd });
        expect(listed.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(listed.truncated).toBe(false);

        const searched = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          kind: "file",
        });
        expect(searched.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(searched.truncated).toBe(false);

        const images = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          imageOnly: true,
        });
        expect(images.entries.map((entry) => entry.path).toSorted()).toEqual(imagePaths.toSorted());
        expect(images.truncated).toBe(false);
      }),
    );

    it.effect("returns the complete cached workspace index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "src", kind: "directory" },
            { path: "src/components", kind: "directory" },
            {
              path: "src/components/Composer.tsx",
              kind: "file",
            },
            { path: "README.md", kind: "file" },
          ]),
        );
        expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("search", () => {
    it.effect("returns files and directories relative to cwd", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, ".git/HEAD");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
        expect(paths).toContain("README.md");
        expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("filters and ranks entries by query", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.entries.some((entry) => entry.path === "src/components")).toBe(true);
        expect(result.entries.every((entry) => entry.path.toLowerCase().includes("compo"))).toBe(
          true,
        );
      }),
    );

    it.effect("supports fuzzy subsequence queries for composer path search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
        const paths = result.entries.map((entry) => entry.path);

        expect(result.entries.length).toBeGreaterThan(0);
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
      }),
    );

    it.effect("prioritizes exact basename matches ahead of broader path matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-exact-ranking-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "docs/composer.tsx-notes.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "Composer.tsx", limit: 5 });

        expect(result.entries[0]?.path).toBe("src/components/Composer.tsx");
      }),
    );

    it.effect("tracks truncation without sorting every fuzzy match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-limit-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

        expect(result.entries).toHaveLength(1);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        // Native ranking can put either matching file first.
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe("file");
        expect(["src/index.ts", "src/internal.ts"]).toContain(result.entries[0]?.path);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("answers an empty file-filtered query with a bounded file listing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-empty-query-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "",
          limit: 10,
          kind: "file",
        });

        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toHaveLength(2);
        expect(paths).toContain("src/index.ts");
        expect(paths).toContain("README.md");
        expect(result.entries.every((entry) => entry.kind === "file")).toBe(true);
      }),
    );

    it.effect("returns only directories for the directory filter", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-directory-filter-" });
        yield* writeTextFile(cwd, "src/index.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 10,
          kind: "directory",
        });

        expect(result.entries).toEqual([{ path: "src", kind: "directory" }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("excludes .convex in non-git workspaces", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-non-git-convex-" });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("supports typo-resistant file search through fff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fff-typo-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compoesr", limit: 10 });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "src/components/Composer.tsx" }),
          ]),
        );
      }),
    );

    it.effect("rebuilds the cached index after refresh fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-refresh-failure-" });
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const createSpy = vi.spyOn(FileFinder, "create");
        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(1);

        vi.spyOn(FileFinder.prototype, "scanFiles").mockReturnValueOnce({
          ok: false,
          error: "scan failed",
        });
        yield* workspaceEntries.refresh(cwd);

        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(2);
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("returns content matches with file paths, line numbers, and ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-search-" });
        yield* writeTextFile(
          cwd,
          "src/shapes.ts",
          "export const square = 4;\nexport const Square = 16;\nexport const squareSize = 8;\n",
        );
        yield* writeTextFile(cwd, "src/other.ts", "const circle = true;\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: false,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/shapes.ts", 1],
          ["src/shapes.ts", 2],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 13, end: 19 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("honors case sensitivity and gitignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-ignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "square\nSquare\n");
        yield* writeTextFile(cwd, "ignored.txt", "Square\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ path: "src/keep.ts", lineNumber: 2 });
      }),
    );

    it.effect("filters whole-word matches by word boundaries without widening ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "note notes denote\nfootnote note\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "note",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 0, end: 4 }],
          }),
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 2,
            matchRanges: [{ start: 9, end: 13 }],
          }),
        ]);
      }),
    );

    it.effect("finds later whole-word matches in a file after rejected raw matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-late-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", `${"afoo\n".repeat(10)}foo\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 1,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 11,
            matchRanges: [{ start: 0, end: 3 }],
          }),
        ]);
      }),
    );

    it.effect("treats astral-plane letters as whole word characters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-astral-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "𐐀foo foo foo𐐀\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 6, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("matches punctuation-edged whole-word queries including adjacent occurrences", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "-foo- -foo- -foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "-foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 12, end: 17 },
          ],
        });
      }),
    );

    it.effect("matches punctuation-edged regex queries as whole words", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "foo- foo-\nafoo-b\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: true,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 4 },
            { start: 5, end: 9 },
          ],
        });
      }),
    );

    it.effect("caps matches per file so one dense file cannot fill the page", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-per-file-cap-" });
        yield* writeTextFile(cwd, "src/dense.ts", "needle\n".repeat(300));
        yield* writeTextFile(cwd, "src/other.ts", "needle\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        const byPath = new Map<string, number>();
        for (const match of result.matches) {
          byPath.set(match.path, (byPath.get(match.path) ?? 0) + 1);
        }
        expect(byPath.get("src/dense.ts")).toBe(100);
        expect(byPath.get("src/other.ts")).toBe(1);
      }),
    );

    it.effect("preserves regex escapes during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "Square\nsquare\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "\\SQUARE",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );

    it.effect("preserves invalid regex errors during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-invalid-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "foobar\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo)bar(",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.regexFallbackError).toBeDefined();
        expect(result.matches).toEqual([]);
      }),
    );

    it.effect("maps multi-byte lines to string-indexed ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-multibyte-" });
        yield* writeTextFile(cwd, "src/notes.ts", 'const label = "héllo wörld";\n');

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "wörld",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0]!;
        const range = match.matchRanges[0]!;
        expect(match.lineContent.slice(range.start, range.end)).toBe("wörld");
      }),
    );
  });

  describe("watch", () => {
    // Stands in for the OS watcher, so batching runs without depending on when
    // the OS delivers events: the test offers raw changes to `raw`, and every
    // watcher started reads from it.
    const makeFakeTreeWatcher = Effect.fn(function* () {
      const raw = yield* Queue.unbounded<
        WorkspaceTreeWatcher.WorkspaceTreeChange,
        WorkspaceTreeWatcher.WorkspaceTreeWatchError | Cause.Done
      >();
      const started = yield* Deferred.make<void>();
      const counts = { started: 0, stopped: 0 };
      const watcher = WorkspaceTreeWatcher.WorkspaceTreeWatcher.of({
        walksIgnoredDirectories: false,
        watch: () =>
          Stream.unwrap(
            Effect.acquireRelease(
              Effect.sync(() => (counts.started += 1)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
              ),
              () => Effect.sync(() => (counts.stopped += 1)),
            ).pipe(Effect.as(Stream.fromQueue(raw))),
          ),
      });
      return { raw, started, counts, watcher };
    });

    const withTreeWatcher = (watcher: WorkspaceTreeWatcher.WorkspaceTreeWatcher["Service"]) =>
      Effect.provide(
        Layer.effect(WorkspaceEntries.WorkspaceEntries, WorkspaceEntries.make).pipe(
          Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(Layer.succeed(WorkspaceTreeWatcher.WorkspaceTreeWatcher, watcher)),
        ),
      );

    // Watches `cwd` in the background and collects the batches it sends.
    const startWatch = Effect.fn(function* (cwd: string) {
      const batches = yield* Queue.unbounded<ProjectWatchEntriesEvent>();
      const fiber = yield* Effect.flatMap(WorkspaceEntries.WorkspaceEntries, (workspaceEntries) =>
        workspaceEntries
          .watch({ cwd })
          .pipe(Stream.runForEach((batch) => Queue.offer(batches, batch))),
      ).pipe(Effect.forkScoped);
      return { batches, fiber };
    });

    // Runs `use` against a fresh WorkspaceEntries with one watch on `cwd`,
    // which has subscribed once its watcher starts.
    const withOnlyWatch = <A, E, R>(
      cwd: string,
      use: (watch: {
        readonly raw: Queue.Enqueue<WorkspaceTreeWatcher.WorkspaceTreeChange>;
        readonly batches: Queue.Queue<ProjectWatchEntriesEvent>;
      }) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeTreeWatcher();
        return yield* Effect.gen(function* () {
          const { batches } = yield* startWatch(cwd);
          yield* Deferred.await(fake.started);
          return yield* use({ raw: fake.raw, batches });
        }).pipe(withTreeWatcher(fake.watcher));
      });

    it.effect("reports created, changed and deleted paths as they stand when sent", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "existing.md", "# Before\n");
        yield* writeTextFile(cwd, "notes/new.md", "# New\n");
        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Queue.offerAll(raw, [
            { path: "notes/new.md", rename: true },
            { path: "existing.md", rename: false },
            { path: "gone.md", rename: true },
          ]).pipe(Effect.andThen(Queue.take(batches))),
        );

        expect(batch).toEqual({
          changes: [
            { path: "notes/new.md", kind: "created" },
            { path: "existing.md", kind: "changed" },
            { path: "gone.md", kind: "deleted" },
          ],
          truncated: false,
        });
      }),
    );

    it.effect("reports a moved file or directory as created at its new path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "moved.md", "# Moved\n");
        yield* writeTextFile(cwd, "newdir/inside.md", "# Inside\n");
        // A move keeps a path's birthtime; make it an hour old so only the
        // move can make it new.
        const anHourAgo = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 3600;
        for (const movedPath of ["moved.md", "newdir"]) {
          yield* Effect.promise(() =>
            NodeFSP.utimes(path.join(cwd, movedPath), anHourAgo, anHourAgo),
          );
        }

        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Queue.offerAll(raw, [
            { path: "old.md", rename: true },
            { path: "moved.md", rename: true },
            { path: "olddir", rename: true },
            { path: "newdir", rename: true },
          ]).pipe(Effect.andThen(Queue.take(batches))),
        );

        expect(batch.changes).toEqual([
          { path: "old.md", kind: "deleted" },
          { path: "moved.md", kind: "created" },
          { path: "olddir", kind: "deleted" },
          { path: "newdir", kind: "created" },
        ]);
      }),
    );

    it.effect("reports a deleted child named like the root", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = path.join(yield* makeTempDir(), "proj");
        yield* fileSystem.makeDirectory(cwd);

        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Queue.offerAll(raw, [
            { path: "proj/__init__.py", rename: true },
            { path: "proj", rename: true },
          ]).pipe(Effect.andThen(Queue.take(batches))),
        );

        expect(batch.changes).toEqual([{ path: "proj", kind: "deleted" }]);
      }),
    );

    it.effect("names each path once however often it changed in a burst", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const paths = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
        for (const filePath of paths) yield* writeTextFile(cwd, filePath, "export {};\n");
        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Effect.gen(function* () {
            for (const round of [1, 2, 3]) {
              yield* Queue.offerAll(
                raw,
                paths.map((filePath) => ({ path: filePath, rename: round === 1 })),
              );
            }
            return yield* Queue.take(batches);
          }),
        );
        expect(batch.changes.map((change) => change.path)).toEqual(paths);
        expect(batch.truncated).toBe(false);
      }),
    );

    it.effect("reports a deleted directory without its contents", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/app.ts", "export {};\n");
        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Queue.offerAll(raw, [
            { path: "build/out/a.js", rename: true },
            { path: "build/out", rename: true },
            { path: "build", rename: true },
            { path: "src/app.ts", rename: true },
          ]).pipe(Effect.andThen(Queue.take(batches))),
        );

        expect(batch).toEqual({
          changes: [
            { path: "build", kind: "deleted" },
            { path: "src/app.ts", kind: "created" },
          ],
          truncated: false,
        });
      }),
    );

    it.effect("marks a batch truncated past its path limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const batch = yield* withOnlyWatch(cwd, ({ raw, batches }) =>
          Queue.offerAll(
            raw,
            Array.from({ length: 1_001 }, (_, index) => ({
              path: `gone-${index}.md`,
              rename: true,
            })),
          ).pipe(Effect.andThen(Queue.take(batches))),
        );

        expect(batch.changes).toHaveLength(1_000);
        expect(batch.truncated).toBe(true);
      }),
    );

    it.effect("shares one watcher per root and stops it with its last subscriber", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "shared.md");
        const fake = yield* makeFakeTreeWatcher();
        yield* Effect.gen(function* () {
          const first = yield* startWatch(cwd);
          yield* Deferred.await(fake.started);
          const second = yield* startWatch(cwd);
          // `first` has subscribed; keep changing a path until `second` has
          // subscribed too and reports it.
          const pacer = yield* Queue.offer(fake.raw, { path: "shared.md", rename: false }).pipe(
            Effect.andThen(Queue.take(first.batches)),
            Effect.forever,
            Effect.forkScoped,
          );
          expect((yield* Queue.take(second.batches)).changes).toEqual([
            { path: "shared.md", kind: "changed" },
          ]);
          yield* Fiber.interrupt(pacer);
          expect(fake.counts).toEqual({ started: 1, stopped: 0 });

          yield* Fiber.interrupt(first.fiber);
          expect(fake.counts).toEqual({ started: 1, stopped: 0 });
          yield* Fiber.interrupt(second.fiber);
          expect(fake.counts).toEqual({ started: 1, stopped: 1 });
        }).pipe(withTreeWatcher(fake.watcher));
      }),
    );

    it.effect("ends when the watcher closes and starts a new one for the next subscriber", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const fake = yield* makeFakeTreeWatcher();
        yield* Queue.end(fake.raw);
        yield* Effect.gen(function* () {
          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          expect(yield* Stream.runCollect(workspaceEntries.watch({ cwd }))).toEqual([]);
          expect(yield* Stream.runCollect(workspaceEntries.watch({ cwd }))).toEqual([]);
        }).pipe(withTreeWatcher(fake.watcher));
        expect(fake.counts).toEqual({ started: 2, stopped: 2 });
      }),
    );

    it.effect("fails as subscribing would once its root is gone", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = path.join(yield* makeTempDir(), "proj");
        yield* fileSystem.makeDirectory(cwd);
        const fake = yield* makeFakeTreeWatcher();
        const error = yield* Effect.gen(function* () {
          const { fiber } = yield* startWatch(cwd);
          yield* Deferred.await(fake.started);
          yield* fileSystem.remove(cwd, { recursive: true });
          yield* Queue.end(fake.raw);
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }).pipe(withTreeWatcher(fake.watcher));

        expect(error._tag).toBe("WorkspaceRootNotExistsError");
      }),
    );

    it.effect("fails when the watcher fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const fake = yield* makeFakeTreeWatcher();
        yield* Queue.fail(
          fake.raw,
          new WorkspaceTreeWatcher.WorkspaceTreeWatchError({ root: cwd, cause: "lost" }),
        );

        const error = yield* Effect.flatMap(WorkspaceEntries.WorkspaceEntries, (workspaceEntries) =>
          Stream.runDrain(workspaceEntries.watch({ cwd })),
        ).pipe(withTreeWatcher(fake.watcher), Effect.flip);

        expect(error._tag).toBe("WorkspaceEntriesWatchError");
      }),
    );

    it.effect("fails when the workspace root does not exist", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();

        const error = yield* workspaceEntries
          .watch({ cwd: path.join(cwd, "missing") })
          .pipe(Stream.runDrain, Effect.flip);

        expect(error._tag).toBe("WorkspaceRootNotExistsError");
      }),
    );
  });

  describe("browse", () => {
    it.effect("returns matching directories and excludes files", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-prefix-" });
        yield* writeTextFile(cwd, "alphabet.txt", "ignore me");
        yield* writeTextFile(cwd, "alpha/index.ts", "export {};\n");
        yield* writeTextFile(cwd, "alpine/index.ts", "export {};\n");

        const result = yield* workspaceEntries.browse({
          partialPath: path.join(cwd, "alp"),
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [
            { name: "alpha", fullPath: path.join(cwd, "alpha") },
            { name: "alpine", fullPath: path.join(cwd, "alpine") },
          ],
        });
      }),
    );

    it.effect("shows dot directories in directory mode and hidden-prefix mode", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");
        const cwdWithSeparator = yield* appendSeparator(cwd);

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: cwdWithSeparator,
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${cwdWithSeparator}.c`,
        });

        expect(directoryResult.entries.map((entry) => entry.name)).toEqual([".config", "config"]);
        expect(hiddenPrefixResult).toEqual({
          parentPath: cwd,
          entries: [{ name: ".config", fullPath: path.join(cwd, ".config") }],
        });
      }),
    );

    it.effect("supports relative paths when cwd is provided", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-relative-" });
        yield* writeTextFile(cwd, "packages/pkg.json", "{}");

        const result = yield* workspaceEntries.browse({
          cwd,
          partialPath: "./pack",
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [{ name: "packages", fullPath: path.join(cwd, "packages") }],
        });
      }),
    );

    it.effect("rejects relative paths without cwd", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

        const error = yield* workspaceEntries
          .browse({
            partialPath: "./src",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceEntriesCurrentProjectRequiredError");
        expect(error.message).toBe(
          "A current project is required to browse relative workspace path './src'.",
        );
      }),
    );

    it.effect("returns an empty listing when the OS denies directory access", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-eacces-" });

        const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        vi.mocked(NodeFSP.readdir).mockRejectedValueOnce(denied);

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
        });
        expect(result).toEqual({ parentPath: cwd, entries: [] });
      }),
    );
  });
});
