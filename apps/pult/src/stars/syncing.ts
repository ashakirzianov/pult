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
import { parseRecord, type RecordFields, STARS_DIRECTORY } from "./record.ts";
import { conversationsOf, type Star, type StarHome, starName } from "./stars.ts";
import {
  commitMessages,
  HANDOFF_TITLE,
  handoffMessage,
  handoffThreadId,
  type HomeStatus,
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
  /** The origin to sync with where it is not the home's record's yet: one being set. */
  readonly origin?: string;
  /** A change of the record, written after the pull and committed and pushed with the rest. */
  readonly record?: RecordFields;
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
const held = (environmentId: string) => connection.environment(environmentId) !== undefined;
const ready = (environmentId: string) => connection.environment(environmentId)?.phase === "ready";
const named = (star: { readonly id: string; readonly name: string }) =>
  `${star.name.trim() === "" ? "Star" : `"${star.name}"`} (${star.id})`;

async function notify(severity: "info" | "error", message: string): Promise<void> {
  const notifications = await getService(INotificationService);
  if (severity === "error") notifications.error(message);
  else notifications.info(message);
}

/** Whether the environment's server holds the thread, whether or not the page's threads list it. */
const threadExists = (environmentId: string, threadId: string) =>
  connection
    .run(
      environmentId,
      request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
        threadId: ThreadId.make(threadId),
      }),
    )
    .then(
      () => true,
      () => false,
    );

/**
 * The Stars' sync (xaxis `pult/issues/star-sync`): each home whose record
 * names an origin is synced on the occasions the page sees, one at a time
 * per home: in full (a fast-forward pull, a commit of what the folder holds
 * and a push) once per connect while the Star sleeps, after each transcript
 * the page writes, on Sync Star and for a change of the record; a pull alone
 * as a sleeping Star's draft is written in. Each occasion first makes the
 * folder a repository of its own where it is not one, in place, and points
 * its `origin` at the record's, fetched (`vcs.init`, `vcs.setRemote`, which
 * a stock server fails). A failure is told and tried again on the next
 * occasion; a divergence is handed to the Star.
 */
class StarSync {
  private readonly homes = new Map<string, HomeSync>();
  /** Each home's occasions, run one after another. */
  private readonly chains = new Map<string, Promise<boolean>>();
  /** The homes synced in full since their environment connected. */
  private readonly connected = new Set<string>();
  private readonly pulledAt = new Map<string, number>();
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
    // A sleeping Star's draft written in: it is about to wake there.
    projectDrafts.subscribe(() => {
      for (const draft of projectDrafts.get()) {
        if (!isStarDraft(draft)) continue;
        const star = starOfProject(draft.environmentId, draft.projectId);
        if (star !== undefined) this.beforeWake(star, draft.environmentId);
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
          !held(home.environmentId) || threadStore.environment(home.environmentId)?.loaded === true,
      );
      if (!known) continue;
      for (const home of star.homes) {
        const key = homeKey(home);
        if (home.origin === undefined || !ready(home.environmentId) || this.connected.has(key))
          continue;
        this.connected.add(key);
        // An awake Star's folder is its conversation's to change: its sleep's transcript syncs it.
        if (star.state === "asleep")
          void this.run(star.id, home, {
            kind: "full",
            message: commitMessages.sync,
            manual: false,
          });
      }
    }
  }

  /** The setting: a new origin, taken through the Star's homes (`changeRecord`); empty, every home stops syncing. */
  async setOrigin(starId: string, url: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const origin = url.trim();
    if (origin === "") return this.stop(star);
    const problem = originProblem(origin);
    if (problem !== undefined) return notify("error", problem);
    await this.changeRecord(star, { origin }, origin);
  }

  /** Name and Tint: written into the Star's homes (`changeRecord`). */
  async setRecord(starId: string, changes: RecordFields): Promise<void> {
    const star = starById(starId);
    if (star !== undefined) await this.changeRecord(star, changes);
  }

