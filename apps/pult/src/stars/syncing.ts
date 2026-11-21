import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import * as Operations from "@t3tools/client-runtime/operations";
import { request } from "@t3tools/client-runtime/rpc";
import {
  MessageId,
  ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { connection } from "../connection/index.ts";
import { isStarDraft, projectDrafts } from "../panel/drafts.ts";
import { runOperation } from "../threads/park.ts";
import { threadStore } from "../threads/store.ts";
import { starGit } from "./git.ts";
import {
  type FoundTranscripts,
  onDidFindStarTranscripts,
  onDidWriteStarChannelTranscripts,
  rereadStars,
  setStarFields,
  starById,
  starOfProject,
  starsRead,
  starsReadOn,
  starStore,
  starWakeModel,
  type WrittenChannelTranscripts,
} from "./model.ts";
import { readStarTranscript } from "./plugin.ts";
import { conversationsOf, type Star, type StarHome, starName } from "./stars.ts";
import {
  commitMessages,
  handoffMessage,
  handoffModel,
  handoffThreadId,
  handoffTurn,
  handsOffNow,
  homeSleeps,
  type HomeStatus,
  originProblem,
  ownRepository,
  refusedByGit,
  sleepOccasions,
  syncPlan,
} from "./sync.ts";

/** What of a Star's record the page changes: Name and Tint. */
type RecordFields = { readonly name?: string; readonly tint?: string };

const decodeModel = Schema.decodeUnknownSync(ModelSelection);

/** How long a pull before a sleeping Star wakes stands before another occasion pulls again. */
const WAKE_PULL_INTERVAL_MS = 60_000;

/** A Star's repository's sync on one home as the page last ran it, for the settings page's line. */
export interface RepositorySync {
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
  /** The origin being set, which the repository is pointed at first. */
  readonly origin?: string;
  /** A change of the Star's record, written into its home after the pull and committed with the rest. */
  readonly record?: RecordFields;
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
/**
 * Ready with its threads in, where the page holds its Stars' channels'
 * threads, and its plugin's answer in, where it holds its Stars, so their
 * states count: a failed read drops the environment's Stars, which is no sleep.
 */
const known = (environmentId: string) =>
  ready(environmentId) &&
  threadStore.environment(environmentId)?.loaded === true &&
  starsReadOn(environmentId);
/** The Stars with a home on the environment. */
const starsOn = (environmentId: string) =>
  starStore.get().filter((star) => star.homes.some((home) => home.environmentId === environmentId));
/** The Star's home on the environment, as the page holds it now. */
const homeOf = (starId: string, environmentId: string) =>
  starById(starId)?.homes.find((home) => home.environmentId === environmentId);
/** A home's key: a Star's repository on one environment, which its occasions, state and handoff go by. */
const homeKey = (environmentId: string, starId: string) => `${environmentId}\n${starId}`;
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
 * The Stars' sync (xaxis `pult/tasks/star-sync.task`,
 * `pult/tasks/star-repo-per-star.task`): each Star's folder on each of its
 * homes is a repository of its own, which the page makes one where it is
 * not (and refuses where its Stars directory is still one repository for
 * every Star, `ownRepository`) and commits on the occasions it sees, one at
 * a time per home: in full once per connect while the Star sleeps there, no
 * channel of its open on its home there, when its last open channel there
 * sleeps, when a transcript the plugin wrote appears in its answer, or the
 * watch tells of one of a channel but `user`'s, while it sleeps there, on
 * Sync Star and for a change of its record; with an origin (its
 * `.git/config`'s, the one place it is kept) each full occasion fetches,
 * pulls and pushes too, and its draft written in while it sleeps pulls
 * alone. No other Star counts. A failure is told and tried again on the
 * next occasion; a divergence is handed to the Star.
 */
class StarSync {
  /** Each home's state, by `homeKey`. */
  private readonly repositories = new Map<string, RepositorySync>();
  /** Each home's occasions, run one after another, by `homeKey`. */
  private readonly chains = new Map<string, Promise<boolean>>();
  /** The environments synced in full since they connected. */
  private readonly connected = new Set<string>();
  /** When each home last pulled before a wake, by `homeKey`. */
  private readonly pulledAt = new Map<string, number>();
  /** The Stars the sync last saw awake on each environment it knew, for the sleep's occasion (`sleepOccasions`). */
  private awake: ReadonlyMap<string, ReadonlyArray<string>> = new Map();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  start(): void {
    connection.onDidChange(() => {
      for (const environmentId of this.connected)
        if (!ready(environmentId)) this.connected.delete(environmentId);
      // An environment no longer ready is seen afresh on its reconnect, whose sync is the connect's, not a sleep's.
      this.awake = new Map([...this.awake].filter(([environmentId]) => ready(environmentId)));
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
    onDidWriteStarChannelTranscripts((written) => this.afterChannelTranscripts(written));
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

  repository(environmentId: string, starId: string): RepositorySync | undefined {
    return this.repositories.get(homeKey(environmentId, starId));
  }

  private change(key: string, changes: Partial<RepositorySync>): void {
    this.repositories.set(key, {
      ...(this.repositories.get(key) ?? {
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
   * Syncs in full each Star's home on an environment once after it
   * connects, while the Star sleeps there, no channel of its open on its
   * home there (`homeSleeps`): an awake one's folder is its conversations'
   * to change, and its sleep syncs it (`afterSleeps`). Whether it sleeps is
   * known once the environment's threads are in.
   */
  private update(): void {
    if (connection.connecting || !starsRead()) return;
    for (const environment of connection.environments) {
      const environmentId = environment.environmentId;
      if (!ready(environmentId) || this.connected.has(environmentId)) continue;
      const stars = starsOn(environmentId);
      if (stars.length === 0 || threadStore.environment(environmentId)?.loaded !== true) continue;
      this.connected.add(environmentId);
      for (const star of stars)
        if (homeSleeps(environmentId, star, known))
          void this.run(environmentId, star.id, {
            kind: "full",
            message: commitMessages.sync,
            manual: false,
          });
    }
  }

  /**
   * A Star falling asleep on an environment, its last channel open on its
   * home there sleeping: a full occasion on that home, committing what the
   * channels left there (a transcript the plugin writes after the settle
   * being its own occasion, `afterChannelTranscripts`, or `user`'s,
   * `afterTranscripts`) and delivering a divergence that waited for the
   * sleep. An environment counts only while it is ready with its threads
   * and its plugin's answer in (`known`), so a sleep seen while it loads,
   * or while a failed read drops its Stars, is caught once it is in
   * (`sleepOccasions`).
   */
  private afterSleeps(): void {
    const { occasions, awake } = sleepOccasions(this.awake, starStore.get(), known);
    this.awake = awake;
    for (const { environmentId, starId } of occasions)
      void this.run(environmentId, starId, {
        kind: "full",
        message: commitMessages.sync,
        manual: false,
      });
  }

  /**
   * The setting: the Star's repository on each held home pointed at a new
   * origin and synced, one after the other, so each pulls what the one
   * before pushed; empty, each one's origin removed, the repository kept.
   */
  async setOrigin(starId: string, url: string): Promise<void> {
    const origin = url.trim();
    const homes = (starById(starId)?.homes ?? []).filter((home) => held(home.environmentId));
    if (origin === "") {
      await Promise.all(
        homes.map((home) => {
          const key = homeKey(home.environmentId, starId);
          return this.queue(key, async () => {
            await starGit(home.environmentId).setRemote(home.root, null, false);
            this.change(key, {
              note: "Not syncing: the repository stays as it is.",
              failure: null,
            });
            await rereadStars(home.environmentId);
            return true;
          });
        }),
      );
      return;
    }
    const problem = originProblem(origin);
    if (problem !== undefined) return notify("error", problem);
    for (const home of homes)
      await this.run(home.environmentId, starId, {
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
          this.run(home.environmentId, starId, {
            kind: "full",
            message: commitMessages.settings,
            manual: false,
            record: changes,
          }),
        ),
    );
  }

  /** Sync Star: the Star's repository on every held home where it syncs, in full. */
  async syncNow(starId: string): Promise<void> {
    const star = starById(starId);
    if (star === undefined) return;
    const homes = star.homes.filter(
      (home) => held(home.environmentId) && home.origin !== undefined,
    );
    if (homes.length === 0)
      return notify(
        "info",
        `${starName(star)} does not sync: give it an origin in Pult's settings, under Star.`,
      );
    for (const home of homes)
      void this.run(home.environmentId, starId, {
        kind: "full",
        message: commitMessages.sync,
        manual: true,
      });
  }

  /**
   * After transcripts the plugin wrote into a home appeared in its answer:
   * their conversation's commit, named by the newest one's title and end as
   * its transcript route reads them, and a push where the repository syncs;
   * nothing while a channel of the Star's is open on that home, whose
   * conversation writes in its folder, its sleep committing it then
   * (`afterSleeps`). Until sync moves to the plugin, a transcript waits for
   * a page to commit it (`star-sync`).
   */
  private async afterTranscripts({ environmentId, starId, names }: FoundTranscripts) {
    const star = starById(starId);
    if (star === undefined || !homeSleeps(environmentId, star, known)) return;
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
    await this.run(environmentId, starId, {
      kind: "full",
      message: () =>
        commitMessages.conversation(
          transcript?.title ?? newest ?? "",
          transcript?.ended ?? new Date().toISOString(),
        ),
      manual: false,
    });
  }

  /**
   * After the watch told of a transcript written for a channel but
   * `user`'s, which no answer names: a full occasion on each of those
   * Stars' homes there while the Star sleeps there. The plugin writes a
   * transcript after it settles the thread, so the occasion of a sleep the
   * page sees at the settle can run before the file is there.
   */
  private afterChannelTranscripts({ environmentId, starIds }: WrittenChannelTranscripts): void {
    for (const starId of starIds) {
      const star = starById(starId);
      if (star === undefined || !homeSleeps(environmentId, star, known)) continue;
      void this.run(environmentId, starId, {
        kind: "full",
        message: commitMessages.sync,
        manual: false,
      });
    }
  }

  /** Before a sleeping Star wakes, its draft written in: a pull of its repository there, at most once a minute, so the send never waits on it. */
  private beforeWake(star: Star, environmentId: string): void {
    if (!homeSleeps(environmentId, star, known)) return;
    if (homeOf(star.id, environmentId)?.origin === undefined || !ready(environmentId)) return;
    const key = homeKey(environmentId, star.id);
    const now = Date.now();
    if (now - (this.pulledAt.get(key) ?? 0) < WAKE_PULL_INTERVAL_MS) return;
    this.pulledAt.set(key, now);
    void this.run(environmentId, star.id, {
      kind: "pull",
      message: commitMessages.sync,
      manual: false,
    });
  }

  /** Runs `task` on the home's repository after what runs or waits there; whether it did what it set out to. */
  private queue(key: string, task: () => Promise<boolean>): Promise<boolean> {
    const next = (this.chains.get(key) ?? Promise.resolve(true)).then(task);
    this.chains.set(key, next);
    return next;
  }

  private run(environmentId: string, starId: string, occasion: Occasion): Promise<boolean> {
    return this.queue(homeKey(environmentId, starId), () =>
      this.sync(environmentId, starId, occasion),
    );
  }

  /**
   * The occasion on the Star's repository on the environment as the page
   * holds it when its turn comes: made a repository where its folder is
   * not one (`ownRepository`), pointed at the origin being set and
   * fetched, or its own origin fetched; then what the plan says. Whether
   * it synced.
   */
  private async sync(environmentId: string, starId: string, occasion: Occasion): Promise<boolean> {
    const star = starById(starId);
    const home = star?.homes.find((each) => each.environmentId === environmentId);
    const origin = occasion.origin ?? home?.origin;
    if (
      star === undefined ||
      home === undefined ||
      (occasion.kind === "pull" && origin === undefined)
    )
      return false;
    const key = homeKey(environmentId, starId);
    const git = starGit(environmentId);
    const name = environmentName(environmentId);
    this.change(key, { busy: occasion.kind === "pull" ? "Pulling…" : "Syncing…" });
    try {
      await ownRepository(git, home);
      if (origin !== undefined) await git.setRemote(home.root, origin, true);
      const status = await git.status(home.root);
      const plan = syncPlan(status, occasion.kind, {
        writes: occasion.record !== undefined,
        // A new origin may not have the branch its stale upstream names.
        published: occasion.origin === undefined || occasion.origin === home.origin,
        remote: origin !== undefined,
      });
      if (plan.kind === "diverged") return await this.handOff(starId, home, occasion, status);
      if (plan.pull) {
        try {
          await git.pull(home.root);
        } catch (error) {
          if (!refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(starId, home, occasion, status);
        }
      }
      if (
        occasion.record !== undefined &&
        !(await setStarFields(starId, occasion.record, environmentId))
      )
        return false;
      if (plan.commit) await git.stacked(home.root, "commit", occasion.message(name), null);
      if (plan.push) {
        try {
          await git.stacked(home.root, "push", occasion.message(name), null);
        } catch (error) {
          // A tracked branch's rejected push is a fetch behind, which the next occasion reads; a first one meets the origin's own history.
          if (plan.pull || !refusedByGit(errorMessage(error))) throw error;
          return await this.handOff(starId, home, occasion, status);
        }
      }
      this.change(key, { lastSync: Date.now(), failure: null, note: null });
      if (occasion.manual && origin !== undefined)
        await notify(
          "info",
          `${starName(star)} is in sync with ${origin}${onWhich(environmentId)}.`,
        );
      return true;
    } catch (error) {
      const message = errorMessage(error);
      console.warn(
        `[pult-shell] could not sync the Star at ${home.root} on ${environmentId}: ${message}`,
      );
      this.change(key, { failure: message });
      await notify(
        "error",
        `Pult could not sync ${starName(star)}${onWhich(environmentId)}: ${message}`,
      );
      return false;
    } finally {
      this.change(key, { busy: null });
      // A pull or a commit changes the folder, which a watch tells late, or not at all on a server without one.
      await rereadStars(environmentId);
    }
  }

  /**
   * Hands a divergence of the Star's repository on a home to the Star, as
   * the first message of a conversation it wakes in, on that home's
   * project, `user`'s, with the modes of `user`'s latest conversation
   * (`handoffModel`) and the Star's model choice for `user` at them, which
   * its plugin resolves as the handoff wakes, else that conversation's;
   * once, its thread's id deterministic from the repository and both sides
   * (`handoffThreadId`), looked up on the
   * server, so no page, and no reload, hands the same divergence over
   * again. While a channel of the Star's is open there, or it is being
   * written to, or about to be (a pull before its wake), it gets it when it
   * falls asleep, that sleep's occasion finding it again (`afterSleeps`),
   * or on the next occasion after. Never a sync: false.
   */
  private async handOff(
    starId: string,
    home: StarHome,
    occasion: Occasion,
    status: HomeStatus,
  ): Promise<false> {
    const { environmentId, root } = home;
    const key = homeKey(environmentId, starId);
    const star = starById(starId);
    if (star === undefined) return false;
    const what = `${starName(star)}'s repository${onWhich(environmentId)} has diverged from its origin`;
    const branch = status.branch ?? "HEAD";
    const threadId = await handoffThreadId({
      environmentId,
      root,
      branch,
      head: status.head,
      behind: status.behind,
    });
    if (await threadExists(environmentId, threadId)) {
      this.change(key, { note: `${what}; your Star has it to reconcile.`, failure: null });
      return false;
    }
    const writing = projectDrafts
      .get()
      .some((draft) => draft.environmentId === environmentId && draft.projectId === home.projectId);
    const sleeps = homeSleeps(environmentId, star, known);
    if (!handsOffNow({ sleeps, writing, occasion: occasion.kind })) {
      this.change(key, { note: `${what}; Pult hands it to your Star once it sleeps.` });
      return false;
    }
    const model = handoffModel(
      conversationsOf(star.homes, threadStore.get().threads),
      environmentId,
    );
    if (model === undefined) {
      this.change(key, { note: `${what}; reconcile it with git in ${root}.` });
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
    const chosen = await starWakeModel(starId, environmentId, projection.thread.runtimeMode);
    const text = handoffMessage({
      environmentName: environmentName(environmentId),
      repository: root,
      branch,
      uncommitted: status.uncommitted,
    });
    await runOperation(
      environmentId,
      Operations.startThreadTurn(
        handoffTurn({
          threadId: ThreadId.make(threadId),
          projectId: ProjectId.make(home.projectId),
          messageId: MessageId.make(globalThis.crypto.randomUUID()),
          text,
          createdAt: new Date().toISOString(),
          chosen: chosen === null ? null : decodeModel(chosen),
          conversation: projection.thread,
        }),
      ),
    );
    this.change(key, { note: `${what}; your Star has it to reconcile.`, failure: null });
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

/** The Star's origin, on its repository on every held home; empty, none. */
export const setStarOrigin = (starId: string, url: string) => sync.setOrigin(starId, url);
/** Name and Tint, written after each home's pull and committed. */
export const setStarRecord = (starId: string, changes: RecordFields) =>
  sync.setRecord(starId, changes);
export const syncStar = (starId: string) => sync.syncNow(starId);
/** The sync of the Star's repository on the environment, as the page last ran it. */
export const starRepositorySync = (environmentId: string, starId: string) =>
  sync.repository(environmentId, starId);
