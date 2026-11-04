import { environmentServer } from "../files/server.ts";
import { parseTranscript, type Transcript, transcriptsFolder } from "./transcript.ts";

/** A transcript as the fold has it: being read, read (`truncated` when the file is longer than the server reads at once), or not. */
export type TranscriptReading =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly transcript: Transcript; readonly truncated: boolean }
  | { readonly status: "failed"; readonly message: string };

/** A Star's fold: open or not, and how many of its newest transcripts it shows while open. */
export interface FoldView {
  readonly open: boolean;
  readonly shown: number;
}

const CLOSED: FoldView = { open: false, shown: 1 };

const views = new Map<string, FoldView>();
const readings = new Map<string, TranscriptReading>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

/**
 * The folds of the Stars' tabs (`fold.tsx`), kept for the page's session
 * apart from the view, which mounts again as a Star's conversation changes:
 * each Star's fold, and the transcripts read, by home and name, each read
 * once and again only when the page rewrites it. For `useSyncExternalStore`,
 * a version that moves on every change.
 */
export const foldStore = {
  version: () => version,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const foldView = (starId: string) => views.get(starId) ?? CLOSED;

/** Opens the fold on its newest transcript, or closes it, forgetting how far it was shown. */
export function setFoldOpen(starId: string, open: boolean): void {
  views.set(starId, open ? { open: true, shown: 1 } : CLOSED);
  changed();
}

/** Shows the next older transcript: Show more. */
export function showOlder(starId: string): void {
  views.set(starId, { open: true, shown: foldView(starId).shown + 1 });
  changed();
}

const keyOf = (environmentId: string, root: string, name: string) => `${environmentId}\n${root}\n${name}`;

export const transcriptReading = (environmentId: string, root: string, name: string) => readings.get(keyOf(environmentId, root, name));

async function read(environmentId: string, root: string, name: string): Promise<TranscriptReading> {
  try {
    const file = await environmentServer(environmentId).readFile({ cwd: root, relativePath: `${transcriptsFolder(environmentId)}/${name}` });
    const transcript = parseTranscript(file.contents);
    return transcript === undefined ? { status: "failed", message: "It is not a transcript." } : { status: "ready", transcript, truncated: file.truncated };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

/** Reads the transcript `name` of the Star's home on `environmentId` at `root`, once. */
export function readTranscript(environmentId: string, root: string, name: string): void {
  const key = keyOf(environmentId, root, name);
  if (readings.has(key)) return;
  readings.set(key, { status: "loading" });
  changed();
  void read(environmentId, root, name).then((reading) => {
    readings.set(key, reading);
    changed();
  });
}

/** Reads a transcript the fold has read again, after the page rewrote it, the old one shown meanwhile. */
export function refreshTranscript(environmentId: string, root: string, name: string): void {
  const key = keyOf(environmentId, root, name);
  if (readings.get(key)?.status !== "ready") return;
  void read(environmentId, root, name).then((reading) => {
    if (reading.status !== "ready") return;
    readings.set(key, reading);
    changed();
  });
}
