import { safeStorage } from "electron";

import { readJson, writeJsonAtomic } from "./files.ts";

/**
 * The workbench's secrets, as main keeps them for `window.pultDesktop.secrets`:
 * one JSON file, each value encrypted by safeStorage (whose key sits in the OS
 * keychain) and base64-encoded, the file rewritten atomically on each change.
 * Every call reads the file afresh, so two windows on one profile do not drop
 * each other's writes. With no encryption on offer it refuses to store rather
 * than write plain text (pult/decisions, `desktop-secrets`). Used only after
 * `app` is ready.
 */
export function openSecretStore(file: string) {
  const load = () => decode(readJson(file), file);
  const save = (values: Map<string, string>) => writeJsonAtomic(file, Object.fromEntries(values));

  return {
    get(key: string): string | undefined {
      const value = load().get(key);
      if (value === undefined) return undefined;
      requireEncryption();
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
    set(key: string, value: string): void {
      requireEncryption();
      const values = load();
      values.set(key, safeStorage.encryptString(value).toString("base64"));
      save(values);
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

function decode(json: unknown, file: string): Map<string, string> {
  if (json === undefined) return new Map();
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`Pult's secrets file is not a JSON object: ${file}`);
  }
  return new Map(Object.entries(json).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
