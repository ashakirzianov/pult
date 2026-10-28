// Run with `node --test src/files/files.test.ts`.
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type {
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectWatchEntriesEvent,
} from "@t3tools/contracts";

import {
  type Change,
  type Features,
  FilesError,
  type Stat,
  type WatchListener,
  WorkspaceFiles,
  type WorkspaceServer,
} from "./files.ts";

const STOCK: Features = {
  fileVersions: false,
  entryMutations: false,
  watchEntries: false,
  fileAssets: false,
};
const CAPABLE: Features = {
  fileVersions: true,
  entryMutations: true,
  watchEntries: true,
  fileAssets: true,
};
const READ_LIMIT = 64;

/** A host filesystem behind the project RPCs, with the server's failures as tagged errors. */
class FakeServer implements WorkspaceServer {
  readonly files = new Map<
    string,
    { contents: string; bytes: Uint8Array; version: number; mtime: number }
  >();
  readonly directories = new Set<string>();
  readonly ignored = new Set<string>();
  /** Paths that are symlinks, which the server's listing leaves out. */
  readonly symlinks = new Set<string>();
  readonly writes: Array<{ path: string; expectedVersion: string | undefined }> = [];
  readonly watchers = new Map<string, { listener: WatchListener; disposed: boolean }>();
  private nextVersion = 1;
  enabled: Features;

  constructor(enabled: Features) {
    this.enabled = enabled;
  }

  /**
   * The host, or an agent, changing a file behind the client's back. Its mtime
   * moves on unless given, as `cp -p` or a coarse clock may leave it.
   */
  put(path: string, contents: string, mtime?: number) {
    this.putBytes(path, new TextEncoder().encode(contents), mtime);
  }

  /** A file the server reads as its readFile does: UTF-8, leniently, dropping a BOM. */
  putBytes(path: string, bytes: Uint8Array, mtime?: number) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
      this.directories.add(parent);
    }
    const contents = new TextDecoder("utf-8").decode(bytes);
    const version = this.nextVersion++;
    this.files.set(path, { contents, bytes, version, mtime: mtime ?? version });
  }

  features = async () => this.enabled;

  listEntries = async ({ cwd, directoryPath = "" }: ProjectListEntriesInput) => {
    const directory = resolve(cwd, directoryPath);
    if (!this.directories.has(directory)) {
      throw failure("ProjectListEntriesError", "directory_list_failed");
    }
    const children = [...this.directories, ...this.files.keys()]
      .filter((path) => dirname(path) === directory && !this.symlinks.has(path))
      .map((path): ProjectEntry => ({
        path: path.slice(cwd.length + 1),
        kind: this.directories.has(path) ? "directory" : "file",
        ignored: this.ignored.has(path),
      }));
    return { entries: children, truncated: false };
  };

  /** How a read of a missing file fails: a stock server says only that the operation did. */
  missingReadFailure = "path_not_found";

  readFile = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    const path = resolve(cwd, relativePath);
    const file = this.files.get(path);
    if (file === undefined) throw failure("ProjectReadFileError", this.missingReadFailure);
    if (file.contents.includes("\0")) throw failure("ProjectReadFileError", "binary_file");
    const truncated = file.bytes.length > READ_LIMIT;
    return {
      relativePath,
      contents: file.contents.slice(0, READ_LIMIT),
      byteLength: file.bytes.length,
      truncated,
      ...(this.enabled.fileVersions && !truncated ? { version: `v${file.version}` } : {}),
    };
  };

  statEntry = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    const path = resolve(cwd, relativePath);
    const file = this.files.get(path);
    if (file === undefined && !this.directories.has(path)) {
      throw failure("ProjectStatEntryError", "path_not_found");
    }
    return {
      relativePath,
      kind: file === undefined ? ("directory" as const) : ("file" as const),
      symlink: false,
      size: file?.bytes.length ?? 0,
      mtimeMs: file?.mtime ?? 0,
      birthtimeMs: 0,
      version: `v${file?.version ?? 0}`,
    };
  };

  writeFile = async (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    expectedVersion?: string | undefined;
  }) => {
    const path = resolve(input.cwd, input.relativePath);
    this.writes.push({ path, expectedVersion: input.expectedVersion });
    const current = this.files.get(path);
    if (
      this.enabled.fileVersions &&
      input.expectedVersion !== undefined &&
      input.expectedVersion !== `v${current?.version}`
    ) {
      throw failure("ProjectWriteFileError", "version_conflict");
    }
    this.put(path, input.contents);
    const version = this.enabled.fileVersions ? `v${this.files.get(path)?.version}` : undefined;
    return { relativePath: input.relativePath, ...(version === undefined ? {} : { version }) };
  };

  createDirectory = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    this.directories.add(resolve(cwd, relativePath));
    return { relativePath };
  };

  deleteEntry = async (input: {
    cwd: string;
    relativePath: string;
    recursive?: boolean | undefined;
  }) => {
    const path = resolve(input.cwd, input.relativePath);
    const below = [...this.files.keys(), ...this.directories].filter((key) =>
      key.startsWith(`${path}/`),
    );
    if (below.length > 0 && input.recursive !== true) {
      throw failure("ProjectDeleteEntryError", "directory_not_empty");
    }
    for (const key of [path, ...below]) {
      this.files.delete(key);
      this.directories.delete(key);
    }
    return { relativePath: input.relativePath };
  };

  renameEntry = async (input: { cwd: string; relativePath: string; newRelativePath: string }) => {
    const from = resolve(input.cwd, input.relativePath);
    const to = resolve(input.cwd, input.newRelativePath);
    const file = this.files.get(from);
    if (file === undefined) throw failure("ProjectRenameEntryError", "path_not_found");
    if (this.files.has(to)) throw failure("ProjectRenameEntryError", "path_exists");
    this.files.delete(from);
    this.files.set(to, file);
    return { relativePath: input.newRelativePath };
  };

  searchEntries = async () => ({ entries: [], truncated: false });
  searchContents = async () => ({ matches: [], truncated: false });

  readAsset = async (cwd: string, relativePath: string) => {
    const file = this.files.get(resolve(cwd, relativePath));
    if (file === undefined) throw failure("AssetError", "path_not_found");
    return file.bytes;
  };

  watchEntries = (cwd: string, listener: WatchListener) => {
    const watcher = { listener, disposed: false };
    this.watchers.set(cwd, watcher);
    return { dispose: () => void (watcher.disposed = true) };
  };
}