  /**
   * A change of the record on every held home. The homes that sync, or every
   * one when `origin` is a new origin, take it through the origin: one, a
   * home syncing already where there is one, writes it, commits and pushes
   * it, and the others then pull it, each pointed at `origin` first; so no
   * home holds an edit of the record its pull would refuse to overwrite. A
   * home that does not sync is written in place. Whether the origin took it.
   */
  private async changeRecord(star: Star, changes: RecordFields, origin?: string): Promise<boolean> {
    const homes = star.homes.filter((home) => held(home.environmentId));
    const syncing = homes.filter((home) => origin !== undefined || home.origin !== undefined);
    const direct = homes.filter((home) => !syncing.includes(home));
    if (direct.length > 0) await setStarFields(star.id, changes, direct);
    const first = syncing.find((home) => home.origin !== undefined) ?? syncing[0];
    if (first === undefined) return true;
    // These occasions sync them: the record's change must not start another as it lands.
    for (const home of syncing) this.connected.add(homeKey(home));
    const manual = origin !== undefined;
    const pushed = await this.run(star.id, first, {
      kind: "full",
      message: changes.origin === "" ? commitMessages.stop : commitMessages.settings,
      manual,
      record: changes,
      ...(origin === undefined ? {} : { origin }),
    });
    if (!pushed) return false;
    for (const home of syncing)
      if (home !== first)
        void this.run(star.id, home, {
          kind: "pull",
          message: commitMessages.sync,
          manual,
          ...(origin === undefined ? {} : { origin }),
        });
    return true;
  }

  /**
   * Clearing the origin stops every held home syncing, a change of the
   * record like any other (`changeRecord`), so the homes stop in step and
   * none has diverged from the others when syncing starts again; where the
   * origin cannot take it, each home's record is written in place, so it
   * stops anyway. The repository and its remote stay as they are.
   */
  private async stop(star: Star): Promise<void> {
    const homes = star.homes.filter(
      (home) => home.origin !== undefined && held(home.environmentId),
    );
    if (!(await this.changeRecord(star, { origin: "" })))
      await Promise.all(
        homes.map((home) => this.queue(home, () => setStarFields(star.id, { origin: "" }, [home]))),
      );
    for (const home of homes)
      this.change(home, { note: "Not syncing: the repository stays as it is.", failure: null });
  }

  /**
   * Makes the home's folder a repository of its own where it is not one, in
   * place, and points its `origin` at `origin`, fetched, which a stock
   * server cannot; refuses, with a notification naming both, an origin whose
   * branch holds another Star, the folder's remote put back as it was. Its
   * status then, and whether the origin has its branch; undefined when
   * refused.
   */
  private async connect(
    star: Star,
    home: StarHome,
    origin: string,
  ): Promise<{ readonly status: HomeStatus; readonly published: boolean } | undefined> {
    const git = starGit(home.environmentId);
    if (!(await git.status(home.root)).ownRepository) await git.init(home.root);
    const previous = await git.setRemote(home.root, origin, true);
    const status = await git.status(home.root);
    const theirs =
      status.branch === null ? undefined : await git.originRecord(home.root, status.branch);
    const record = theirs === undefined ? undefined : parseRecord(theirs);
    if (record !== undefined && record.id !== star.id) {
      const reason = `${origin} holds another Star, ${named(record)}, and yours is ${named(star)}; Pult does not merge two Stars.`;
      if (previous !== origin) await git.setRemote(home.root, previous, false);
      this.change(home, { failure: reason });
      await notify("error", `Pult did not sync your Star: ${reason}`);
      return undefined;
    }
    return { status, published: theirs !== undefined };
  }

  /** Sync Star: every held home that names an origin, in full. */
  async syncNow(starId: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const homes = star.homes.filter(
      (home) => home.origin !== undefined && held(home.environmentId),
    );
    if (homes.length === 0)
      return notify(
        "info",
        `${starName(star)} does not sync: give it an origin in Pult's settings, under Star.`,
      );
    for (const home of homes)
      void this.run(star.id, home, { kind: "full", message: commitMessages.sync, manual: true });
  }

  /** After a transcript the page wrote into a home: its conversation's commit, and a push. */
  afterTranscript(home: StarHome, thread: Pick<ShellThread, "title" | "settledAt">): void {
    const star = starStore
      .get()
      .find((each) => each.homes.some((candidate) => homeKey(candidate) === homeKey(home)));
    const current = star?.homes.find((candidate) => homeKey(candidate) === homeKey(home));
    if (star === undefined || current?.origin === undefined) return;
    void this.run(star.id, current, {
      kind: "full",
      message: () =>
        commitMessages.conversation(thread.title, thread.settledAt ?? new Date().toISOString()),
      manual: false,
    });
  }

  /** Before a sleeping Star wakes, its draft written in: a pull of the draft's home, at most once a minute, so the send never waits on it. */
  private beforeWake(star: Star, environmentId: string): void {
    if (star.current !== null) return;
    const home = star.homes.find((each) => each.environmentId === environmentId);
    if (home?.origin === undefined || !ready(home.environmentId)) return;
    const key = homeKey(home);
    const now = Date.now();
    if (now - (this.pulledAt.get(key) ?? 0) < WAKE_PULL_INTERVAL_MS) return;
    this.pulledAt.set(key, now);
    void this.run(star.id, home, { kind: "pull", message: commitMessages.sync, manual: false });
  }

