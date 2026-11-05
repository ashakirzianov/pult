import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import * as Operations from "@t3tools/client-runtime/operations";
import { request } from "@t3tools/client-runtime/rpc";
import { MessageId, ORCHESTRATION_V2_WS_METHODS, ProjectId, ThreadId } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { isStarDraft, projectDrafts } from "../panel/drafts.ts";
import { runOperation } from "../threads/park.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import { starGit } from "./git.ts";
import {
  rereadStars,
  setStarFields,
  starById,
  starFoldersRead,
  starOfProject,
  starStore,
} from "./model.ts";
import { parseRecord, RECORD_FILE, STARS_DIRECTORY } from "./record.ts";
import { conversationsOf, type Star, type StarHome, starName, wakeHome } from "./stars.ts";
import {
  commitMessages,
  type Divergence,
  HANDOFF_TITLE,
  handoffMessage,
  handoffThreadId,
  originProblem,
  refusedByGit,
  syncPlan,
} from "./sync.ts";

/** How long a pull before a sleeping Star wakes stands before another occasion pulls again. */
const WAKE_PULL_INTERVAL_MS = 60_000;

/** A home's sync as the page last ran it, for the settings page's line. */
export interface HomeSync {
  /** What runs now, while something does. */
  readonly busy: string | null;
  readonly lastSync: number | null;
  readonly failure: string | null;
  /** What waits, or what the Star was handed. */
  readonly note: string | null;
}

/** An occasion: a pull alone, before a sleeping Star wakes, or a full sync, a pull, a commit and a push. */
interface Occasion {
  readonly kind: "pull" | "full";
  /** The commit's message, for a full one. */
  readonly message: (environmentName: string) => string;
  /** Sync Star's or the setting's, which tells what it did. */
  readonly manual: boolean;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

const homeKey = (home: Pick<StarHome, "environmentId" | "root">) =>
  `${home.environmentId}\n${home.root}`;
const lastSegment = (path: string) =>
  path
    .split(/[/\\]/)
    .filter((segment) => segment !== "")
    .at(-1) ?? path;
const environmentName = (environmentId: string) =>
  threadStore.environment(environmentId)?.name ?? environmentId;
const ready = (environmentId: string) => connection.environment(environmentId)?.phase === "ready";
const named = (star: { readonly id: string; readonly name: string }) =>
  `${star.name.trim() === "" ? "Star" : `"${star.name}"`} (${star.id})`;

async function notify(severity: "info" | "error", message: string): Promise<void> {
  const notifications = await getService(INotificationService);
  if (severity === "error") notifications.error(message);
  else notifications.info(message);
}

/**
 * The Stars' sync (xaxis `pult/issues/star-sync`): each home whose record
 * names an origin is synced on the occasions the page sees, one at a time
 * per home: in full (a fast-forward pull, a commit of what the folder holds
 * and a push) once per connect while the Star sleeps, after each transcript
 * the page writes, and on Sync Star; a pull alone as a sleeping Star is
 * about to wake, its tab shown or its draft written in. A folder that is no
 * repository of its own, or whose `origin` is not its record's, is made one
 * in place and pointed at it (`vcs.init`, `vcs.setRemote`). A failure is told
 * and tried again on the next occasion; a divergence is handed to the Star.
 */
class StarSync {
  private readonly homes = new Map<string, HomeSync>();
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, Occasion>();
  /** The homes synced in full since their environment connected. */
  private readonly connected = new Set<string>();
  private readonly pulledAt = new Map<string, number>();
  /** The handoffs this page started, by thread id, until the store lists them. */
  private readonly started = new Set<string>();
  /** The handoffs waiting for the Star to sleep that the user was told of, by thread id. */
  private readonly told = new Set<string>();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  start(): void {
    connection.onDidChange(() => {
      for (const key of this.connected)
        if (!ready(key.split("\n")[0] ?? "")) this.connected.delete(key);
      this.update();
    });
    starStore.subscribe(() => this.update());
    threadStore.subscribe(() => this.update());
    // A sleeping Star's draft written in: it is about to wake.
    projectDrafts.subscribe(() => {
      for (const draft of projectDrafts.get()) {
        if (!isStarDraft(draft)) continue;
        const star = starOfProject(draft.environmentId, draft.projectId);
        if (star !== undefined) this.beforeWake(star.id, draft.environmentId);
      }
    });
    this.update();
  }