function failure(tag: string, kind: string) {
  return { _tag: tag, failure: kind, message: `${tag}: ${kind}` };
}

function resolve(cwd: string, relativePath: string) {
  if (relativePath.startsWith("/")) return relativePath;
  return relativePath === "" || relativePath === "." ? cwd : `${cwd}/${relativePath}`;
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

const ROOT = "/repo";
const OTHER_PROJECT = "/elsewhere";

function setup(enabled: Features, open: Array<string> = []) {
  const server = new FakeServer(enabled);
  server.directories.add(ROOT);
  server.directories.add(OTHER_PROJECT);
  server.put(`${ROOT}/src/a.ts`, "export const a = 1;\n");
  return { server, ...openWindow(server, open) };
}

/** A window's files over `server`; another window over the same server is a reload. */
function openWindow(server: FakeServer, open: Array<string>) {
  const changes: Array<Change> = [];
  const decorated: Array<string> = [];
  const readOnly: Array<[string, string]> = [];
  const files = new WorkspaceFiles(
    server,
    {
      roots: () => [ROOT],
      knownRoots: () => [ROOT, OTHER_PROJECT],
      openPaths: () => open,
      changed: (list) => void changes.push(...list),
      decorated: (paths) => void decorated.push(...paths),
      openedReadOnly: (path, reason) => void readOnly.push([path, reason]),
    },
    () => 1_000,
  );
  return { files, changes, decorated, readOnly };
}

const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const SAVE = { create: true, overwrite: true };

/**
 * VS Code's own guard on a save: it refuses, offering Compare and Overwrite,
 * when the file stats newer than when the editor read it and at another size.
 */
function vscodeRefusesSave(read: Stat, now: Stat) {
  return read.mtime < now.mtime && read.size !== now.size;
}

async function rejection(promise: Promise<unknown>): Promise<FilesError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(error instanceof FilesError))
    throw new Error(`Expected a FilesError, got ${String(error)}`);
  return error;
}

