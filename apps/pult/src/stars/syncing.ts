import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import * as Operations from "@t3tools/client-runtime/operations";
import { request } from "@t3tools/client-runtime/rpc";
import { MessageId, ORCHESTRATION_V2_WS_METHODS, ProjectId, ThreadId } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { isStarDraft, projectDrafts } from "../panel/drafts.ts";
import { runOperation } from "../threads/park.ts";
import { threadStore } from "../threads/store.ts";
import { starGit } from "./git.ts";
import {
  type FoundTranscripts,
  onDidFindStarTranscripts,
  rereadStars,
  setStarFields,
  starById,
  starOfProject,
  starRepository,
  starsRead,
  starStore,
} from "./model.ts";
import { readStarTranscript } from "./plugin.ts";
import { conversationsOf, type Star, type StarState } from "./stars.ts";
import {
  commitMessages,
  HANDOFF_TITLE,
  handoffMessage,
  handoffModel,
  handoffThreadId,
  handsOffNow,
  type HomeStatus,
  originProblem,
  refusedByGit,
  sleepOccasions,
  syncPlan,
  syncsNow,
} from "./sync.ts";

/** What of a Star's record the page changes: Name and Tint. */
type RecordFields = { readonly name?: string; readonly tint?: string };

/** How long a pull before a sleeping Star wakes stands before another occasion pulls again. */
const WAKE_PULL_INTERVAL_MS = 60_000;

/** An environment's Stars' repository's sync as the page last ran it, for the settings page's line. */
export interface RepositorySync {
  /** What runs now, while something does. */
  readonly busy: string | null;
  readonly lastSync: number | null;
  readonly failure: string | null;
  /** What waits, or what a Star was handed. */
  readonly note: string | null;
}