  get(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  home(home: Pick<StarHome, "environmentId" | "root">): HomeSync | undefined {
    return this.homes.get(homeKey(home));
  }

  private change(home: Pick<StarHome, "environmentId" | "root">, changes: Partial<HomeSync>): void {
    const key = homeKey(home);
    this.homes.set(key, {
      ...(this.homes.get(key) ?? { busy: null, lastSync: null, failure: null, note: null }),
      ...changes,
    });
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Syncs in full every home that names an origin once after its environment
   * connects, while its Star sleeps: an awake one syncs as it falls asleep.
   * Whether it sleeps is known once every held home's threads are in.
   */
  private update(): void {
    if (connection.connecting || !starFoldersRead()) return;
    for (const star of starStore.get()) {
      const known = star.homes.every(
        (home) =>
          connection.environment(home.environmentId) === undefined ||
          threadStore.environment(home.environmentId)?.loaded === true,
      );
      if (!known) continue;
      for (const home of star.homes) {
        const key = homeKey(home);
        if (home.origin === undefined || !ready(home.environmentId) || this.connected.has(key))
          continue;
        this.connected.add(key);
        // An awake Star's folder is its conversation's to change: its sleep's transcript syncs it.
        if (star.state === "asleep")
          this.run(star.id, home, { kind: "full", message: commitMessages.sync, manual: false });
      }
    }
  }

  /**
   * The setting: an origin is taken once one home connects to it, which
   * refuses an origin holding another Star, then written into every held
   * home's record and synced there; empty, every home stops syncing, its
   * record's origin cleared and that change pushed where it can be, so the
   * other homes stop on their next pull, the repository staying as it is.
   */
  async setOrigin(starId: string, url: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const origin = url.trim();
    if (origin === "") return this.stop(star);
    const problem = originProblem(origin);
    if (problem !== undefined) return notify("error", problem);
    const first = star.homes.find((home) => ready(home.environmentId));
    if (first === undefined) return;
    try {
      if (!(await this.connect(star, first, origin))) return;
    } catch (error) {
      return notify("error", `Pult could not set your Star's origin: ${errorMessage(error)}`);
    }
    await setStarFields(starId, { origin });
    for (const home of starById(starId)?.homes ?? []) {
      if (home.origin === undefined || !ready(home.environmentId)) continue;
      this.connected.add(homeKey(home));
      this.run(starId, home, { kind: "full", message: commitMessages.sync, manual: true });
    }
  }

  private async stop(star: Star): Promise<void> {
    const syncing = star.homes.filter(
      (home) => home.origin !== undefined && ready(home.environmentId),
    );
    await setStarFields(star.id, { origin: "" });
    let pushed = false;
    for (const home of syncing) {
      this.change(home, { note: "Not syncing: the repository stays as it is.", failure: null });
      // One home in step with the origin pushes the record's change alone; the others take it on their next pull.
      if (pushed) continue;
      try {
        const git = starGit(home.environmentId);
        const status = await git.status(home.root);
        if (!status.ownRepository || !status.hasUpstream || status.behind > 0) continue;
        await git.stacked(home.root, "commit_push", commitMessages.stop(), home.projectId, [
          RECORD_FILE,
        ]);
        pushed = true;
      } catch (error) {
        await notify(
          "error",
          `Pult stopped syncing your Star, but could not push that to its origin from ${environmentName(home.environmentId)}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Makes the home's folder a repository of its own where it is not one, in
   * place, and points its `origin` at `origin`, fetched; refuses, with a
   * notification naming both, an origin whose branch holds another Star.
   * Whether the home is connected.
   */
  private async connect(star: Star, home: StarHome, origin: string): Promise<boolean> {
    const git = starGit(home.environmentId);
    if (!(await git.canSetRemote())) {
      await notify(
        "error",
        `Pult cannot sync your Star on ${environmentName(home.environmentId)}: its server cannot set a repository's origin, which takes Pult's server.`,
      );
      return false;
    }
    if (!(await git.status(home.root)).ownRepository) await git.init(home.root);
    const previous = await git.setRemote(home.root, origin, true);
    const branch = (await git.status(home.root)).branch;
    const theirs =
      branch === null ? undefined : parseRecord((await git.originRecord(home.root, branch)) ?? "");
    if (theirs !== undefined && theirs.id !== star.id) {
      const reason = `${origin} holds another Star, ${named(theirs)}, and yours is ${named(star)}; Pult does not merge two Stars.`;
      // The folder's origin as it was: the user's, or the one it synced with.
      if (previous !== null) await git.setRemote(home.root, previous, false);
      this.change(home, { failure: reason });
      await notify("error", `Pult did not sync your Star: ${reason}`);
      return false;
    }
    return true;
  }

  /** Sync Star: every held home that names an origin, in full. */
  async syncNow(starId: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const homes = star.homes.filter(
      (home) => home.origin !== undefined && ready(home.environmentId),
    );
    if (homes.length === 0)
      return notify(
        "info",
        `${starName(star)} does not sync: give it an origin in Pult's settings, under Star.`,
      );
    for (const home of homes)
      this.run(star.id, home, { kind: "full", message: commitMessages.sync, manual: true });
  }

  /** After a transcript the page wrote into a home: its conversation's commit, and a push. */
  afterTranscript(home: StarHome, thread: Pick<ShellThread, "title" | "settledAt">): void {
    const star = starStore
      .get()
      .find((each) => each.homes.some((candidate) => homeKey(candidate) === homeKey(home)));
    const current = star?.homes.find((candidate) => homeKey(candidate) === homeKey(home));
    if (star === undefined || current?.origin === undefined) return;
    this.run(star.id, current, {
      kind: "full",
      message: () =>
        commitMessages.conversation(thread.title, thread.settledAt ?? new Date().toISOString()),
      manual: false,
    });
  }

  /** Before a sleeping Star wakes, its draft shown or written in: a pull of the home it wakes in, the draft's environment's where it names one, at most once a minute. */
  beforeWake(starId: string, environmentId?: string): void {
    const star = starById(starId);
    if (star === undefined || star.current !== null) return;
    const home =
      environmentId === undefined
        ? wakeHome(star, (each) => connection.environment(each) !== undefined)
        : star.homes.find((each) => each.environmentId === environmentId);
    if (home?.origin === undefined || !ready(home.environmentId)) return;
    const key = homeKey(home);
    const now = Date.now();
    if (now - (this.pulledAt.get(key) ?? 0) < WAKE_PULL_INTERVAL_MS) return;
    this.pulledAt.set(key, now);
    this.run(star.id, home, { kind: "pull", message: commitMessages.sync, manual: false });
  }

  /** Runs the occasion on the home, or while one runs there queues it, a full one taking a queued pull's place. */
  private run(starId: string, home: StarHome, occasion: Occasion): void {
    const key = homeKey(home);
    if (this.running.has(key)) {
      const queued = this.queued.get(key);
      if (queued === undefined || occasion.kind === "full") this.queued.set(key, occasion);
      return;
    }
    this.running.add(key);
    void this.sync(starId, home, occasion).finally(() => {
      this.running.delete(key);
      const next = this.queued.get(key);
      this.queued.delete(key);
      const current = starById(starId)?.homes.find((candidate) => homeKey(candidate) === key);
      if (next !== undefined && current?.origin !== undefined) this.run(starId, current, next);
    });
  }

  private async sync(starId: string, home: StarHome, occasion: Occasion): Promise<void> {
    const star = starById(starId);
    const origin = home.origin;
    if (star === undefined || origin === undefined) return;
    const name = environmentName(home.environmentId);
    const git = starGit(home.environmentId);
    this.change(home, { busy: occasion.kind === "pull" ? "Pulling…" : "Syncing…" });
    try {
      let status = await git.status(home.root);
      let plan = syncPlan(status, origin, occasion.kind);
      if (plan.kind === "connect") {
        if (!(await this.connect(star, home, origin))) return;
        status = await git.status(home.root);
        plan = syncPlan(status, origin, occasion.kind);
        if (plan.kind === "connect") throw new Error(`the folder's origin is not ${origin}.`);
      }
      const branch = status.branch ?? "HEAD";
      if (plan.kind === "diverged")
        return await this.handOff(star, home, occasion, {
          kind: "diverged",
          branch,
          ahead: status.ahead,
          behind: status.behind,
          uncommitted: status.uncommitted,
        });
      if (plan.pull) {
        try {
          await git.pull(home.root);
        } catch (error) {
          if (!refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(star, home, occasion, {
            kind: "refused",
            branch,
            message: errorMessage(error),
            uncommitted: status.uncommitted,
          });
        }
      }
      if (plan.commit)
        await git.stacked(home.root, "commit", occasion.message(name), home.projectId);
      if (plan.push) {
        try {
          await git.stacked(home.root, "push", occasion.message(name), home.projectId);
        } catch (error) {
          // A tracked branch's rejected push is a fetch behind, which the next occasion's status reads; a first one meets the origin's own history.
          if (status.hasUpstream || !refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(star, home, occasion, {
            kind: "unrelated",
            branch,
            message: errorMessage(error),
          });
        }
      }
      this.change(home, { lastSync: Date.now(), failure: null, note: null });
      if (occasion.manual)
        await notify(
          "info",
          `${starName(star)} is in sync with ${origin}${star.homes.length === 1 ? "" : ` on ${name}`}.`,
        );
    } catch (error) {
      const message = errorMessage(error);
      console.warn(
        `[pult-shell] could not sync the Star at ${home.root} on ${home.environmentId}: ${message}`,
      );
      this.change(home, { failure: message });
      await notify(
        "error",
        `Pult could not sync ${starName(star)}${star.homes.length === 1 ? "" : ` on ${name}`}: ${message}`,
      );
    } finally {
      this.change(home, { busy: null });
      // A pull or a commit changes the folder, which a watch tells late, or not at all on a server without one.
      await rereadStars(home.environmentId);
    }
  }

  /**
   * Hands a divergence to the Star as the first message of a conversation it
   * wakes in, on the home's environment and project, with its latest
   * conversation there's model and modes; once, its thread's id deterministic
   * from the home and the origin's commit (`handoffThreadId`), so no page,
   * and no reload, hands the same divergence over again. An awake Star, one
   * being written to, or one about to be (a pull before its wake) gets it
   * when it next falls asleep, its sleep's sync finding it again.
   */
  private async handOff(
    star: Star,
    home: StarHome,
    occasion: Occasion,
    divergence: Divergence,
  ): Promise<void> {
    const name = environmentName(home.environmentId);
    const what = `${starName(star)}'s folder on ${name} has diverged from its origin`;
    if (home.projectId === null) return;
    const git = starGit(home.environmentId);
    const threadId = await handoffThreadId({
      environmentId: home.environmentId,
      root: home.root,
      divergence,
      originCommit: await git.originCommit(home.root, divergence.branch),
    });
    const known =
      this.started.has(threadId) ||
      threadStore
        .get()
        .threads.some(
          (thread) => thread.environmentId === home.environmentId && thread.id === threadId,
        );
    if (known) {
      this.change(home, { note: `${what}; your Star has it to reconcile.`, failure: null });
      return;
    }
    const writing = projectDrafts
      .get()
      .some(
        (draft) => draft.environmentId === home.environmentId && draft.projectId === home.projectId,
      );
    // A pull before a wake hands nothing over: the user is about to write to the Star.
    if (star.current !== null || writing || occasion.kind === "pull") {
      this.change(home, { note: `${what}; Pult hands it to your Star when it next falls asleep.` });
      if (!this.told.has(threadId)) {
        this.told.add(threadId);
        await notify(
          "info",
          `${what}; Pult hands it to your Star to reconcile when it next falls asleep.`,
        );
      }
      return;
    }
    // The model and modes of its latest conversation there, else of its latest anywhere.
    const conversations = conversationsOf(star.homes, threadStore.get().threads);
    const model =
      conversations.find((thread) => thread.environmentId === home.environmentId) ??
      conversations[0];
    if (model === undefined) {
      this.change(home, { note: `${what}; reconcile it with git in the folder.` });
      await notify(
        "error",
        `${what}, and your Star has had no conversation to wake with; reconcile it with git in the folder.`,
      );
      return;
    }
    const projection = await connection.run(
      model.environmentId,
      request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
        threadId: ThreadId.make(model.id),
      }),
    );
    const { modelSelection, runtimeMode, interactionMode } = projection.thread;
    const text = handoffMessage({
      environmentName: name,
      folder: `~/${STARS_DIRECTORY}/${lastSegment(home.root)}`,
      divergence,
    });
    this.started.add(threadId);
    try {
      await runOperation(
        home.environmentId,
        Operations.startThreadTurn({
          threadId: ThreadId.make(threadId),
          message: {
            messageId: MessageId.make(globalThis.crypto.randomUUID()),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode,
          interactionMode,
          modelSelection,
          bootstrap: {
            createThread: {
              projectId: ProjectId.make(home.projectId),
              title: HANDOFF_TITLE,
              modelSelection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          },
        }),
      );
    } catch (error) {
      this.started.delete(threadId);
      throw error;
    }
    this.change(home, { note: `${what}; your Star has it to reconcile.`, failure: null });
    await notify("info", `${what}: Pult woke your Star to reconcile it.`);
  }
}

const sync = new StarSync();

/** Starts the Stars' sync, after the Stars' model, on the page's connection. */
export function startStarSync(): void {
  sync.start();
}

/** The sync's state for `useSyncExternalStore`: a version, which changes as any home's does. */
export const starSyncStore = {
  get: () => sync.get(),
  subscribe: (listener: () => void) => sync.subscribe(listener),
};

export const setStarOrigin = (starId: string, url: string) => sync.setOrigin(starId, url);
export const syncStar = (starId: string) => sync.syncNow(starId);
export const starHomeSync = (home: Pick<StarHome, "environmentId" | "root">) => sync.home(home);
export const afterStarTranscript = (
  home: StarHome,
  thread: Pick<ShellThread, "title" | "settledAt">,
) => sync.afterTranscript(home, thread);
export const beforeStarWakes = (starId: string, environmentId?: string) =>
  sync.beforeWake(starId, environmentId);
