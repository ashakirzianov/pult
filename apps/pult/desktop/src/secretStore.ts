import * as NodeFS from "node:fs";

import { safeStorage } from "electron";

import { readJson, writeJsonAtomic } from "./files.ts";

/**
 * The workbench's secrets, as main keeps them for `window.pultDesktop.secrets`:
 * one JSON file, each value encrypted by safeStorage (whose key sits in the OS
 * keychain) and base64-encoded, the file rewritten atomically on each change.
 * Every call reads the file afresh, so two windows on one profile do not drop
 * each other's writes. A file that does not parse is moved aside to
 * `secrets.json.corrupt` and the store starts empty; a value that does not
 * decrypt reads as absent until it is set again. With no encryption on offer
 * it refuses to store rather than write plain text (pult/decisions,
 * `desktop-secrets`). Used only after `app` is ready.
 */
export function openSecretStore(file: string) {
  const load = () => decode(file);
  const save = (values: Map<string, string>) => writeJsonAtomic(file, Object.fromEntries(values));
  // The keys whose value did not decrypt, so main's stderr says so once per key and run.
  const undecryptable = new Set<string>();

  return {
    get(key: string): string | undefined {
      const value = load().get(key);
      if (value === undefined) return undefined;
      requireEncryption();
      try {
        return safeStorage.decryptString(Buffer.from(value, "base64"));
      } catch (error) {
        if (!undecryptable.has(key)) {
          undecryptable.add(key);
          console.warn(`[pult-desktop] the secret ${JSON.stringify(key)} in ${file} does not decrypt; it reads as absent until it is set again.`, error);
        }
        return undefined;
      }
    },
    set(key: string, value: string): void {
      requireEncryption();
      const values = load();
      values.set(key, safeStorage.encryptString(value).toString("base64"));
      save(values);
      undecryptable.delete(key);
    },
    delete(key: string): void {
      const values = load();
      if (values.delete(key)) save(values);
    },
    keys(): string[] {
      return [...load().keys()];
    },
  };
}

function requireEncryption(): void {
  // Linux's `basic_text` backend encrypts with a key written into Chromium itself, plain text in effect.
  const available =
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  if (!available) {
    throw new Error(
      "Pult cannot keep secrets on this computer: the system keychain is unavailable, and Pult never stores a secret in plain text.",
    );
  }
}

/** The file's sealed values: none while it does not exist, none either once a file that is not a JSON object is moved aside. */
function decode(file: string): Map<string, string> {
  let json: unknown;
  try {
    json = readJson(file);
  } catch (error) {
    // An unreadable file (permissions, say) still fails the call; only one that does not parse is moved aside.
    if (!(error instanceof SyntaxError)) throw error;
    return moveAside(file, error.message);
  }
  if (json === undefined) return new Map();
  if (typeof json !== "object" || json === null || Array.isArray(json)) return moveAside(file, "not a JSON object");
  return new Map(Object.entries(json).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function moveAside(file: string, reason: string): Map<string, string> {
  const aside = `${file}.corrupt`;
  NodeFS.renameSync(file, aside);
  console.warn(`[pult-desktop] ${file} does not parse (${reason}): moved aside to ${aside}; the secrets start empty.`);
  return new Map();
}