  /** Runs `task` on the home after what runs or waits there; whether it did what it set out to. */
  private queue(home: StarHome, task: () => Promise<boolean>): Promise<boolean> {
    const key = homeKey(home);
    const next = (this.chains.get(key) ?? Promise.resolve(true)).then(task);
    this.chains.set(key, next);
    return next;
  }

  private run(starId: string, home: StarHome, occasion: Occasion): Promise<boolean> {
    const key = homeKey(home);
    return this.queue(home, () => this.sync(starId, key, occasion));
  }

  /** The occasion on the home as the page holds it when its turn comes; whether it synced. */
  private async sync(starId: string, key: string, occasion: Occasion): Promise<boolean> {
    const star = starById(starId);
    const home = star?.homes.find((candidate) => homeKey(candidate) === key);
    const origin = occasion.origin ?? home?.origin;
    if (star === undefined || home === undefined || origin === undefined) return false;
    const name = environmentName(home.environmentId);
    const git = starGit(home.environmentId);
    this.change(home, { busy: occasion.kind === "pull" ? "Pulling…" : "Syncing…" });
    try {
      const connected = await this.connect(star, home, origin);
      if (connected === undefined) return false;
      const { status, published } = connected;
      const plan = syncPlan(status, occasion.kind, {
        writes: occasion.record !== undefined,
        published,
      });
      if (plan.kind === "diverged") return await this.handOff(star, home, occasion, status);
      if (plan.pull) {
        try {
          await git.pull(home.root);
        } catch (error) {
          if (!refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(star, home, occasion, status);
        }
      }
      if (occasion.record !== undefined && !(await setStarFields(star.id, occasion.record, [home])))
        return false;
      if (plan.commit)
        await git.stacked(home.root, "commit", occasion.message(name), home.projectId);
      if (plan.push) {
        try {
          await git.stacked(home.root, "push", occasion.message(name), home.projectId);
        } catch (error) {
          // A tracked branch's rejected push is a fetch behind, which the next occasion reads; a first one meets the origin's own history.
          if (plan.pull || !refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(star, home, occasion, status);
        }
      }
      this.change(home, { lastSync: Date.now(), failure: null, note: null });
      if (occasion.manual)
        await notify(
          "info",
          `${starName(star)} is in sync with ${origin}${star.homes.length === 1 ? "" : ` on ${name}`}.`,
        );
      return true;
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
      return false;
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
   * from the home and both sides (`handoffThreadId`), looked up on the
   * server, so no page, and no reload, hands the same divergence over
   * again. An awake Star, one being written to, or one about to be (a pull
   * before its wake) gets it when it next falls asleep, its sleep's sync
   * finding it again. Never a sync: false.
   */
  private async handOff(
    star: Star,
    home: StarHome,
    occasion: Occasion,
    status: HomeStatus,
  ): Promise<false> {
    const name = environmentName(home.environmentId);
    const what = `${starName(star)}'s folder on ${name} has diverged from its origin`;
    if (home.projectId === null) return false;
    const branch = status.branch ?? "HEAD";
    const threadId = await handoffThreadId({
      environmentId: home.environmentId,
      root: home.root,
      branch,
      head: status.head,
      behind: status.behind,
    });
    if (await threadExists(home.environmentId, threadId)) {
      this.change(home, { note: `${what}; your Star has it to reconcile.`, failure: null });
      return false;
    }
    const writing = projectDrafts
      .get()
      .some(
        (draft) => draft.environmentId === home.environmentId && draft.projectId === home.projectId,
      );
    // A pull before a wake hands nothing over: the user is about to write to the Star.
    if (star.current !== null || writing || occasion.kind === "pull") {
      this.change(home, { note: `${what}; Pult hands it to your Star when it next falls asleep.` });
      return false;
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
      return false;
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
      branch,
      uncommitted: status.uncommitted,
    });
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
    this.change(home, { note: `${what}; your Star has it to reconcile.`, failure: null });
    await notify("info", `${what}: Pult woke your Star to reconcile it.`);
    return false;
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
/** Name and Tint, through the origin where the Star syncs. */
export const setStarRecord = (starId: string, changes: RecordFields) =>
  sync.setRecord(starId, changes);
export const syncStar = (starId: string) => sync.syncNow(starId);
export const starHomeSync = (home: Pick<StarHome, "environmentId" | "root">) => sync.home(home);
export const afterStarTranscript = (
  home: StarHome,
  thread: Pick<ShellThread, "title" | "settledAt">,
) => sync.afterTranscript(home, thread);
