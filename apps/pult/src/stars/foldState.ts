import type { AssistantCitation } from "@t3tools/contracts";

import type { RevealOutcome } from "../../view/passageReveal.ts";
import { connection } from "../connection/index.ts";
import { pluginFeatures } from "./about.ts";
import { CHANNEL_HISTORY_FEATURE } from "./plugin.ts";
import { starById } from "./model.ts";
import {
  readStarChannelTranscripts,
  readStarTranscript,
  readStarTranscriptOfThread,
  type Transcript,
} from "./plugin.ts";
import { drawnHome } from "./stars.ts";

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
/** A fold the user has not touched: open on its newest transcript, as one click on it leaves it. */
const OPENED: FoldView = { open: true, shown: 1 };

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

export const foldView = (starId: string) => views.get(starId) ?? OPENED;

/** Opens the fold on its newest transcript, or closes it, forgetting how far it was shown, and giving up a passage being brought into view. */
export function setFoldOpen(starId: string, open: boolean): void {
  views.set(starId, open ? OPENED : CLOSED);
  if (!open) reveals.get(starId)?.finish("cancelled");
  changed();
}

/** Shows the next older transcript: Show more. */
export function showOlder(starId: string): void {
  views.set(starId, { open: true, shown: foldView(starId).shown + 1 });
  changed();
}

const keyOf = (environmentId: string, starId: string, name: string, channel?: string) =>
  JSON.stringify([environmentId, starId, name, channel ?? null]);

export const transcriptReading = (
  environmentId: string,
  starId: string,
  name: string,
  channel?: string,
) => readings.get(keyOf(environmentId, starId, name, channel));

/** A transcript of the Star the fold has read, and its name. */
export interface NamedReading {
  readonly name: string;
  readonly transcript: Transcript;
}

/** The transcript the fold has read of the Star on `environmentId` whose conversation was the thread `threadId`. */
export function heldTranscriptOf(
  environmentId: string,
  starId: string,
  threadId: string,
): NamedReading | undefined {
  for (const [key, reading] of readings) {
    const [environment, star, name, channel] = JSON.parse(key) as [
      string,
      string,
      string,
      string | null,
    ];
    if (
      environment === environmentId &&
      star === starId &&
      channel === null &&
      reading.status === "ready" &&
      reading.transcript.threadId === threadId
    )
      return { name, transcript: reading.transcript };
  }
  return undefined;
}

/**
 * The transcript of the Star on `environmentId` whose conversation was the thread `threadId`:
 * the one the fold has read, else the plugin's lookup by thread, kept as the fold's reading of
 * its name; undefined where the Star has none, its plugin is older than the lookup, or the
 * lookup fails.
 */
export async function lookUpTranscriptOf(
  environmentId: string,
  starId: string,
  threadId: string,
): Promise<NamedReading | undefined> {
  const held = heldTranscriptOf(environmentId, starId, threadId);
  if (held !== undefined) return held;
  const credential = connection.credential(environmentId);
  if (credential === undefined) return undefined;
  try {
    const { name, ...transcript } = await readStarTranscriptOfThread(credential, starId, threadId);
    readings.set(keyOf(environmentId, starId, name), { status: "ready", transcript });
    changed();
    return { name, transcript };
  } catch {
    return undefined;
  }
}

/** A cited passage the fold of a Star is bringing into view: in the reply `messageId` of the transcript `name`. */
export interface PendingReveal {
  readonly name: string;
  readonly messageId: string;
  readonly citation: AssistantCitation;
  readonly signal: AbortSignal;
  /** Ends it; unshown, the fold and its scroller go back to how they were while the reader has not changed the fold since. */
  readonly finish: (outcome: RevealOutcome) => void;
}

const reveals = new Map<string, PendingReveal>();
/** Per Star, the fold's way to keep where the reader is, as a restorer of it (`fold.tsx`). */
const places = new Map<string, () => () => void>();

/** The fold of the Star keeps where its reader is through `keep`, while it is in a timeline. */
export function keepFoldPlace(starId: string, keep: (() => () => void) | undefined): void {
  if (keep === undefined) places.delete(starId);
  else places.set(starId, keep);
}

export const pendingReveal = (starId: string) => reveals.get(starId);

/**
 * Brings the citation's passage into view in the Star's fold (`fold.tsx`): with its reply in
 * `found`, a transcript of the home it is drawn from, the fold opened and shown down to that
 * transcript, keeping a deeper showing, its conversations between read as Show more reads them.
 * Unshown, opening nothing, where the transcript names no reply of the citation's message (one
 * written before transcripts named them, or a tool's line), or the Star's names lack it.
 * Cancelled by `signal`, a newer reveal, or the fold closed.
 */
