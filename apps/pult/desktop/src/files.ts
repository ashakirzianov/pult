import * as NodeFS from "node:fs";

/** Reads a JSON file of main's under `userData`; `undefined` when it does not exist yet. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes a JSON file whole or not at all: a temporary file beside it, then a rename over it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}