afterEach(() => {
  mock.timers.reset();
});

describe("WorkspaceFiles on a stock server", () => {
  it("round-trips an edit, overwriting without a version", async () => {
    const { server, files, changes } = setup(STOCK);
    assert.equal(decode(await files.readFile(`${ROOT}/src/a.ts`)), "export const a = 1;\n");
    const before = await files.stat(`${ROOT}/src/a.ts`);

    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);

    assert.equal(server.files.get(`${ROOT}/src/a.ts`)?.contents, "export const a = 2;\n");
    assert.deepEqual(server.writes, [{ path: `${ROOT}/src/a.ts`, expectedVersion: undefined }]);
    // VS Code's own modified-since check sees its write as the newest.
    assert.ok((await files.stat(`${ROOT}/src/a.ts`)).mtime > before.mtime);
    assert.deepEqual(changes, [{ path: `${ROOT}/src/a.ts`, kind: "changed" }]);
  });

  it("synthesizes a stat from the parent's listing, greying ignored entries", async () => {
    const { server, files, decorated } = setup(STOCK);
    server.put(`${ROOT}/dist/out.js`, "");
    server.ignored.add(`${ROOT}/dist`);

    assert.partialDeepStrictEqual(await files.stat(ROOT), { kind: "directory", readonly: false });
    assert.partialDeepStrictEqual(await files.stat(`${ROOT}/src/a.ts`), { kind: "file", size: 0 });
    const listed = await files.readDirectory(ROOT);
    assert.ok(listed.some(([name, kind]) => name === "src" && kind === "directory"));
    assert.ok(listed.some(([name, kind]) => name === "dist" && kind === "directory"));
    assert.equal(files.isIgnored(`${ROOT}/dist`), true);
    assert.deepEqual(decorated, [`${ROOT}/dist`]);
    assert.equal((await rejection(files.stat(`${ROOT}/src/gone.ts`))).code, "FileNotFound");
  });

  it("stats a known root and what is under it before the root is a folder", async () => {
    const { files, server } = setup(STOCK);
    server.directories.add(`${OTHER_PROJECT}/lib`);
    server.put(`${OTHER_PROJECT}/lib/x.ts`, "x");
    assert.equal((await files.stat(OTHER_PROJECT)).kind, "directory");
    assert.equal((await files.stat(`${OTHER_PROJECT}/lib`)).kind, "directory");
    assert.equal((await files.stat(`${OTHER_PROJECT}/lib/x.ts`)).kind, "file");
  });

  it("reads a missing file as not found when the server fails the read as an operation", async () => {
    const { files, server } = setup(STOCK);
    server.missingReadFailure = "operation_failed";
    assert.equal((await rejection(files.readFile(`${ROOT}/src/gone.ts`))).code, "FileNotFound");
    assert.equal(decode(await files.readFile(`${ROOT}/src/a.ts`)), "export const a = 1;\n");
  });

  it("refuses to create, move or delete entries", async () => {
    const { server, files } = setup(STOCK);
    const refusals = await Promise.all([
      rejection(files.writeFile(`${ROOT}/src/new.ts`, text(""), SAVE)),
      rejection(files.createDirectory(`${ROOT}/lib`)),
      rejection(files.delete(`${ROOT}/src/a.ts`, { recursive: false })),
      rejection(files.rename(`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`)),
      rejection(files.copy(`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, { overwrite: false })),
    ]);
    assert.deepEqual(refusals.map((error) => error.code), [
      "NoPermissions",
      "NoPermissions",
      "NoPermissions",
      "NoPermissions",
      "NoPermissions",
    ]);
    assert.deepEqual([...server.files.keys()], [`${ROOT}/src/a.ts`]);
  });

  it("refreshes an open file an agent changed at turn end, and only that one", async () => {
    const open = [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`];
    const { server, files, changes } = setup(STOCK, open);
    server.put(`${ROOT}/src/b.ts`, "b\n");
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/b.ts`);
    const before = await files.stat(`${ROOT}/src/a.ts`);

    server.put(`${ROOT}/src/a.ts`, "export const a = 3;\n");
    await files.refresh(ROOT);

    // An unchanged open file is not reported, so a dirty one meets no spurious conflict.
    assert.deepEqual(changes, [{ path: `${ROOT}/src/a.ts`, kind: "changed" }]);
    assert.ok((await files.stat(`${ROOT}/src/a.ts`)).mtime > before.mtime);
    assert.equal((await files.stat(`${ROOT}/src/b.ts`)).mtime, before.mtime);
  });

  it("reports an open file deleted on the host at turn end", async () => {
    const { server, files, changes } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.files.delete(`${ROOT}/src/a.ts`);
    await files.refresh(ROOT);
    assert.deepEqual(changes, [{ path: `${ROOT}/src/a.ts`, kind: "deleted" }]);
  });

  it("has VS Code refuse a stale save after a turn end, but not after its own write", async () => {
    const { server, files } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    const written = await files.stat(`${ROOT}/src/a.ts`);
    assert.equal(vscodeRefusesSave(read, written), true);
    assert.equal(vscodeRefusesSave(written, await files.stat(`${ROOT}/src/a.ts`)), false);

    // An agent changes the file, same size, while the editor is dirty.
    server.put(`${ROOT}/src/a.ts`, "export const a = 9;\n");
    await files.refresh(ROOT);
    assert.equal(vscodeRefusesSave(written, await files.stat(`${ROOT}/src/a.ts`)), true);
  });

  it("never stats a file deleted and made again as it was before", async () => {
    const { server, files } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    server.files.delete(`${ROOT}/src/a.ts`);
    await files.refresh(ROOT);
    server.put(`${ROOT}/src/a.ts`, "export const a = 1;\n");
    assert.equal(vscodeRefusesSave(read, await files.stat(`${ROOT}/src/a.ts`)), true);
  });

  it("stats and saves a symlinked file, which the listing leaves out", async () => {
    const path = `${ROOT}/src/link.ts`;
    const { server, files } = setup(STOCK, [path]);
    server.put(path, "linked\n");
    server.symlinks.add(path);

    assert.partialDeepStrictEqual(await files.stat(path), { kind: "file", readonly: false });
    await files.readFile(path);
    await files.writeFile(path, text("edited\n"), SAVE);

    assert.equal(server.files.get(path)?.contents, "edited\n");
    assert.equal((await rejection(files.stat(`${ROOT}/src/gone.ts`))).code, "FileNotFound");
  });

  it("cannot read a binary file", async () => {
    const { server, files } = setup(STOCK);
    server.put(`${ROOT}/logo.png`, "\0PNG");
    assert.equal((await rejection(files.readFile(`${ROOT}/logo.png`))).code, "Unavailable");
  });
});

describe("WorkspaceFiles on either server", () => {
  for (const [name, enabled] of [
    ["stock", STOCK],
    ["capable", CAPABLE],
  ] as const) {
    it(`refuses writes outside the known roots and of non-UTF-8 bytes (${name})`, async () => {
      const { server, files } = setup(enabled);
      server.put(`${OTHER_PROJECT}/x.ts`, "x");

      // A file of another project, outside the folders, reads and writes against that project's root.
      assert.equal(decode(await files.readFile(`${OTHER_PROJECT}/x.ts`)), "x");
      assert.equal((await files.stat(`${OTHER_PROJECT}/x.ts`)).readonly, false);
      await files.writeFile(`${OTHER_PROJECT}/x.ts`, text("y"), SAVE);
      assert.equal(decode(await files.readFile(`${OTHER_PROJECT}/x.ts`)), "y");
      // A path under no known root is refused.
      assert.equal((await rejection(files.writeFile(`/nowhere/x.ts`, text("y"), SAVE))).code, "NoPermissions");
      const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
      assert.equal((await rejection(files.writeFile(`${ROOT}/src/a.ts`, latin1, SAVE))).code, "NoPermissions");
      // The one write that went through is the other project's, against its own root.
      assert.deepEqual(server.writes.map((write) => write.path), [`${OTHER_PROJECT}/x.ts`]);
    });

    it(`opens a truncated file read-only and never writes it back (${name})`, async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { server, files, changes, readOnly } = setup(enabled, [`${ROOT}/big.txt`]);
      server.put(`${ROOT}/big.txt`, "x".repeat(READ_LIMIT * 2));

      assert.equal((await files.readFile(`${ROOT}/big.txt`)).length, READ_LIMIT);
      assert.deepEqual(readOnly, [[`${ROOT}/big.txt`, "truncated"]]);
      mock.timers.runAll();
      // The open editor re-stats, and the stat says read-only.
      assert.deepEqual(changes, [{ path: `${ROOT}/big.txt`, kind: "changed" }]);
      assert.equal((await files.stat(`${ROOT}/big.txt`)).readonly, true);
      assert.equal((await rejection(files.writeFile(`${ROOT}/big.txt`, text("x"), SAVE))).code, "NoPermissions");
      assert.deepEqual(server.writes, []);
    });
  }
});

describe("WorkspaceFiles on either server, a file the server cannot read back exactly", () => {
  for (const [name, enabled] of [
    ["stock", STOCK],
    ["capable", CAPABLE],
  ] as const) {
    it(`opens Latin-1 and BOM files read-only and never writes them back (${name})`, async () => {
      const { server, files, readOnly } = setup(enabled);
      server.putBytes(`${ROOT}/latin1.txt`, new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
      server.putBytes(`${ROOT}/bom.txt`, new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));

      for (const path of [`${ROOT}/latin1.txt`, `${ROOT}/bom.txt`]) {
        await files.readFile(path);
        assert.equal((await files.stat(path)).readonly, true);
        assert.equal((await rejection(files.writeFile(path, text("a"), SAVE))).code, "NoPermissions");
      }
      assert.deepEqual(readOnly, [
        [`${ROOT}/latin1.txt`, "lossy"],
        [`${ROOT}/bom.txt`, "lossy"],
      ]);
      assert.deepEqual(server.writes, []);
    });
  }
});

describe("WorkspaceFiles copying on a server with the fork's features", () => {
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
  const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);

  it("copies a file it cannot read back exactly from its bytes, or refuses it", async () => {
    const { server, files, changes } = setup(CAPABLE);
    server.putBytes(`${ROOT}/bom.txt`, BOM);
    server.put(`${ROOT}/big.txt`, "é".repeat(READ_LIMIT));
    server.putBytes(`${ROOT}/latin1.txt`, LATIN1);
    server.put(`${ROOT}/logo.png`, "\0PNG");

    await files.copy(`${ROOT}/bom.txt`, `${ROOT}/bom 2.txt`, { overwrite: false });
    await files.copy(`${ROOT}/big.txt`, `${ROOT}/big 2.txt`, { overwrite: false });
    await files.copy(`${ROOT}/logo.png`, `${ROOT}/logo 2.png`, { overwrite: false });
    const refused = await rejection(
      files.copy(`${ROOT}/latin1.txt`, `${ROOT}/latin1 2.txt`, { overwrite: false }),
    );

    assert.deepEqual(server.files.get(`${ROOT}/bom 2.txt`)?.bytes, BOM);
    assert.equal(server.files.get(`${ROOT}/big 2.txt`)?.contents, "é".repeat(READ_LIMIT));
    assert.equal(server.files.get(`${ROOT}/logo 2.png`)?.contents, "\0PNG");
    assert.match(refused.message, /not UTF-8 text/);
    assert.equal(server.files.has(`${ROOT}/latin1 2.txt`), false);
    assert.deepEqual(changes.map((change) => change.path), [
      `${ROOT}/bom 2.txt`,
      `${ROOT}/big 2.txt`,
      `${ROOT}/logo 2.png`,
    ]);
  });

  it("refuses to copy a truncated or non-UTF-8 file where the server cannot send its bytes", async () => {
    const { server, files } = setup({ ...CAPABLE, fileAssets: false });
    server.putBytes(`${ROOT}/bom.txt`, BOM);
    server.put(`${ROOT}/big.txt`, "x".repeat(READ_LIMIT * 2));

    for (const name of ["bom.txt", "big.txt"]) {
      const error = await rejection(
        files.copy(`${ROOT}/${name}`, `${ROOT}/copy-${name}`, { overwrite: false }),
      );
      assert.match(error.message, /cannot send Pult its bytes/);
    }
    assert.deepEqual(server.writes, []);
  });

  it("copies a folder with everything in it, but never into itself", async () => {
    const { server, files } = setup(CAPABLE);
    server.put(`${ROOT}/src/lib/b.ts`, "b");

    await files.copy(`${ROOT}/src`, `${ROOT}/copy`, { overwrite: false });

    assert.equal(server.files.get(`${ROOT}/copy/a.ts`)?.contents, "export const a = 1;\n");
    assert.equal(server.files.get(`${ROOT}/copy/lib/b.ts`)?.contents, "b");
    assert.equal((await rejection(files.copy(`${ROOT}/src`, `${ROOT}/src/inner`, { overwrite: false }))).code, "NoPermissions");
    assert.equal(
      (await rejection(files.copy(`${ROOT}/src/a.ts`, `${ROOT}/copy/a.ts`, { overwrite: false }))).code,
      "FileExists",
    );
  });
});

describe("WorkspaceFiles on a server with the fork's features", () => {
  it("has VS Code refuse a save over a same-size change, and lets its Overwrite through", async () => {
    const { server, files } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 9;\n");

    // VS Code stats before it writes; the size it sees differs, so it refuses.
    assert.equal(vscodeRefusesSave(read, await files.stat(`${ROOT}/src/a.ts`)), true);
    // Overwrite: VS Code stats again and writes over the agent's version.
    await files.stat(`${ROOT}/src/a.ts`);
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    assert.equal(server.files.get(`${ROOT}/src/a.ts`)?.contents, "export const a = 2;\n");
  });

  it("has VS Code refuse a save over a same-size change whose mtime is no newer", async () => {
    const path = `${ROOT}/src/a.ts`;
    const open: Array<string> = [];
    const { server, files } = setup(CAPABLE, open);
    // VS Code's load stats and reads, then the document is open.
    const loaded = await files.stat(path);
    await files.readFile(path);
    open.push(path);

    // `cp -p`, `rsync -t`, `tar x` or a coarse clock: the agent's version stats no newer.
    server.put(path, "export const a = 9;\n", loaded.mtime);
    assert.equal(vscodeRefusesSave(loaded, await files.stat(path)), true);
  });

  it("has VS Code refuse a save when its first stat saw a newer version than its read", async () => {
    const path = `${ROOT}/src/a.ts`;
    const open: Array<string> = [];
    const { server, files } = setup(CAPABLE, open);
    // VS Code's first open stats and reads at once: the read answers, an agent writes, then the stat.
    await files.readFile(path);
    server.put(path, "export const a = 9;\n");
    const loaded = await files.stat(path);
    open.push(path);

    assert.equal(vscodeRefusesSave(loaded, await files.stat(path)), true);
  });

  it("has VS Code refuse a save after an agent wrote between its write and the stat after it", async () => {
    const path = `${ROOT}/src/a.ts`;
    const { server, files } = setup(CAPABLE, [path]);
    await files.readFile(path);
    await files.stat(path);
    await files.writeFile(path, text("export const a = 2;\n"), SAVE);
    server.put(path, "export const a = 9;\n");
    const written = await files.stat(path);

    assert.equal(vscodeRefusesSave(written, await files.stat(path)), true);
  });

  it("has VS Code refuse a save of an editor restored from before a reload", async () => {
    const path = `${ROOT}/src/a.ts`;
    const { server, files } = setup(CAPABLE);
    // The dirty editor's stat, recorded by the window before the reload.
    const recorded = await files.stat(path);
    await files.readFile(path);
    server.put(path, "export const a = 9;\n", recorded.mtime);

    const reloaded = openWindow(server, [path]).files;
    assert.equal(vscodeRefusesSave(recorded, await reloaded.stat(path)), true);
    // Overwrite: VS Code stats again and writes over the agent's version.
    await reloaded.stat(path);
    await reloaded.writeFile(path, text("export const a = 2;\n"), SAVE);
    assert.equal(server.files.get(path)?.contents, "export const a = 2;\n");
  });

  it("writes over the version it served, not the one it last stat'd", async () => {
    const path = `${ROOT}/src/a.ts`;
    const { server, files } = setup(CAPABLE);
    await files.readFile(path);
    server.put(path, "export const a = 'agent';\n");
    await files.stat(path);

    const error = await rejection(files.writeFile(path, text("export const a = 'user';\n"), SAVE));

    assert.match(error.message, /changed on the host since Pult read it/);
    assert.equal(server.files.get(path)?.contents, "export const a = 'agent';\n");
  });

  it("fails a save over a change made after VS Code's last stat", async () => {
    const { server, files } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.stat(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 'agent';\n");
    const error = await rejection(
      files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 'user';\n"), SAVE),
    );
    assert.match(error.message, /changed on the host since Pult read it/);
    assert.equal(server.files.get(`${ROOT}/src/a.ts`)?.contents, "export const a = 'agent';\n");
  });

  it("round-trips an edit under the version it read, then the one it wrote", async () => {
    const { server, files } = setup(CAPABLE);
    const version = () => `v${server.files.get(`${ROOT}/src/a.ts`)?.version}`;
    await files.readFile(`${ROOT}/src/a.ts`);
    const read = version();
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    const written = version();
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 3;\n"), SAVE);

    assert.equal(server.files.get(`${ROOT}/src/a.ts`)?.contents, "export const a = 3;\n");
    assert.deepEqual(server.writes.map((write) => write.expectedVersion), [read, written]);
  });

  it("fails a save over a file changed since it was read, keeping the change", async () => {
    const { server, files } = setup(CAPABLE);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 'agent';\n");

    const error = await rejection(
      files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 'user';\n"), SAVE),
    );

    assert.match(error.message, /changed on the host since Pult read it/);
    assert.equal(server.files.get(`${ROOT}/src/a.ts`)?.contents, "export const a = 'agent';\n");
  });

  it("stats through statEntry", async () => {
    const { server, files } = setup(CAPABLE);
    const stat = await files.stat(`${ROOT}/src/a.ts`);
    assert.partialDeepStrictEqual(stat, { kind: "file", size: 20, readonly: false });
    assert.equal(stat.mtime, server.files.get(`${ROOT}/src/a.ts`)?.version);
    assert.equal((await files.stat(ROOT)).kind, "directory");
  });

  it("creates, moves and deletes entries", async () => {
    const { server, files, changes } = setup(CAPABLE);
    await files.writeFile(`${ROOT}/src/b.ts`, text("b"), { create: true, overwrite: false });
    assert.equal(
      (await rejection(files.writeFile(`${ROOT}/src/b.ts`, text("b"), { create: true, overwrite: false }))).code,
      "FileExists",
    );
    await files.rename(`${ROOT}/src/b.ts`, `${ROOT}/src/c.ts`);
    await files.createDirectory(`${ROOT}/lib`);
    assert.equal((await rejection(files.delete(`${ROOT}/src`, { recursive: false }))).code, "Unknown");
    await files.delete(`${ROOT}/src`, { recursive: true });

    assert.deepEqual([...server.files.keys()], []);
    assert.equal(server.directories.has(`${ROOT}/lib`), true);
    assert.deepEqual(changes, [
      { path: `${ROOT}/src/b.ts`, kind: "created" },
      { path: `${ROOT}/src/b.ts`, kind: "deleted" },
      { path: `${ROOT}/src/c.ts`, kind: "created" },
      { path: `${ROOT}/lib`, kind: "created" },
      { path: `${ROOT}/src`, kind: "deleted" },
    ]);
  });

  it("refuses a name the server would trim to another", async () => {
    const { server, files } = setup(CAPABLE);
    server.put(`${ROOT}/foo`, "kept");
    const refusals = await Promise.all([
      rejection(files.writeFile(`${ROOT}/foo `, text("new"), SAVE)),
      rejection(files.createDirectory(`${ROOT}/ lib`)),
      rejection(files.rename(`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts\t`)),
      rejection(files.delete(`${ROOT}/foo `, { recursive: false })),
    ]);
    assert.deepEqual(refusals.map((error) => [error.code, error.message.includes("trims")]), [
      ["NoPermissions", true],
      ["NoPermissions", true],
      ["NoPermissions", true],
      ["NoPermissions", true],
    ]);
    assert.equal(server.files.get(`${ROOT}/foo`)?.contents, "kept");
    assert.deepEqual(server.writes, []);
  });

  it("never deletes, moves or writes a workspace folder itself", async () => {
    const { files } = setup(CAPABLE);
    assert.equal((await rejection(files.delete(ROOT, { recursive: true }))).code, "NoPermissions");
    assert.equal((await rejection(files.rename(ROOT, "/moved"))).code, "NoPermissions");
  });

  it("reads a binary file's bytes over the asset route", async () => {
    const { server, files } = setup(CAPABLE);
    server.put(`${ROOT}/logo.png`, "\0PNG");
    assert.equal(decode(await files.readFile(`${ROOT}/logo.png`)), "\0PNG");
  });

  it("watches each folder once, reporting its changes", async () => {
    const { server, files, changes } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    await files.syncWatches();
    await files.syncWatches();
    const watcher = server.watchers.get(ROOT);
    if (watcher === undefined) throw new Error("The folder is not watched.");
    assert.equal(server.watchers.size, 1);

    // Changes around the subscription may be missed: open files are re-stat'd.
    await watcher.listener.subscribed();
    const event: ProjectWatchEntriesEvent = {
      changes: [
        { path: "src/a.ts", kind: "changed" },
        { path: "src/new.ts", kind: "created" },
      ],
      truncated: false,
    };
    watcher.listener.changed(event);

    assert.deepEqual(changes, [
      { path: `${ROOT}/src/a.ts`, kind: "changed" },
      { path: `${ROOT}/src/a.ts`, kind: "changed" },
      { path: `${ROOT}/src/new.ts`, kind: "created" },
    ]);
  });

  it("keeps a file's protection when the watch sees it deleted and made again", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const path = `${ROOT}/src/a.ts`;
    const big = `${ROOT}/big.txt`;
    const open: Array<string> = [];
    const { server, files } = setup(CAPABLE, open);
    server.put(big, "x".repeat(READ_LIMIT * 2));
    await files.syncWatches();
    const watcher = server.watchers.get(ROOT);
    if (watcher === undefined) throw new Error("The folder is not watched.");
    const loaded = await files.stat(path);
    await files.readFile(path);
    await files.readFile(big);
    open.push(path, big);

    // `git checkout`, or `rm` and a write: each file goes and comes back, the same size.
    for (const [changed, contents] of [
      [path, "export const a = 9;\n"],
      [big, "y".repeat(READ_LIMIT * 2)],
    ] as const) {
      server.files.delete(changed);
      watcher.listener.changed({
        changes: [{ path: changed.slice(ROOT.length + 1), kind: "deleted" }],
        truncated: false,
      });
      server.put(changed, contents);
      watcher.listener.changed({
        changes: [{ path: changed.slice(ROOT.length + 1), kind: "created" }],
        truncated: false,
      });
    }

    // A write VS Code did not check, as an extension's, still expects the version read.
    const conflict = await rejection(files.writeFile(path, text("export const a = 2;\n"), SAVE));
    assert.match(conflict.message, /changed on the host since Pult read it/);
    assert.equal(vscodeRefusesSave(loaded, await files.stat(path)), true);
    assert.equal((await files.stat(big)).readonly, true);
    assert.equal((await rejection(files.writeFile(big, text("x"), SAVE))).code, "NoPermissions");
    assert.deepEqual(server.writes, [{ path, expectedVersion: "v1" }]);

    // Gone for good: a new file at the path is not the one read.
    server.files.delete(big);
    watcher.listener.changed({ changes: [{ path: "big.txt", kind: "deleted" }], truncated: false });
    await files.writeFile(big, text("new"), { create: true, overwrite: false });
    assert.equal(server.files.get(big)?.contents, "new");
  });

  it("marks a folder gone from the host and stops watching it", async () => {
    const { server, files, changes, decorated } = setup(CAPABLE);
    await files.syncWatches();
    server.watchers.get(ROOT)?.listener.gone();

    assert.equal(files.isGone(ROOT), true);
    assert.deepEqual(decorated, [ROOT]);
    assert.deepEqual(changes, [{ path: ROOT, kind: "deleted" }]);
    assert.equal(server.watchers.get(ROOT)?.disposed, true);
    server.watchers.clear();
    await files.syncWatches();
    assert.equal(server.watchers.size, 0);
  });

  it("stops watching where the server does not advertise it", async () => {
    const { server, files } = setup(CAPABLE);
    await files.syncWatches();
    server.enabled = { ...CAPABLE, watchEntries: false };
    await files.syncWatches();
    assert.equal(server.watchers.get(ROOT)?.disposed, true);
  });
});
