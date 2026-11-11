import { connection } from "../connection/index.ts";
import { readStarTranscript, type Transcript } from "./plugin.ts";

/** A transcript as the fold has it: being read, read, or not. */
export type TranscriptReading =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly transcript: Transcript }
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
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

/**
 * The folds of the Stars' tabs (`fold.tsx`), kept for the page's session
 * apart from the view, which mounts again as a Star's conversation changes:
 * each Star's fold, and the transcripts read from the Pult plugin's route,
 * by environment, Star and name, each read once and again when the Star's
 * conversation there ends, which may rewrite it. For
 * `useSyncExternalStore`, a version that moves on every change.
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

const keyOf = (environmentId: string, starId: string, name: string) =>
  JSON.stringify([environmentId, starId, name]);

export const transcriptReading = (environmentId: string, starId: string, name: string) =>
  readings.get(keyOf(environmentId, starId, name));

async function read(
  environmentId: string,
  starId: string,
  name: string,
): Promise<TranscriptReading> {
  try {
    const credential = connection.credential(environmentId);
    if (credential === undefined) throw new Error("the page holds no bearer for its environment");
    return { status: "ready", transcript: await readStarTranscript(credential, starId, name) };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

/** Reads the transcript `name` of the Star on `environmentId`, once. */
export function readTranscript(environmentId: string, starId: string, name: string): void {
  const key = keyOf(environmentId, starId, name);
  if (readings.has(key)) return;
  readings.set(key, { status: "loading" });
  changed();
  void read(environmentId, starId, name).then((reading) => {
    readings.set(key, reading);
    changed();
  });
}

/** Reads again every transcript of the Star on `environmentId` the fold has read, as one may have been rewritten; the old ones shown meanwhile. */
export function refreshTranscripts(environmentId: string, starId: string): void {
  for (const [key, reading] of readings) {
    const [environment, star, name] = JSON.parse(key) as [string, string, string];
    if (environment !== environmentId || star !== starId || reading.status !== "ready") continue;
    void read(environmentId, starId, name).then((next) => {
      if (next.status !== "ready") return;
      readings.set(key, next);
      changed();
    });
  }
}
