import { request } from "@t3tools/client-runtime/rpc";
import { type OlderSettled, type OlderSettledPages, olderSettledCountKey } from "@t3tools/client-runtime/state/threads";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2OlderSettledThreads,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { connection } from "../connection/index.ts";

// Rows per page: one "Show more" step of the Settled shelf, as upstream's.
const PAGE_SIZE = 25;
// A burst of changes (a PR sync touching many old threads) costs one count read.
const COUNT_REREAD_DELAY_MS = 500;

const NO_PAGES: OlderSettledPages = { reads: [], frontier: null, status: "ready" };

const countsOf = (counts: OrchestrationV2OlderSettledThreads["counts"]): ReadonlyMap<ProjectId, number> =>
  new Map(counts.map(({ projectId, count }) => [projectId, count] as const));

/**
 * An environment's settled threads that its shell leaves out (`omitOlderSettled`), after
 * upstream's `createOlderSettledThreadAtoms`: where the shell cut them and how many there are per
 * project (`older`), read again after a change that can move the counts, and the pages read below
 * the cut as the Settled shelf shows more (`pages`, `readPage`), whose rows the model lists beside
 * the shell's (`rows`). A new authoritative snapshot (a generation) starts over; so does a cached
 * one (generation 0), which reads nothing. `onDidChange` hears each change.
 */
export class OlderSettledThreads {
  older: OlderSettled | null = null;
  pages: OlderSettledPages = NO_PAGES;
  private generation = -1;
  /** The count key at the generation's snapshot, whose counts are exact for it; null when the state seen first was not the snapshot itself. */
  private snapshotKey: string | null = null;
  /** The count key last read or waiting to be. */
  private readKey: string | null = null;
  private countTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly environmentId: string,
    private readonly onDidChange: () => void,
  ) {}

  follow(snapshot: OrchestrationV2ShellSnapshot, generation: number, removedAt: ReadonlyMap<ThreadId, number>): void {
    const cut = snapshot.olderSettled;
    if (cut === undefined) {
      this.reset(generation);
      this.older = null;
      return;
    }
    const beforeMs = DateTime.toEpochMillis(DateTime.makeUnsafe(cut.before));
    const key = olderSettledCountKey(snapshot.threads, beforeMs, removedAt);
    if (generation !== this.generation || this.older?.before !== cut.before) {
      this.reset(generation);
      this.older = { before: cut.before, beforeMs, counts: countsOf(cut.counts) };
      this.pages = generation === 0 ? NO_PAGES : { reads: [], frontier: { settledAt: cut.before }, status: "ready" };
      this.snapshotKey = snapshot.snapshotSequence === cut.asOfSequence ? key : null;
      this.readKey = this.snapshotKey;
    }
    if (generation === 0 || key === this.readKey) return;
    this.readKey = key;
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => void this.readCounts(generation, cut.before), COUNT_REREAD_DELAY_MS);
  }

  /** Reads the next page below the frontier, unless one is on its way, the last one failed, or none is left. */
  readPage(): void {
    const { pages, generation } = this;
    if (pages.status !== "ready" || pages.frontier === null) return;
    const before = pages.frontier;
    this.pages = { ...pages, status: "pending" };
    this.onDidChange();
    connection
      .run(this.environmentId, request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, { before, limit: PAGE_SIZE }))
      .then(
        (page) => {
          if (this.generation !== generation) return;
          const last = page.threads.at(-1);
          this.pages = {
            reads: [...pages.reads, page],
            frontier:
              page.threads.length < PAGE_SIZE || last?.settledAt == null
                ? null
                : { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id },
            status: "ready",
          };
          this.onDidChange();
        },
        (error: unknown) => {
          if (this.generation !== generation) return;
          console.warn(`[pult-shell] could not read older settled threads: ${String(error)}`);
          this.pages = { ...pages, status: "failed" };
          this.onDidChange();
        },
      );
  }

  /** Lets a failed page be read again. */
  retry(): void {
    if (this.pages.status !== "failed") return;
    this.pages = { ...this.pages, status: "ready" };
    this.onDidChange();
  }

  /** The pages' rows the shell does not hold: one it holds is newer, and one it removed is gone. */
  rows(snapshot: OrchestrationV2ShellSnapshot, removedAt: ReadonlyMap<ThreadId, number>): ReadonlyArray<OrchestrationV2ThreadShell> {
    if (this.pages.reads.length === 0) return [];
    const held = new Set(snapshot.threads.map((thread) => thread.id));
    return this.pages.reads.flatMap((read) => read.threads.filter((thread) => !held.has(thread.id) && !removedAt.has(thread.id)));
  }

  dispose(): void {
    clearTimeout(this.countTimer);
    this.generation = -1;
  }

  private reset(generation: number): void {
    clearTimeout(this.countTimer);
    this.generation = generation;
    this.pages = NO_PAGES;
    this.snapshotKey = null;
    this.readKey = null;
  }

  private async readCounts(generation: number, before: string): Promise<void> {
    const page = await connection
      .run(this.environmentId, request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, { before: { settledAt: before }, limit: 0 }))
      .catch((error: unknown) => {
        console.warn(`[pult-shell] could not read the older settled threads' count: ${String(error)}`);
        return null;
      });
    if (page === null || this.generation !== generation || this.older?.before !== before) return;
    this.older = { ...this.older, counts: countsOf(page.counts) };
    this.onDidChange();
  }
}