export function revealInFold(
  starId: string,
  found: NamedReading,
  citation: AssistantCitation,
  signal: AbortSignal,
): Promise<RevealOutcome> {
  const star = starById(starId);
  const names = (star === undefined ? undefined : drawnHome(star))?.conversations ?? [];
  const index = names.indexOf(found.name);
  const named = found.transcript.entries.some(
    (entry) => entry.kind === "star" && entry.messageId === citation.messageId,
  );
  if (signal.aborted) return Promise.resolve("cancelled");
  if (index === -1 || !named) return Promise.resolve("unshown");
  const before = foldView(starId);
  const opened: FoldView = {
    open: true,
    shown: Math.max(before.open ? before.shown : 0, names.length - index),
  };
  reveals.get(starId)?.finish("cancelled");
  const place = places.get(starId)?.();
  views.set(starId, opened);
  return new Promise((resolve) => {
    const finish = (outcome: RevealOutcome) => {
      if (reveals.get(starId) !== reveal) return;
      reveals.delete(starId);
      signal.removeEventListener("abort", cancel);
      if (outcome === "unshown" && views.get(starId) === opened) {
        views.set(starId, before);
        place?.();
      }
      changed();
      resolve(outcome);
    };
    const cancel = () => finish("cancelled");
    const reveal: PendingReveal = {
      name: found.name,
      messageId: citation.messageId,
      citation,
      signal,
      finish,
    };
    reveals.set(starId, reveal);
    signal.addEventListener("abort", cancel);
    changed();
  });
}

async function read(
  environmentId: string,
  starId: string,
  name: string,
  channel?: string,
): Promise<TranscriptReading> {
  try {
    const credential = connection.credential(environmentId);
    if (credential === undefined) throw new Error("the page holds no bearer for its environment");
    return {
      status: "ready",
      transcript: await readStarTranscript(credential, starId, name, channel),
    };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

/** Reads the transcript `name` of the Star on `environmentId`, once. */
export function readTranscript(
  environmentId: string,
  starId: string,
  name: string,
  channel?: string,
): void {
  const key = keyOf(environmentId, starId, name, channel);
  if (readings.has(key)) return;
  readings.set(key, { status: "loading" });
  changed();
  void read(environmentId, starId, name, channel ?? undefined).then((reading) => {
    readings.set(key, reading);
    changed();
  });
}

/** Each channel tab's transcripts' names, by environment, Star and channel, as the plugin listed them last. */
const channelNames = new Map<string, ReadonlyArray<string>>();
/** How many folds show each channel now, by the same key: only those are listed again. */
const channelFolds = new Map<string, number>();
/** Each channel's latest listing asked for, so an earlier one answering late is dropped. */
const channelListings = new Map<string, number>();
let listings = 0;
const channelKeyOf = (environmentId: string, starId: string, channel: string) =>
  JSON.stringify([environmentId, starId, channel]);

/** The names of the transcripts of a channel's tab's fold, oldest first; none until listed. */
export const channelTranscriptNames = (environmentId: string, starId: string, channel: string) =>
  channelNames.get(channelKeyOf(environmentId, starId, channel)) ?? [];

/**
 * Lists the transcripts of the Star's `channel` on `environmentId` as its tab's fold mounts, and
 * again while it is mounted as the directory's watch tells of one written
 * (`refreshChannelTranscriptNames`); the names listed last shown meanwhile, and kept where a
 * listing fails. What it returns stops following, as the fold unmounts.
 */
export function followChannelTranscriptNames(
  environmentId: string,
  starId: string,
  channel: string,
): () => void {
  const key = channelKeyOf(environmentId, starId, channel);
  channelFolds.set(key, (channelFolds.get(key) ?? 0) + 1);
  listChannel(environmentId, starId, channel);
  return () => {
    const left = (channelFolds.get(key) ?? 1) - 1;
    if (left > 0) channelFolds.set(key, left);
    else channelFolds.delete(key);
  };
}

function listChannel(environmentId: string, starId: string, channel: string): void {
  const key = channelKeyOf(environmentId, starId, channel);
  const credential = connection.credential(environmentId);
  if (credential === undefined) return;
  listings += 1;
  const listing = listings;
  channelListings.set(key, listing);
  void readStarChannelTranscripts(credential, starId, channel).then(
    (names) => {
      if (channelListings.get(key) !== listing) return;
      if (names.join("\n") === channelNames.get(key)?.join("\n")) return;
      channelNames.set(key, names);
      changed();
    },
    (error: unknown) =>
      console.warn(
        `[pult-shell] could not list the transcripts of ${starId}'s channel ${channel}: ${errorMessage(error)}`,
      ),
  );
}

/** Lists again every channel of the Star on `environmentId` a mounted fold shows. */
export function refreshChannelTranscriptNames(environmentId: string, starId: string): void {
  for (const key of channelFolds.keys()) {
    const [environment, star, channel] = JSON.parse(key) as [string, string, string];
    if (environment === environmentId && star === starId)
      listChannel(environmentId, starId, channel);
  }
}

/** Reads again every transcript of the Star on `environmentId` the fold has read, as one may have been rewritten; the old ones shown meanwhile. */
export function refreshTranscripts(environmentId: string, starId: string): void {
  for (const [key, reading] of readings) {
    const [environment, star, name, channel] = JSON.parse(key) as [
      string,
      string,
      string,
      string | null,
    ];
    if (environment !== environmentId || star !== starId || reading.status !== "ready") continue;
    if (channel !== null && !pluginFeatures(environmentId)?.has(CHANNEL_HISTORY_FEATURE)) continue;
    void read(environmentId, starId, name, channel ?? undefined).then((next) => {
      if (next.status !== "ready") return;
      readings.set(key, next);
      changed();
    });
  }
}