/** An occasion: a pull alone, before a sleeping Star wakes, or a full sync, a pull, a commit and a push. */
interface Occasion {
  readonly kind: "pull" | "full";
  /** The commit's message, for a full one. */
  readonly message: (environmentName: string) => string;
  /** Sync Star's or the setting's, which tells what it did. */
  readonly manual: boolean;
  /** The origin being set, which the repository is pointed at first. */
  readonly origin?: string;
  /** A change of a Star's record, written into its home after the pull and committed with the rest. */
  readonly record?: { readonly starId: string; readonly changes: RecordFields };
  /** The Star the occasion is for, which a divergence goes to first. */
  readonly starId?: string;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

const environmentName = (environmentId: string) =>
  threadStore.environment(environmentId)?.name ?? environmentId;
const held = (environmentId: string) => connection.environment(environmentId) !== undefined;
const ready = (environmentId: string) => connection.environment(environmentId)?.phase === "ready";
/** Ready with its threads in, where the page holds its Stars' channels' threads, so their states count. */
const known = (environmentId: string) =>
  ready(environmentId) && threadStore.environment(environmentId)?.loaded === true;
/** The Stars with a home on the environment. */
const starsOn = (environmentId: string) =>
  starStore.get().filter((star) => star.homes.some((home) => home.environmentId === environmentId));
/** " on <environment>" while the page holds several, for what it tells. */
const onWhich = (environmentId: string) =>
  connection.environments.length > 1 ? ` on ${environmentName(environmentId)}` : "";

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
 * The Stars' sync (xaxis `pult/issues/star-sync`,
 * `pult/issues/star-folder-layout`): each environment's Stars live in one
 * repository, the environment's Stars directory, as its Pult plugin names
 * it, which the page makes one where it is not and commits on the occasions
 * it sees, one at a time per environment: in full once per connect while
 * every Star there sleeps, no channel of its open, when a Star falls asleep,
 * its last open channel sleeping, when a transcript the plugin wrote
 * appears in a sleeping Star's answer, on Sync Star and for a change of a
 * record;
 * with an origin (its `.git/config`'s, the one place it is kept) each full
 * occasion fetches, pulls and pushes too, and a sleeping Star's draft
 * written in pulls alone. A failure is told and tried again on the next
 * occasion; a divergence is handed to a Star.
 */
class StarSync {
  private readonly repositories = new Map<string, RepositorySync>();
  /** Each environment's occasions, run one after another. */
  private readonly chains = new Map<string, Promise<boolean>>();
  /** The environments synced in full since they connected. */
  private readonly connected = new Set<string>();
  private readonly pulledAt = new Map<string, number>();
  /** Each Star's state as the sync last saw it, every home's threads in, for its fall asleep (`sleepOccasions`). */
  private states: ReadonlyMap<string, StarState> = new Map();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  start(): void {
    connection.onDidChange(() => {
      for (const environmentId of this.connected)
        if (!ready(environmentId)) this.connected.delete(environmentId);
      this.update();
      this.afterSleeps();
    });
    starStore.subscribe(() => {
      this.update();
      this.afterSleeps();
    });
    // An environment's threads coming in make its Stars' states count, which may change no Star.
    threadStore.subscribe(() => {
      this.update();
      this.afterSleeps();
    });
    onDidFindStarTranscripts((found) => void this.afterTranscripts(found));
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

  repository(environmentId: string): RepositorySync | undefined {
    return this.repositories.get(environmentId);
  }

  private change(environmentId: string, changes: Partial<RepositorySync>): void {
    this.repositories.set(environmentId, {
      ...(this.repositories.get(environmentId) ?? {
        busy: null,
        lastSync: null,
        failure: null,
        note: null,
      }),
      ...changes,
    });
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Syncs in full every environment holding a Star once after it connects,
   * while every Star there sleeps, no channel of its open: an awake one's folder is its
   * conversations' to change, and its sleep syncs it (`afterSleeps`). Whether
   * they sleep is known once the environment's threads are in.
   */
  private update(): void {
    if (connection.connecting || !starsRead()) return;
    for (const environment of connection.environments) {
      const environmentId = environment.environmentId;
      if (!ready(environmentId) || this.connected.has(environmentId)) continue;
      const stars = starsOn(environmentId);
      if (stars.length === 0 || threadStore.environment(environmentId)?.loaded !== true) continue;
      this.connected.add(environmentId);
      if (stars.every(syncsNow))
        void this.run(environmentId, { kind: "full", message: commitMessages.sync, manual: false });
    }
  }

  /**
   * A Star whose last open channel slept: a full occasion on each of its
   * homes' environments, committing what its channels left there (their
   * transcripts among it) and delivering a divergence that waited for its
   * sleep. A Star's state counts only while every home's environment is
   * ready with its threads in, where the page holds its channels' threads,
   * so a sleep seen while one loads is caught once it is in
   * (`sleepOccasions`).
   */
  private afterSleeps(): void {
    const { occasions, states } = sleepOccasions(this.states, starStore.get(), known);
    this.states = states;
    for (const { environmentId, starId } of occasions)
      void this.run(environmentId, {
        kind: "full",
        message: commitMessages.sync,
        manual: false,
        starId,
      });
  }

  /** The environments holding a Star whose repository the page has read, the held ones alone. */
  private repositoriesHeld(): string[] {
    return connection.environments
      .map((environment) => environment.environmentId)
      .filter(
        (environmentId) => starsOn(environmentId).length > 0 && starRepository(environmentId),
      );
  }

  /**
   * The setting: every held environment's Stars' repository pointed at a new
   * origin and synced, one after the other, so each pulls what the one
   * before pushed; empty, each one's origin removed, the repository kept.
   */
  async setOrigin(url: string): Promise<void> {
    const origin = url.trim();
    const environments = this.repositoriesHeld();
    if (origin === "") {
      await Promise.all(
        environments.map((environmentId) =>
          this.queue(environmentId, async () => {
            const repository = starRepository(environmentId);
            if (repository !== undefined)
              await starGit(environmentId).setRemote(repository.root, null, false);
            this.change(environmentId, {
              note: "Not syncing: the repository stays as it is.",
              failure: null,
            });
            await rereadStars(environmentId);
            return true;
          }),
        ),
      );
      return;
    }
    const problem = originProblem(origin);
    if (problem !== undefined) return notify("error", problem);
    for (const environmentId of environments)
      await this.run(environmentId, {
        kind: "full",
        message: commitMessages.settings,
        manual: true,
        origin,
      });
  }

  /** Name and Tint: written into each held home of the Star after that home's pull, and committed, and pushed where its repository syncs. */
  async setRecord(starId: string, changes: RecordFields): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    await Promise.all(
      star.homes
        .filter((home) => held(home.environmentId))
        .map((home) =>
          this.run(home.environmentId, {
            kind: "full",
            message: commitMessages.settings,
            manual: false,
            record: { starId, changes },
            starId,
          }),
        ),
    );
  }

  /** Sync Star: the repository of every held home of the Star that syncs, in full. */
  async syncNow(starId: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const environments = star.homes
      .map((home) => home.environmentId)
      .filter((environmentId) => held(environmentId) && starRepository(environmentId)?.origin);
    if (environments.length === 0)
      return notify(
        "info",
        "Your Stars do not sync: give them an origin in Pult's settings, under Star.",
      );
    for (const environmentId of environments)
      void this.run(environmentId, {
        kind: "full",
        message: commitMessages.sync,
        manual: true,
        starId,
      });
  }

  /**
   * After transcripts the plugin wrote into a home appeared in its answer:
   * their conversation's commit, named by the newest one's title and end as
   * its transcript route reads them, and a push where the repository syncs;
   * nothing while a channel of the Star's is open, whose conversation writes
   * in the folder, the Star's sleep committing it then (`afterSleeps`).
   * Until sync moves to the plugin, a transcript waits for a page to commit
   * it (`star-sync`).
   */
  private async afterTranscripts({ environmentId, starId, names }: FoundTranscripts) {
    const star = starById(starId);
    if (star === undefined || !syncsNow(star)) return;
    const newest = names.at(-1);
    const credential = connection.credential(environmentId);
    const transcript =
      newest === undefined || credential === undefined
        ? undefined
        : await readStarTranscript(credential, starId, newest).catch((error: unknown) => {
            console.warn(
              `[pult-shell] could not read the Star's conversation ${newest} for its commit: ${errorMessage(error)}`,
            );
            return undefined;
          });
    await this.run(environmentId, {
      kind: "full",
      message: () =>
        commitMessages.conversation(
          transcript?.title ?? newest ?? "",
          transcript?.ended ?? new Date().toISOString(),
        ),
      manual: false,
      starId,
    });
  }

  /** Before a sleeping Star, no channel of its open, wakes, its draft written in: a pull of its environment's repository, at most once a minute, so the send never waits on it. */
  private beforeWake(star: Star, environmentId: string): void {
    if (!syncsNow(star)) return;
    if (starRepository(environmentId)?.origin === undefined || !ready(environmentId)) return;
    const now = Date.now();
    if (now - (this.pulledAt.get(environmentId) ?? 0) < WAKE_PULL_INTERVAL_MS) return;
    this.pulledAt.set(environmentId, now);
    void this.run(environmentId, {
      kind: "pull",
      message: commitMessages.sync,
      manual: false,
      starId: star.id,
    });
  }

  /** Runs `task` on the environment's repository after what runs or waits there; whether it did what it set out to. */
  private queue(environmentId: string, task: () => Promise<boolean>): Promise<boolean> {
    const next = (this.chains.get(environmentId) ?? Promise.resolve(true)).then(task);
    this.chains.set(environmentId, next);
    return next;
  }

  private run(environmentId: string, occasion: Occasion): Promise<boolean> {
    return this.queue(environmentId, () => this.sync(environmentId, occasion));
  }

  /**
   * The occasion on the environment's repository as the page holds it when
   * its turn comes: made a repository where it is not one, pointed at the
   * origin being set and fetched, or its own origin fetched; then what the
   * plan says. Whether it synced.
   */
  private async sync(environmentId: string, occasion: Occasion): Promise<boolean> {
    const repository = starRepository(environmentId);
    const origin = occasion.origin ?? repository?.origin;
    if (repository === undefined || (occasion.kind === "pull" && origin === undefined))
      return false;
    const git = starGit(environmentId);
    const name = environmentName(environmentId);
    this.change(environmentId, { busy: occasion.kind === "pull" ? "Pulling…" : "Syncing…" });
    try {
      if (!(await git.status(repository.root)).ownRepository) await git.init(repository.root);
      if (origin !== undefined) await git.setRemote(repository.root, origin, true);
      const status = await git.status(repository.root);
      const plan = syncPlan(status, occasion.kind, {
        writes: occasion.record !== undefined,
        // A new origin may not have the branch its stale upstream names.
        published: occasion.origin === undefined || occasion.origin === repository.origin,
        remote: origin !== undefined,
      });
      if (plan.kind === "diverged")
        return await this.handOff(environmentId, repository.root, occasion, status);
      if (plan.pull) {
        try {
          await git.pull(repository.root);
        } catch (error) {
          if (!refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(environmentId, repository.root, occasion, status);
        }
      }
      if (occasion.record !== undefined) {
        const { starId, changes } = occasion.record;
        const home = starById(starId)?.homes.find((each) => each.environmentId === environmentId);
        if (home === undefined || !(await setStarFields(starId, changes, environmentId)))
          return false;
      }
      if (plan.commit) await git.stacked(repository.root, "commit", occasion.message(name), null);
      if (plan.push) {
        try {
          await git.stacked(repository.root, "push", occasion.message(name), null);
        } catch (error) {
          // A tracked branch's rejected push is a fetch behind, which the next occasion reads; a first one meets the origin's own history.
          if (plan.pull || !refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(environmentId, repository.root, occasion, status);
        }
      }
      this.change(environmentId, { lastSync: Date.now(), failure: null, note: null });
      if (occasion.manual && origin !== undefined)
        await notify("info", `Your Stars are in sync with ${origin}${onWhich(environmentId)}.`);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      console.warn(
        `[pult-shell] could not sync the Stars at ${repository.root} on ${environmentId}: ${message}`,
      );
      this.change(environmentId, { failure: message });
      await notify("error", `Pult could not sync your Stars${onWhich(environmentId)}: ${message}`);
      return false;
    } finally {
      this.change(environmentId, { busy: null });
      // A pull or a commit changes the folders, which a watch tells late, or not at all on a server without one.
      await rereadStars(environmentId);
    }
  }

  /**
   * Hands a divergence to a Star, the occasion's where it has a home on the
   * environment, else the first one there, as the first message of a
   * conversation it wakes in, on its home's project, `user`'s, with the
   * model and modes of `user`'s latest conversation (`handoffModel`); once,
   * its thread's id deterministic
   * from the repository and both sides (`handoffThreadId`), looked up on the
   * server, so no page, and no reload, hands the same divergence over
   * again. An awake Star (a channel of its open), one being written to, or
   * one about to be (a pull before its wake) gets it when it next falls
   * asleep, its sleep's occasion finding it again (`afterSleeps`), or on the
   * next occasion after. Never a sync: false.
   */
  private async handOff(
    environmentId: string,
    root: string,
    occasion: Occasion,
    status: HomeStatus,
  ): Promise<false> {
    const stars = starsOn(environmentId);
    const star = stars.find((each) => each.id === occasion.starId) ?? stars[0];
    const home = star?.homes.find((each) => each.environmentId === environmentId);
    const what = `Your Stars' repository${onWhich(environmentId)} has diverged from its origin`;
    if (star === undefined || home === undefined) return false;
    const branch = status.branch ?? "HEAD";
    const threadId = await handoffThreadId({
      environmentId,
      root,
      branch,
      head: status.head,
      behind: status.behind,
    });
    if (await threadExists(environmentId, threadId)) {
      this.change(environmentId, {
        note: `${what}; your Star has it to reconcile.`,
        failure: null,
      });
      return false;
    }
    const writing = projectDrafts
      .get()
      .some((draft) => draft.environmentId === environmentId && draft.projectId === home.projectId);
    if (!handsOffNow({ state: star.state, writing, occasion: occasion.kind })) {
      this.change(environmentId, {
        note: `${what}; Pult hands it to your Star when it next falls asleep.`,
      });
      return false;
    }
    const model = handoffModel(
      conversationsOf(star.homes, threadStore.get().threads),
      environmentId,
    );
    if (model === undefined) {
      this.change(environmentId, {
        note: `${what}; reconcile it with git in ${root}.`,
      });
      await notify(
        "error",
        `${what}, and your Star has had no conversation to wake with; reconcile it with git in ${root}.`,
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
      environmentName: environmentName(environmentId),
      repository: root,
      branch,
      uncommitted: status.uncommitted,
    });
    await runOperation(
      environmentId,
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
    this.change(environmentId, { note: `${what}; your Star has it to reconcile.`, failure: null });
    await notify("info", `${what}: Pult woke your Star to reconcile it.`);
    return false;
  }
}

const sync = new StarSync();

/** Starts the Stars' sync, after the Stars' model, on the page's connection. */
export function startStarSync(): void {
  sync.start();
}

/** The sync's state for `useSyncExternalStore`: a version, which changes as any repository's does. */
export const starSyncStore = {
  get: () => sync.get(),
  subscribe: (listener: () => void) => sync.subscribe(listener),
};

/** The Stars' origin, on every held environment's repository; empty, none. */
export const setStarOrigin = (url: string) => sync.setOrigin(url);
/** Name and Tint, written after each home's pull and committed. */
export const setStarRecord = (starId: string, changes: RecordFields) =>
  sync.setRecord(starId, changes);
export const syncStar = (starId: string) => sync.syncNow(starId);
export const starRepositorySync = (environmentId: string) => sync.repository(environmentId);
