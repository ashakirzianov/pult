// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO or report sub-millisecond mtimes, and reads spy on native realpath.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});

const injectShortReads = Effect.fn("injectShortReads")(function* (target: string) {
  const native = yield* Effect.promise(() => vi.importActual<typeof NodeFSP>("node:fs/promises"));
  const open = vi.mocked(NodeFSP.open).mockImplementation(async (path, flags, mode) => {
    const handle = await native.open(path, flags, mode);
    if (path === target) {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: (buffer: Uint8Array, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 2), position),
      });
    }
    return handle;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => open.mockImplementation(native.open)));
});

const UNKNOWN_WORKSPACE_PREFIX = "t3code-unknown-workspace-";
const layerKnownWorkspacesTest = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: (cwd) =>
    cwd.includes(UNKNOWN_WORKSPACE_PREFIX)
      ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
      : Effect.void,
});

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(layerKnownWorkspacesTest),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("getMetadata", () => {
    it.effect(
      "reports actual kinds for extensionless files, dotfiles, and dotted directories",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "custom-name", "hello");
          yield* writeTextFile(cwd, ".npmrc", "registry=test");
          yield* fs.makeDirectory(path.join(cwd, "folder.ts"));
          const file = path.join(cwd, "custom-name");
          const result = yield* service.getMetadata({
            paths: [
              file,
              path.join(cwd, ".npmrc"),
              path.join(cwd, "folder.ts"),
              file,
              path.join(cwd, "missing"),
              "relative-path",
            ],
          });
          expect(result.entries).toEqual([
            { kind: "file", byteLength: 5 },
            { kind: "file", byteLength: 13 },
            { kind: "directory" },
            { kind: "file", byteLength: 5 },
            null,
            null,
          ]);
        }),
    );

    it.effect("detects an extensionless script and image without returning their contents", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const script = "#!/usr/bin/env python3\nprint('hello')\n";
        yield* writeTextFile(cwd, "run", script);
        const image = path.join(cwd, "image");
        yield* fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(
          (yield* service.getMetadata({ paths: [path.join(cwd, "run"), image] })).entries,
        ).toEqual([
          { kind: "file", byteLength: script.length, mimeType: "text/x-python" },
          { kind: "file", byteLength: 8, mimeType: "image/png" },
        ]);
      }),
    );

    // A file chip for `file://attacker.test/s/a.ts` in an agent's message sent
    // the Windows user's NTLM credentials to attacker.test as it rendered.
    it.effect("never stats a network path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statted: Array<string> = [];
        const service = yield* WorkspaceFileSystem.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              stat: (requestedPath) => {
                statted.push(requestedPath);
                return fs.stat(requestedPath);
              },
            }),
          ),
          Effect.provide(layerKnownWorkspacesTest),
        );
        const paths = [
          "\\\\attacker.test\\s\\a.ts",
          "//attacker.test/s/a.ts",
          "/\\attacker.test\\s",
        ];
        expect((yield* service.getMetadata({ paths })).entries).toEqual([null, null, null]);
        expect(statted).toEqual([]);
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
          version: (yield* workspaceFileSystem.statEntry({ cwd, relativePath: "src/index.ts" }))
            .version,
        });
      }),
    );

    it.effect("finishes short reads before decoding UTF-8 text", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        const contents = "A café 🐈\n";
        yield* writeTextFile(cwd, "short.txt", contents);
        const target = yield* fs.realPath(`${cwd}/short.txt`);
        yield* injectShortReads(target);
        expect(yield* files.readFile({ cwd, relativePath: "short.txt" })).toEqual({
          relativePath: "short.txt",
          contents,
          byteLength: Buffer.byteLength(contents),
          truncated: false,
          version: expect.any(String),
        });
      }),
    );

    it.effect("rejects binary bytes delivered after an initial short read", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "short.txt", "ab\0cd");
        const target = yield* fs.realPath(`${cwd}/short.txt`);
        yield* injectShortReads(target);
        const error = yield* files.readFile({ cwd, relativePath: "short.txt" }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
          version: (yield* workspaceFileSystem.statEntry({ cwd, relativePath: absolutePath }))
            .version,
        });
      }),
    );

    it.effect("reads ~/ paths from the server home outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const home = yield* makeTempDir;
        yield* writeTextFile(home, ".claude/CLAUDE.md", "# Notes\n");
        yield* writeTextFile(cwd, "~/.claude/CLAUDE.md", "Workspace decoy\n");

        const result = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "~/.claude/CLAUDE.md" })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

        expect(result).toEqual({
          relativePath: "~/.claude/CLAUDE.md",
          contents: "# Notes\n",
          byteLength: 8,
          truncated: false,
          version: expect.any(String),
        });
      }),
    );

    it.effect("gives truncated contents no version to write back over", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.log", "x".repeat(1024 * 1024 + 1));

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.log" });

        expect(result.truncated).toBe(true);
        expect(result.contents).toHaveLength(1024 * 1024);
        expect(result.version).toBeUndefined();
      }),
    );

    it.effect("does not read server state files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(config.secretsDir, "example.bin", "example\n");
        yield* writeTextFile(config.stateDir, "statev2.sqlite", "example\n");

        for (const input of [
          { cwd, relativePath: path.join(config.secretsDir, "example.bin") },
          { cwd: config.stateDir, relativePath: "statev2.sqlite" },
        ]) {
          const error = yield* workspaceFileSystem.readFile(input).pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        }
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
          expect((yield* workspaceFileSystem.getMetadata({ paths: [fifoPath] })).entries).toEqual([
            { kind: "other" },
          ]);
        }),
    );

    it.effect("refuses a network path outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

        const error = yield* workspaceFileSystem
          .readFile({ cwd: "//nas.test/share/project", relativePath: "//attacker.test/s/a.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    // This resolves inside the project, but Windows reads `\\?\` paths as
    // written, so realpath on the raw string signed in to attacker.test.
    it.effect("reads the network path it checked", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.make.pipe(
          Effect.provide(Layer.merge(layerKnownWorkspacesTest, NodePath.layerWin32)),
        );
        // Rejects without touching the filesystem, so a Windows runner never looks the share up.
        const realpath = vi
          .mocked(NodeFSP.realpath)
          .mockClear()
          .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

        yield* workspaceFileSystem
          .readFile({
            cwd: "\\\\?\\UNC\\nas.test\\share\\project",
            relativePath: "\\\\?\\UNC\\attacker.test\\s\\..\\..\\nas.test\\share\\project\\a.md",
          })
          .pipe(Effect.exit);

        expect(realpath.mock.calls.map(([target]) => target)).toEqual([
          "\\\\?\\UNC\\nas.test\\share\\project\\a.md",
        ]);
      }),
    );

    // Resolving `..` before realpath would read beside the link instead of its target.
    // Windows collapses `..` before the filesystem sees a path, so it has no such reads.
    it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
      "reads `..` after a link from the link's target",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir;
          yield* writeTextFile(root, "target/parent.md", "beside the target\n");
          yield* writeTextFile(root, "parent.md", "beside the link\n");
          yield* fs.makeDirectory(path.join(root, "target", "child"));
          yield* fs.symlink(path.join(root, "target", "child"), path.join(root, "link"));

          const result = yield* workspaceFileSystem.readFile({
            cwd: root,
            relativePath: `${root}/link/../parent.md`,
          });

          expect(result.contents).toBe("beside the target\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);

          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          const missingChildError = yield* workspaceFileSystem
            .readFile(
              Object.assign(
                { cwd, relativePath: "linked-dir/missing/t3.json" },
                { allowMissing: true },
              ),
            )
            .pipe(Effect.flip);
          expect(missingChildError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFilePathEscapeError,
          );
        }),
    );

    it.effect("drops a multibyte character split by the read limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const limit = 1024 * 1024;
        const euro = new TextEncoder().encode("€");
        const bytes = new Uint8Array(limit - 1 + euro.length).fill(0x61);
        bytes.set(euro, limit - 1);
        yield* fileSystem.writeFile(path.join(cwd, "large.txt"), bytes);

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.txt" });

        expect(result.truncated).toBe(true);
        expect(result.byteLength).toBe(bytes.length);
        expect(result.contents).toBe("a".repeat(limit - 1));
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );
  });

  describe("statEntry", () => {
    it.effect("describes files and directories relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");
        const nodeStat = NodeFS.statSync(path.join(cwd, "src/index.ts"));

        const file = yield* workspaceFileSystem.statEntry({ cwd, relativePath: "src/index.ts" });
        const directory = yield* workspaceFileSystem.statEntry({ cwd, relativePath: "src" });

        expect(file).toEqual({
          relativePath: "src/index.ts",
          kind: "file",
          symlink: false,
          size: 26,
          mtimeMs: nodeStat.mtimeMs,
          birthtimeMs: nodeStat.birthtimeMs,
          version: expect.any(String),
        });
        expect(directory).toMatchObject({ relativePath: "src", kind: "directory", symlink: false });
      }),
    );

    it.effect.skipIf(!symlinksSupported)("describes a symlink by what it points at", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "docs/guide.md", "# Guide\n");
        yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "linked-docs"));

        const result = yield* workspaceFileSystem.statEntry({
          cwd,
          relativePath: "linked-docs",
        });

        expect(result).toMatchObject({
          relativePath: "linked-docs",
          kind: "directory",
          symlink: true,
        });
      }),
    );

    it.effect("fails with a not-found error for a missing path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .statEntry({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFoundError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath: path.join(cwd, "missing.txt"),
        });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "describes a symlink it will not follow as itself, but nothing through it",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "tree/secret.txt", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "ext"));
          yield* fileSystem.symlink(path.join(outsideDir, "gone"), path.join(cwd, "dangling"));

          const outward = yield* workspaceFileSystem.statEntry({ cwd, relativePath: "ext" });
          const dangling = yield* workspaceFileSystem.statEntry({ cwd, relativePath: "dangling" });
          const through = yield* workspaceFileSystem
            .statEntry({ cwd, relativePath: "ext/tree" })
            .pipe(Effect.flip);
          const underDangling = yield* workspaceFileSystem
            .statEntry({ cwd, relativePath: "dangling/child" })
            .pipe(Effect.flip);

          for (const [entry, relativePath] of [
            [outward, "ext"],
            [dangling, "dangling"],
          ] as const) {
            expect(entry).toMatchObject({ relativePath, kind: "other", symlink: true });
          }
          expect(through).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(underDangling).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFoundError);
        }),
    );

    it.effect("describes the workspace root however its path spells it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        for (const relativePath of ["", ".", "./", "src/.."]) {
          expect(yield* workspaceFileSystem.statEntry({ cwd, relativePath })).toMatchObject({
            relativePath: "",
            kind: "directory",
            symlink: false,
          });
        }
      }),
    );
  });

  describe("createDirectory", () => {
    it.effect("creates a directory and its missing parents, and accepts one that exists", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const created = yield* workspaceFileSystem.createDirectory({
          cwd,
          relativePath: "src/components/ui",
        });
        const again = yield* workspaceFileSystem.createDirectory({ cwd, relativePath: "src" });

        expect(created).toEqual({ relativePath: "src/components/ui" });
        expect(again).toEqual({ relativePath: "src" });
        expect(NodeFS.statSync(path.join(cwd, "src/components/ui")).isDirectory()).toBe(true);
      }),
    );

    it.effect("refuses a path a file already holds", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# Readme\n");

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "README.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathExistsError);
      }),
    );

    it.effect("rejects directories outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "../escape" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(NodeFS.existsSync(path.resolve(cwd, "..", "escape"))).toBe(false);
      }),
    );
  });

  describe("deleteEntry", () => {
    it.effect("deletes files, empty directories, and whole trees when asked", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");
        yield* writeTextFile(cwd, "src/components/button.tsx", "export {};\n");
        yield* fileSystem.makeDirectory(path.join(cwd, "empty"));

        const file = yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "notes.md" });
        const empty = yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "empty" });
        const tree = yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "src",
          recursive: true,
        });

        expect([file, empty, tree]).toEqual([
          { relativePath: "notes.md" },
          { relativePath: "empty" },
          { relativePath: "src" },
        ]);
        expect(NodeFS.readdirSync(cwd)).toEqual([]);
      }),
    );

    it.effect("refuses a directory that is not empty unless asked to recurse", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "src" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceDirectoryNotEmptyError);
        expect(NodeFS.readFileSync(path.join(cwd, "src/index.ts"), "utf8")).toBe("export {};\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("deletes a symlink, not what it points at", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "docs/guide.md", "# Guide\n");
        yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "linked-docs"));

        yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "linked-docs" });

        expect(NodeFS.existsSync(path.join(cwd, "linked-docs"))).toBe(false);
        expect(NodeFS.readFileSync(path.join(cwd, "docs/guide.md"), "utf8")).toBe("# Guide\n");
      }),
    );

    it.effect("fails with a not-found error for a missing path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFoundError);
      }),
    );

    it.effect("rejects the workspace root and paths outside it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");

        const root = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "." })
          .pipe(Effect.flip);
        const outside = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "../" })
          .pipe(Effect.flip);

        expect(root).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(outside).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(NodeFS.readdirSync(cwd)).toEqual(["notes.md"]);
      }),
    );
  });

  describe("renameEntry", () => {
    it.effect("moves files and directories, creating missing parents", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const file = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "notes.md",
          newRelativePath: "docs/archive/notes.md",
        });
        const directory = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src",
          newRelativePath: "lib",
        });

        expect(file).toEqual({ relativePath: "docs/archive/notes.md" });
        expect(directory).toEqual({ relativePath: "lib" });
        expect(NodeFS.readFileSync(path.join(cwd, "docs/archive/notes.md"), "utf8")).toBe(
          "# Notes\n",
        );
        expect(NodeFS.readFileSync(path.join(cwd, "lib/index.ts"), "utf8")).toBe("export {};\n");
        expect(NodeFS.readdirSync(cwd).toSorted()).toEqual(["docs", "lib"]);
      }),
    );

    it.effect("refuses to replace an entry already at the new path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "draft.md", "# Draft\n");
        yield* writeTextFile(cwd, "final.md", "# Final\n");

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, relativePath: "draft.md", newRelativePath: "final.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathExistsError);
        expect(error).toMatchObject({ relativePath: "final.md" });
        expect(NodeFS.readFileSync(path.join(cwd, "draft.md"), "utf8")).toBe("# Draft\n");
        expect(NodeFS.readFileSync(path.join(cwd, "final.md"), "utf8")).toBe("# Final\n");
      }),
    );

    it.effect("renames an entry to another case of its own name", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "readme.md", "# Readme\n");

        yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "readme.md",
          newRelativePath: "README.md",
        });

        expect(NodeFS.readdirSync(cwd)).toEqual(["README.md"]);
      }),
    );

    it.effect("fails with a not-found error for a missing source", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, relativePath: "missing.md", newRelativePath: "found.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFoundError);
      }),
    );

    it.effect("rejects a new path outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, relativePath: "notes.md", newRelativePath: "../notes.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(NodeFS.readdirSync(cwd)).toEqual(["notes.md"]);
      }),
    );
  });

  describe("mutations through symlinks", () => {
    // `ext` inside the workspace points at a directory outside it.
    const makeEscapingLink = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const outside = yield* makeTempDir;
      yield* writeTextFile(outside, "tree/file.txt", "outside\n");
      yield* writeTextFile(cwd, "inside.txt", "inside\n");
      yield* fileSystem.symlink(outside, path.join(cwd, "ext"));
      return { cwd, outside };
    });

    it.effect.skipIf(!symlinksSupported)(
      "refuse to act outside the root through a symlinked directory",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const { cwd, outside } = yield* makeEscapingLink;

          const errors = yield* Effect.forEach(
            [
              workspaceFileSystem.deleteEntry({ cwd, relativePath: "ext/tree", recursive: true }),
              workspaceFileSystem.renameEntry({
                cwd,
                relativePath: "ext/tree/file.txt",
                newRelativePath: "pulled-in.txt",
              }),
              workspaceFileSystem.renameEntry({
                cwd,
                relativePath: "inside.txt",
                newRelativePath: "ext/pushed-out.txt",
              }),
              workspaceFileSystem.createDirectory({ cwd, relativePath: "ext/made/deeper" }),
              workspaceFileSystem.writeFile({
                cwd,
                relativePath: "ext/new/written.txt",
                contents: "x",
              }),
            ],
            Effect.flip,
          );

          for (const error of errors) {
            expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          }
          expect(NodeFS.readdirSync(outside)).toEqual(["tree"]);
          expect(NodeFS.readFileSync(path.join(outside, "tree/file.txt"), "utf8")).toBe(
            "outside\n",
          );
          expect(NodeFS.readFileSync(path.join(cwd, "inside.txt"), "utf8")).toBe("inside\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "write through a symlinked file only when it resolves inside the root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { cwd, outside } = yield* makeEscapingLink;
          yield* fileSystem.symlink(path.join(cwd, "inside.txt"), path.join(cwd, "in-link.txt"));
          yield* fileSystem.symlink(
            path.join(outside, "tree/file.txt"),
            path.join(cwd, "out-link.txt"),
          );

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "in-link.txt",
            contents: "through\n",
          });
          const escaped = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "out-link.txt", contents: "x" })
            .pipe(Effect.flip);

          expect(NodeFS.readFileSync(path.join(cwd, "inside.txt"), "utf8")).toBe("through\n");
          expect(escaped).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(NodeFS.readFileSync(path.join(outside, "tree/file.txt"), "utf8")).toBe(
            "outside\n",
          );
        }),
    );

    // Windows has no O_NOFOLLOW.
    it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
      "refuse to write through a dangling symlink",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { cwd, outside } = yield* makeEscapingLink;
          yield* fileSystem.symlink(path.join(outside, "made.txt"), path.join(cwd, "dangling.txt"));

          yield* fileSystem.symlink(path.join(outside, "made"), path.join(cwd, "dangling"));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.txt", contents: "x" })
            .pipe(Effect.flip);
          const viaAncestor = yield* workspaceFileSystem
            .createDirectory({ cwd, relativePath: "dangling/made" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
          expect(viaAncestor).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
          expect(NodeFS.existsSync(path.join(outside, "made.txt"))).toBe(false);
          expect(NodeFS.existsSync(path.join(outside, "made"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "delete or move a symlink that points outside, not its target",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const { cwd, outside } = yield* makeEscapingLink;

          yield* workspaceFileSystem.renameEntry({
            cwd,
            relativePath: "ext",
            newRelativePath: "links/ext",
          });
          yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "links/ext" });

          expect(NodeFS.readdirSync(path.join(cwd, "links"))).toEqual([]);
          expect(NodeFS.readFileSync(path.join(outside, "tree/file.txt"), "utf8")).toBe(
            "outside\n",
          );
        }),
    );
  });

  describe("mutation guards", () => {
    it.effect("refuse to act outside a known workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: UNKNOWN_WORKSPACE_PREFIX,
        });
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");

        const errors = yield* Effect.forEach(
          [
            workspaceFileSystem.createDirectory({ cwd, relativePath: "docs" }),
            workspaceFileSystem.deleteEntry({ cwd, relativePath: "notes.md" }),
            workspaceFileSystem.renameEntry({
              cwd,
              relativePath: "notes.md",
              newRelativePath: "moved.md",
            }),
          ],
          Effect.flip,
        );

        for (const error of errors) {
          expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
        }
        expect(yield* fileSystem.readDirectory(cwd)).toEqual(["notes.md"]);
      }),
    );

    it.effect("refuse to create inside git's own folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/config", "[core]\n");
        yield* writeTextFile(cwd, "pre-commit", "#!/bin/sh\n");

        const errors = yield* Effect.forEach(
          [
            workspaceFileSystem.createDirectory({ cwd, relativePath: ".git/hooks" }),
            workspaceFileSystem.renameEntry({
              cwd,
              relativePath: "pre-commit",
              newRelativePath: ".git/hooks/pre-commit",
            }),
          ],
          Effect.flip,
        );

        for (const error of errors) {
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        }
        expect(yield* fileSystem.readDirectory(path.join(cwd, ".git"))).toEqual(["config"]);
        expect(yield* fileSystem.exists(path.join(cwd, "pre-commit"))).toBe(true);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("rejects writes outside a known workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: UNKNOWN_WORKSPACE_PREFIX,
        });

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "plan.md", contents: "# nope\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
        expect(yield* fileSystem.readDirectory(cwd)).toEqual([]);
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          version: (yield* workspaceFileSystem.statEntry({
            cwd,
            relativePath: "plans/effect-rpc.md",
          })).version,
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("writes over the version it was given", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Draft\n");
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes.md",
          contents: "# Final\n",
          ...(read.version !== undefined ? { expectedVersion: read.version } : {}),
        });

        expect(NodeFS.readFileSync(path.join(cwd, "notes.md"), "utf8")).toBe("# Final\n");
        expect(result.version).toBe(
          (yield* workspaceFileSystem.statEntry({ cwd, relativePath: "notes.md" })).version,
        );
        expect(result.version).not.toBe(read.version);
      }),
    );

    it.effect("refuses to overwrite a file changed since the version it was given", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* writeTextFile(cwd, "notes.md", "# Draft\n");
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
        // An agent's edit of the same size, given an mtime that differs
        // whatever the clock resolution.
        NodeFS.writeFileSync(absolutePath, "# Agent\n");
        const agentMtimeSeconds = Math.floor(NodeFS.statSync(absolutePath).mtimeMs / 1000) + 5;
        NodeFS.utimesSync(absolutePath, agentMtimeSeconds, agentMtimeSeconds);
        const agentVersion = (yield* workspaceFileSystem.statEntry({
          cwd,
          relativePath: "notes.md",
        })).version;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: "# Human edit\n",
            ...(read.version !== undefined ? { expectedVersion: read.version } : {}),
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileVersionConflictError);
        expect(error).toMatchObject({
          relativePath: "notes.md",
          expectedVersion: read.version,
          actualVersion: agentVersion,
        });
        expect(NodeFS.readFileSync(absolutePath, "utf8")).toBe("# Agent\n");
      }),
    );

    it.effect("refuses to overwrite a change made in the same tick of a coarse clock", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* writeTextFile(cwd, "notes.md", "# Draft\n");
        // A filesystem that keeps whole seconds gives both writes one mtime.
        const tick = Math.floor(NodeFS.statSync(absolutePath).mtimeMs / 1000);
        NodeFS.utimesSync(absolutePath, tick, tick);
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
        NodeFS.writeFileSync(absolutePath, "# Agent edit\n");
        NodeFS.utimesSync(absolutePath, tick, tick);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: "# Human edit\n",
            ...(read.version !== undefined ? { expectedVersion: read.version } : {}),
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileVersionConflictError);
        expect(NodeFS.readFileSync(absolutePath, "utf8")).toBe("# Agent edit\n");
      }),
    );

    it.effect("treats a file deleted since the version it was given as changed", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* writeTextFile(cwd, "notes.md", "# Draft\n");
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
        NodeFS.rmSync(absolutePath);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: "# Human edit\n",
            ...(read.version !== undefined ? { expectedVersion: read.version } : {}),
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileVersionConflictError);
        expect("actualVersion" in error).toBe(false);
        expect(NodeFS.existsSync(absolutePath)).toBe(false);
      }),
    );

    it.effect("refuses a directory as not a file, with or without a version", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* workspaceFileSystem.createDirectory({ cwd, relativePath: "docs" });
        const { version } = yield* workspaceFileSystem.statEntry({ cwd, relativePath: "docs" });

        for (const expectedVersion of [undefined, version]) {
          const error = yield* workspaceFileSystem
            .writeFile({
              cwd,
              relativePath: "docs",
              contents: "# Docs\n",
              ...(expectedVersion !== undefined ? { expectedVersion } : {}),
            })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        }
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("saves over an existing file without rescanning the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export {};\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "src/main.ts",
          contents: "export const edited = true;\n",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "src/main.ts"))).toBe(
          "export const edited = true;\n",
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(WorkspaceFileSystem.layer).pipe(
            Layer.provide(layerKnownWorkspacesTest),
            Layer.provide(WorkspacePaths.layer),
            Layer.provide(
              Layer.mock(WorkspaceEntries.WorkspaceEntries)({
                refresh: () => Effect.die("An overwrite rescanned the workspace."),
                watchWalksIgnoredDirectories: false,
              }),
            ),
          ),
        ),
      ),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects writes through symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "existing.md", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          yield* fileSystem.symlink(
            path.join(outsideDir, "existing.md"),
            path.join(cwd, "linked-file.md"),
          );
          yield* fileSystem.symlink(
            path.join(outsideDir, "missing.md"),
            path.join(cwd, "dangling.md"),
          );

          for (const relativePath of [
            "linked-dir/new.md",
            "linked-dir/nested/new.md",
            "linked-file.md",
          ]) {
            const error = yield* workspaceFileSystem
              .writeFile({ cwd, relativePath, contents: "# nope\n" })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          }
          const danglingError = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(danglingError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFileSystemOperationError,
          );
          expect(danglingError).toMatchObject({ operation: "realpath-target" });

          expect((yield* fileSystem.readDirectory(outsideDir)).toSorted()).toEqual(["existing.md"]);
          expect(yield* fileSystem.readFileString(path.join(outsideDir, "existing.md"))).toBe(
            "outside\n",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through symlinks that stay inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* makeTempDir;
          const cwd = path.join(parentDir, "workspace");
          const cwdAlias = path.join(parentDir, "workspace-alias");
          yield* writeTextFile(cwd, "docs/README.md", "old\n");
          yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
          yield* fileSystem.symlink("docs/README.md", path.join(cwd, "README.md"));
          yield* fileSystem.symlink(cwd, cwdAlias);

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "docs-alias/plans/plan.md",
            contents: "# Plan\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "README.md",
            contents: "new\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: cwdAlias,
            relativePath: "notes.md",
            contents: "notes\n",
          });
          // `..` after a link in cwd is resolved by name, as for the relative path.
          yield* fileSystem.symlink(path.join(cwd, "docs/plans"), path.join(cwd, "plans-alias"));
          yield* workspaceFileSystem.writeFile({
            cwd: `${path.join(cwd, "plans-alias")}${path.sep}..`,
            relativePath: "dotdot.md",
            contents: "dotdot\n",
          });

          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/plans/plan.md"))).toBe(
            "# Plan\n",
          );
          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/README.md"))).toBe("new\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "README.md"))).toBe("docs/README.md");
          expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("notes\n");
          expect(yield* fileSystem.readFileString(path.join(cwd, "dotdot.md"))).toBe("dotdot\n");
        }),
    );

    // On Windows `\` is a separator, so the name cannot exist there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps a backslash in a file name as part of the name",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "a\\b.md", "old\n");

          yield* workspaceFileSystem.writeFile({ cwd, relativePath: "a\\b.md", contents: "new\n" });

          expect(
            (yield* workspaceFileSystem.readFile({ cwd, relativePath: "a\\b.md" })).contents,
          ).toBe("new\n");
          expect(yield* fileSystem.readDirectory(cwd)).toEqual(["a\\b.md"]);
        }),
    );

    it.effect("refuses writes into git's own folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/config", "[core]\n");
        yield* writeTextFile(cwd, ".bare/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/objects/info/packs");
        yield* writeTextFile(cwd, ".bare/refs/heads/main");
        yield* writeTextFile(cwd, ".bare/hooks/pre-push.sample");
        // Only a linked worktree's `.git` file ends the upward check, not any `.git` folder.
        yield* fileSystem.makeDirectory(path.join(cwd, ".bare/hooks/.git"));
        yield* writeTextFile(cwd, ".bare/worktrees/main/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/worktrees/main/commondir", "../..\n");
        if (symlinksSupported) yield* fileSystem.symlink(".git", path.join(cwd, "docs"));

        for (const [folder, relativePath] of [
          [cwd, ".git/config"],
          [cwd, ".git/hooks/pre-commit"],
          [cwd, "sub/.git"],
          [cwd, ".GIT/config"],
          [cwd, ".gıt/config"],
          [cwd, ".git. /config"],
          [cwd, ".git::$INDEX_ALLOCATION/config"],
          [cwd, "GIT~1/config"],
          [path.join(cwd, ".git"), "config"],
          [cwd, ".bare/config"],
          [path.join(cwd, ".bare"), "hooks/post-checkout"],
          [path.join(cwd, ".bare/hooks"), "post-checkout"],
          [path.join(cwd, ".bare/worktrees/main"), "commondir"],
          ...(symlinksSupported ? [[cwd, "docs/config"] as const] : []),
        ] as const) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd: folder, relativePath, contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        }

        expect(yield* fileSystem.readFileString(path.join(cwd, ".git/config"))).toBe("[core]\n");
        expect(yield* fileSystem.exists(path.join(cwd, ".bare/config"))).toBe(false);
        expect((yield* fileSystem.readDirectory(path.join(cwd, ".bare/hooks"))).toSorted()).toEqual(
          [".git", "pre-push.sample"],
        );
        expect(yield* fileSystem.exists(path.join(cwd, "sub"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".bare/worktrees/main/commondir")),
        ).toBe("../..\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses writes through a git config that links to a file outside git's folders",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "shared/config", "[core]\n");
          yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
          yield* fileSystem.symlink("../shared/config", path.join(cwd, ".git/config"));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: ".git/config", contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fileSystem.readFileString(path.join(cwd, "shared/config"))).toBe(
            "[core]\n",
          );
        }),
    );

    it.effect("writes files that sit beside git's folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* makeTempDir;
        const bare = path.join(parentDir, "repo.git");
        yield* writeTextFile(bare, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(bare, "objects/info/packs");
        yield* writeTextFile(bare, "refs/heads/main");
        yield* writeTextFile(bare, "main/.git", `gitdir: ${path.join(bare, "worktrees/main")}\n`);

        for (const [cwd, relativePath] of [
          [path.join(bare, "main"), ".gitignore"],
          [path.join(bare, "main"), ".gitattributes"],
          [path.join(bare, "main"), ".github/workflows/ci.yml"],
          [path.join(bare, "main"), "vendor/lib.git/README.md"],
          [path.join(bare, "main/.github"), "CODEOWNERS"],
          [bare, "main/plan.md"],
        ] as const) {
          yield* workspaceFileSystem.writeFile({ cwd, relativePath, contents: "ok\n" });
          expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("ok\n");
        }
      }),
    );
  });
});
