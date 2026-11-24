import {
  getService,
  ICommandService,
  INotificationService,
  IStorageService,
} from "@codingame/monaco-vscode-api";
import Severity from "@codingame/monaco-vscode-api/vscode/vs/base/common/severity";
import { StorageScope } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";

import { connection } from "../connection/index.ts";
import type { Disposable } from "../files/files.ts";
import { environmentServer } from "../files/server.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import { onDidChangePluginFeatures, pluginFeatures } from "./about.ts";
import { refreshTranscripts } from "./foldState.ts";
import { hiddenProjects, setHiddenProjects } from "./hidden.ts";
import {
  CHANNEL_MODELS_FEATURE,
  CHANNEL_SLEEP_FEATURE,
  channelTranscriptStars,
  createStarOn,
  type Credential,
  defaultTranscriptStars,
  PluginAnswerError,
  writeStarRecord,
  type RecordFields,
  readStars,
  readWakeModel,
  type RouteModel,
  sleepChannelOn,
  STARS_FEATURE,
  type StarsAnswer,
} from "./plugin.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { originOf } from "./sync.ts";
import {
  creationTarget,
  type EnvironmentAnswer,
  findStarOfProject,
  findStarOfThread,
  newTranscripts,
  type Star,
  type StarHome,
  starName,
  starsOf,
  starsSignature,
  wakeHome,
} from "./stars.ts";

/** How long a burst of changes under the Stars directory, or of a Star's threads, settles before the page asks again. */
const REREAD_DELAY_MS = 300;
/** A re-read that failed after a good answer is tried again this long after. */
const RETRY_DELAY_MS = 30_000;

/** Where the page kept which transcripts it wrote, before the plugin wrote them: cleared at startup. */
const RETIRED_TRANSCRIPTS_KEY = "pult.stars.transcripts";

/** What the Star's tab mounts, in its environment: its current conversation, or while it sleeps its project's draft. */
export type StarTarget = import("../../view/main.tsx").ViewTarget;

/** Transcripts that appeared in a home since the page's earlier answer for it. */
export interface FoundTranscripts {
  readonly environmentId: string;
  readonly starId: string;
  readonly names: ReadonlyArray<string>;
}

/** Stars of a home whose channels but the default one may have had a transcript written, which no answer names. */
export interface WrittenChannelTranscripts {
  readonly environmentId: string;
  readonly starIds: ReadonlyArray<string>;
}

/** How the page stands with an environment's Stars. */
interface Reading {
  /** The plugin's features this reading last acted on, `about`'s of one connect. */
  features: ReadonlySet<string> | undefined;
  /** Pending until `about` and, where it lists `stars`, the first answer are in; none without the plugin. */
  status: "pending" | "read" | "none" | "failed";
  answer: StarsAnswer | undefined;
  /** Each Star's repository's origin here, by id, from its folder's `.git/config`, read with each answer. */
  origins: ReadonlyMap<string, string>;
  /** Whether the page asked for a Star on it since it last connected. */
  attempted: boolean;
  wasReady: boolean;
  /** Whether `answer` was taken since the environment last became ready, so it is this connect's (`notify.ts`). */
  answeredSinceReady: boolean;
  watch: { readonly directory: string; disposable: Disposable | undefined } | undefined;
  /** What, changing, makes the page ask again: the environment's projects and its Stars' root threads; undefined until its threads are in. */
  trigger: string | undefined;
  /** The latest ask's, so an older one that answers late is dropped. */
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

/** What holds a Star awake, as the plugin names it, in words. */
function holdText(heldBy: string): string {
  switch (heldBy) {
    case "run":
      return "it is working";
    case "queued":
      return "a message waits for its turn";
    case "subagent":
      return "a thread below it still works";
    case "request":
      return "it waits for your answer";
    case "background-work":
      return "it waits on work running in the background";
    case "usage-limit":
      return "a usage limit stopped it, until it resumes or is settled";
    default:
      return `held by ${heldBy}`;
  }
}

/**
 * The home whose conversation in the channel `slug` Refresh Context ends,
 * that channel's alone: the channel open and not working, in a conversation
 * its home's plugin reads with a deadline, no hold, on an environment whose
 * plugin lists `star-channel-sleep`.
 */
function sleepableHome(star: Star, slug: string): StarHome | undefined {
  const open = star.channels.find((channel) => channel.slug === slug)?.thread;
  if (open === undefined || open.working) return undefined;
  const home = star.homes.find((each) => each.environmentId === open.environmentId);
  const read = home?.channels.find((channel) => channel.slug === slug);
  return home !== undefined &&
    read?.threadId === open.id &&
    "at" in read.sleeps &&
    pluginFeatures(home.environmentId)?.has(CHANNEL_SLEEP_FEATURE) === true
    ? home
    : undefined;
}

/** The environments told answering in another shape, each once per page session. */
const misshapen = new Set<string>();

/** The URL of the `origin` of a Star's repository, from its folder's `.git/config`, git's own format; undefined where it is no repository or has none. */
async function originAt(environmentId: string, root: string): Promise<string | undefined> {
  const config = await environmentServer(environmentId).readFile({
    cwd: root,
    relativePath: ".git/config",
    allowMissing: true,
  });
  return config.exists === false ? undefined : originOf(config.contents);
}

/**
 * The page's Stars (xaxis `pult/tasks/durable-agent-sleep.task/design.md`, The page on
 * the routes): on each held environment, what its Pult plugin's `stars`
 * route serves, read once its `about` lists `stars` on each connect, and
 * again a moment after a burst of changes under its Stars directory
 * (`projects.watchEntries`), after the environment's projects change or a
 * root thread of a hidden project appears, settles or un-settles, after the
 * page's own writes, and after each sync occasion (`syncing.ts`); merged by
 * id into Stars over the store's threads (`stars.ts`). Each answer's hidden
 * projects go to `hidden.ts`, where the thread model waits for them. A
 * server whose `about` lists no `stars`, or whose answer fails, shows no
 * Star and hides nothing. While Show Star is on and the page holds no Star
 * once every environment has answered, it asks the first ready one with the
 * plugin for one (`creationTarget`).
 */
class StarsModel {
  /** By environment id, as the connection holds them. */
  private readonly readings = new Map<string, Reading>();
  private stars: ReadonlyArray<Star> = [];
  private signature = "";
  private readonly listeners = new Set<() => void>();
  private readonly transcriptListeners = new Set<(found: FoundTranscripts) => void>();
  private readonly channelTranscriptListeners = new Set<
    (written: WrittenChannelTranscripts) => void
  >();
  /** While a creation runs, until its re-read has landed: one at a time, across the environments. */
  private creating = false;
  /** Since a creation failed, until an environment connects: no creation by default anywhere. */
  private halted = false;

  start(): void {
    connection.onDidChange(() => this.follow());
    onDidChangePluginFeatures(() => this.follow());
    threadStore.subscribe(() => {
      this.askOnChange();
      this.update();
    });
    starEnabled.subscribe(() => this.update());
    void getService(IStorageService).then((storage) =>
      storage.remove(RETIRED_TRANSCRIPTS_KEY, StorageScope.APPLICATION),
    );
    this.follow();
  }

  get(): ReadonlyArray<Star> {
    return this.stars;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDidFindTranscripts(listener: (found: FoundTranscripts) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  onDidWriteChannelTranscripts(listener: (written: WrittenChannelTranscripts) => void): () => void {
    this.channelTranscriptListeners.add(listener);
    return () => this.channelTranscriptListeners.delete(listener);
  }

  /** Whether every ready environment has answered, so each Star has all the homes the page can see. */
  allRead(): boolean {
    return connection.environments.every(
      (environment) =>
        environment.phase !== "ready" ||
        this.readings.get(environment.environmentId)?.status !== "pending",
    );
  }

  /** Whether the environment's plugin answered its Stars, the answer the page holds its Stars there by. */
  readOn(environmentId: string): boolean {
    return this.readings.get(environmentId)?.status === "read";
  }

  answeredOn(environmentId: string): boolean {
    return this.readings.get(environmentId)?.answeredSinceReady === true;
  }

  /** Whether a Star may be created on the environment by hand: it is ready and its plugin serves Stars. */
  canCreateOn(environmentId: string): boolean {
    return (
      this.readings.get(environmentId)?.status === "read" &&
      connection.environment(environmentId)?.phase === "ready"
    );
  }

  /**
   * Follows every environment the connection holds and no other, asking
   * each one's Stars as its plugin's `about` of a connect comes in; one
   * whose `about` lists no `stars` has none, and hides nothing. What an
   * environment answered stands while it reconnects, until it answers again.
   */
  private follow(): void {
    for (const [environmentId, reading] of this.readings) {
      if (connection.environment(environmentId) !== undefined) continue;
      reading.watch?.disposable?.dispose();
      clearTimeout(reading.timer);
      this.readings.delete(environmentId);
      setHiddenProjects(environmentId, undefined);
    }
    for (const environment of connection.environments) {
      const environmentId = environment.environmentId;
      let reading = this.readings.get(environmentId);
      if (reading === undefined) {
        reading = {
          features: undefined,
          status: "pending",
          answer: undefined,
          origins: new Map(),
          attempted: false,
          wasReady: false,
          answeredSinceReady: false,
          watch: undefined,
          trigger: undefined,
          generation: 0,
          timer: undefined,
        };
        this.readings.set(environmentId, reading);
      }
      const ready = environment.phase === "ready";
      if (ready && !reading.wasReady) {
        // A failed creation is tried again on the next connect.
        reading.attempted = false;
        this.halted = false;
      }
      if (!ready || !reading.wasReady) reading.answeredSinceReady = false;
      reading.wasReady = ready;
      const features = pluginFeatures(environmentId);
      if (features === undefined || features === reading.features) continue;
      reading.features = features;
      if (features.has(STARS_FEATURE)) void this.read(environmentId);
      else this.drop(environmentId, reading, "none");
    }
    this.update();
  }

  /** No Stars on the environment, nothing hidden there: a server without the plugin, or one whose answer failed. */
  private drop(environmentId: string, reading: Reading, status: "none" | "failed"): void {
    reading.generation++;
    reading.status = status;
    reading.answer = undefined;
    reading.origins = new Map();
    reading.trigger = undefined;
    reading.watch?.disposable?.dispose();
    reading.watch = undefined;
    setHiddenProjects(environmentId, new Set());
  }

  /** Asks the environment's plugin for its Stars again, where its `about` lists them. */
  async read(environmentId: string): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading?.features?.has(STARS_FEATURE) !== true) return;
    const generation = ++reading.generation;
    const current = () =>
      reading.generation === generation && this.readings.get(environmentId) === reading;
    try {
      const answer = await readStars(this.credential(environmentId));
      const origins = new Map<string, string>();
      await Promise.all(
        answer.stars.map(async (star) => {
          const origin = await originAt(environmentId, star.root).catch((error: unknown) => {
            console.warn(
              `[pult-shell] could not read where the Star ${star.id} of ${environmentId} syncs: ${errorMessage(error)}`,
            );
            return reading.origins.get(star.id);
          });
          if (origin !== undefined) origins.set(star.id, origin);
        }),
      );
      if (current()) this.take(environmentId, reading, answer, origins);
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof PluginAnswerError))
        console.warn(
          `[pult-shell] could not read the Stars of ${environmentId}: ${errorMessage(error)}`,
        );
      else if (!misshapen.has(environmentId)) {
        misshapen.add(environmentId);
        console.warn(
          `[pult-shell] the Pult plugin of ${environmentId} answered its Stars in another shape, so the page shows none there: ${error.message}`,
        );
      }
      // A re-read that fails keeps the last answer drawn, as a reconnect does, and is tried again;
      // a first read that fails, or an answer of another shape, shows no Star there.
      if (reading.status === "read" && !(error instanceof PluginAnswerError)) {
        clearTimeout(reading.timer);
        reading.timer = setTimeout(() => void this.read(environmentId), RETRY_DELAY_MS);
        return;
      }
      this.drop(environmentId, reading, "failed");
      this.update();
    }
  }

  private credential(environmentId: string): Credential {
    const credential = connection.credential(environmentId);
    if (credential === undefined) throw new Error(`the page holds no bearer for ${environmentId}`);
    return credential;
  }

  /** An answer, the fresh state: its hidden projects published, its new transcripts told, its directory watched while it holds a Star. */
  private take(
    environmentId: string,
    reading: Reading,
    answer: StarsAnswer,
    origins: ReadonlyMap<string, string>,
  ): void {
    const found = newTranscripts(reading.answer, answer);
    reading.answer = answer;
    reading.origins = origins;
    reading.status = "read";
    reading.answeredSinceReady = connection.environment(environmentId)?.phase === "ready";
    // The thread model publishes as the hidden projects change: no ask for what this answer brings.
    reading.trigger = undefined;
    setHiddenProjects(environmentId, new Set(answer.hidden));
    reading.trigger = this.triggerOf(environmentId);
    if (answer.stars.length > 0) this.watch(environmentId, reading, answer.directory);
    this.update();
    for (const { starId, names } of found)
      for (const listener of this.transcriptListeners) listener({ environmentId, starId, names });
  }

  private askSoon(environmentId: string, reading: Reading): void {
    clearTimeout(reading.timer);
    reading.timer = setTimeout(() => void this.read(environmentId), REREAD_DELAY_MS);
  }

  /** The environment's projects and its hidden projects' root threads, settled or not, by the store; undefined until its threads are in. */
  private triggerOf(environmentId: string): string | undefined {
    if (threadStore.environment(environmentId)?.loaded !== true) return undefined;
    const hidden = hiddenProjects(environmentId) ?? new Set();
    const { projects, threads } = threadStore.get();
    return JSON.stringify([
      projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => project.id)
        .toSorted(),
      threads
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.parentId === null &&
            hidden.has(thread.projectId),
        )
        .map((thread) => `${thread.id}:${thread.settled}`)
        .toSorted(),
    ]);
  }

  /** Asks again where a project came or went or a Star's root thread appeared, settled or un-settled since the last answer. */
  private askOnChange(): void {
    for (const [environmentId, reading] of this.readings) {
      if (reading.status !== "read") continue;
      const trigger = this.triggerOf(environmentId);
      if (trigger === reading.trigger) continue;
      const known = reading.trigger !== undefined;
      reading.trigger = trigger;
      if (known && trigger !== undefined) this.askSoon(environmentId, reading);
    }
  }

  /**
   * Watches the Stars directory, where the server can, asking again a
   * moment after each burst of changes. The reading's watch is held while
   * the server's features are asked, so an answer meanwhile starts no
   * second one, and the watch starts only if the model still follows the
   * reading and that is still its watch.
   */
  private watch(environmentId: string, reading: Reading, directory: string): void {
    if (reading.watch?.directory === directory) return;
    reading.watch?.disposable?.dispose();
    const watch: NonNullable<Reading["watch"]> = { directory, disposable: undefined };
    reading.watch = watch;
    const server = environmentServer(environmentId);
    void server.features().then(
      (features) => {
        if (!features.watchEntries || reading.watch !== watch) return;
        watch.disposable = server.watchEntries(directory, {
          subscribed: async () => {},
          changed: (event) => {
            // A transcript of a default channel's the plugin rewrote is read again where the fold shows it; any change asks for the Stars again.
            if (reading.answer !== undefined)
              for (const id of defaultTranscriptStars(event, reading.answer))
                refreshTranscripts(environmentId, id);
            // A channel transcript can be rewritten under the same name.
            const starIds =
              reading.answer === undefined ? [] : channelTranscriptStars(event, reading.answer);
            for (const id of starIds) refreshTranscripts(environmentId, id);
            if (starIds.length > 0)
              for (const listener of this.channelTranscriptListeners)
                listener({ environmentId, starIds });
            this.askSoon(environmentId, reading);
          },
          gone: () => {
            if (reading.watch === watch) reading.watch = undefined;
            this.askSoon(environmentId, reading);
          },
        });
      },
      (error: unknown) =>
        console.warn(
          `[pult-shell] could not watch the Stars of ${environmentId}: ${errorMessage(error)}`,
        ),
    );
  }

  /** Merges the answers into Stars over the store's threads, tells the listeners when they changed, then asks for a Star where due. */
  private update(): void {
    const answers = connection.environments.flatMap((environment): EnvironmentAnswer[] => {
      const reading = this.readings.get(environment.environmentId);
      return reading?.answer === undefined
        ? []
        : [
            {
              environmentId: environment.environmentId,
              answer: reading.answer,
              origins: reading.origins,
            },
          ];
    });
    const stars = starsOf(answers, threadStore.get().threads);
    // The readings too, which tell where a Star may be created and whether an answer is this connect's.
    const signature = JSON.stringify([
      starsSignature(stars),
      [...this.readings.values()].map((reading) => [reading.status, reading.answeredSinceReady]),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.stars = stars;
      for (const listener of this.listeners) listener();
    }
    const enabled = starSettingKnown() && starEnabled.get();
    const target = creationTarget({
      enabled,
      restoring: connection.connecting,
      halted: this.halted,
      stars: new Set(answers.flatMap(({ answer }) => answer.stars.map((star) => star.id))).size,
      environments: connection.environments.map((environment) => {
        const reading = this.readings.get(environment.environmentId);
        return {
          id: environment.environmentId,
          phase: environment.phase,
          loaded: threadStore.environment(environment.environmentId)?.loaded === true,
          read: reading?.status ?? "pending",
          attempted: reading?.attempted ?? false,
        };
      }),
    });
    if (target !== undefined && !this.creating) void this.create(target, { ifNone: true });
  }

  /**
   * Asks the environment's plugin for a Star, which makes it in a fresh
   * folder (`POST /stars`): by default only while the server has none
   * (`ifNone`), so two pages make one, unnamed, and by Create Star always,
   * with the `name` it asked for, after which the plugin names the folder. One
   * notification says the Star is ready; a failure notifies, and is tried
   * again on the next connect, with no creation by default anywhere until
   * one connects.
   */
  async create(
    environmentId: string,
    how: { readonly ifNone: boolean; readonly name?: string },
  ): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading === undefined || this.creating) return;
    reading.attempted = true;
    this.creating = true;
    const notifications = await getService(INotificationService);
    try {
      const star = await createStarOn(this.credential(environmentId), how);
      notifications.prompt(Severity.Info, "Your Star is ready.", [
        { label: "Open Star", run: () => void openStar(star.id) },
      ]);
    } catch (error) {
      this.halted = true;
      notifications.error(`Pult could not create your Star: ${errorMessage(error)}`);
    } finally {
      await this.read(environmentId);
      this.creating = false;
      this.update();
    }
  }

  /**
   * Refresh Context: puts the current conversation of the Star's channel
   * `slug` to sleep through its home's plugin (`POST /stars/<id>/sleep`),
   * which looks again under the Star's lock; a hold that appeared since, or
   * a failure, notifies.
   */
  async sleep(star: Star, slug: string): Promise<void> {
    const notifications = await getService(INotificationService);
    const home = sleepableHome(star, slug);
    const what = `${starName(star)}'s channel ${slug}`;
    if (home === undefined) return notifications.info(`${what} has no conversation to end now.`);
    try {
      const answer = await sleepChannelOn(this.credential(home.environmentId), star.id, slug);
      if (!answer.slept) notifications.info(`${what} stays awake: ${holdText(answer.heldBy)}.`);
    } catch (error) {
      notifications.error(`Pult could not refresh your Star's context: ${errorMessage(error)}`);
    } finally {
      await this.read(home.environmentId);
    }
  }

  /**
   * The model the page wakes the Star's `channel` at itself on the
   * environment, at `runtimeMode`, through its plugin (`POST /stars/<id>/model`), which
   * tells the channel of a file it cannot serve: the Star's choice, or
   * null for the page's own, which is also what a plugin without the feature
   * and a failure, logged, answer.
   */
  async wakeModel(
    starId: string,
    environmentId: string,
    runtimeMode: string,
    channel: string,
  ): Promise<RouteModel | null> {
    if (pluginFeatures(environmentId)?.has(CHANNEL_MODELS_FEATURE) !== true) return null;
    try {
      return await readWakeModel(this.credential(environmentId), starId, runtimeMode, channel);
    } catch (error) {
      console.warn(
        `[pult-shell] the Star's model choice could not be read; it wakes at its own: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Writes editable fields into the Star's record on the environment, through
   * its plugin (`POST /stars/<id>`), which retitles its project too; a
   * failure notifies. Whether it took. `syncing.ts` (`setStarRecord`) runs
   * it on each home after that home's pull, and commits it.
   */
  async setFields(starId: string, changes: RecordFields, environmentId: string): Promise<boolean> {
    try {
      const recorded = await writeStarRecord(this.credential(environmentId), starId, changes);
      if (changes.description !== undefined && recorded.description !== changes.description)
        throw new Error("This environment did not save the description.");
      return true;
    } catch (error) {
      (await getService(INotificationService)).error(
        `Pult could not change your Star: ${errorMessage(error)}`,
      );
      return false;
    } finally {
      await this.read(environmentId);
    }
  }
}

/** Selects the Star, through its command, which `selection.ts` registers. */
async function openStar(starId: string): Promise<void> {
  await (await getService(ICommandService)).executeCommand("pult-shell.selectStar", starId);
}

const model = new StarsModel();

/** Starts the Stars' model on the page's connection, thread model and plugins' `about`; before the workbench, as they are. */
export function startStars(): void {
  model.start();
}

/** The page's Stars, for `useSyncExternalStore`: the same array until a Star changes. */
export const starStore = {
  get: () => model.get(),
  subscribe: (listener: () => void) => model.subscribe(listener),
};

export function starById(starId: string): Star | undefined {
  return model.get().find((star) => star.id === starId);
}

/** Asks for a new Star named `name` on the environment. */
export const createStar = (environmentId: string, name: string) =>
  model.create(environmentId, { ifNone: false, name });
/** The model the page wakes the Star's `channel` at itself, telling the channel of a broken file; null for the page's own (`StarsModel.wakeModel`). */
export const starWakeModel = (
  starId: string,
  environmentId: string,
  runtimeMode: string,
  channel: string,
) => model.wakeModel(starId, environmentId, runtimeMode, channel);
/** Asks the environment's plugin for its Stars again: after a sync occasion, which a watch may tell late or not at all. */
export const rereadStars = (environmentId: string) => model.read(environmentId);
export const canCreateStarOn = (environmentId: string) => model.canCreateOn(environmentId);
/** Whether every ready environment has answered (`syncing.ts` waits for it). */
export const starsRead = () => model.allRead();
export const starsReadOn = (environmentId: string) => model.readOn(environmentId);
/** Whether the environment's Stars were answered since it last became ready: its first answer after a connect is the notices' baseline (`notify.ts`). */
export const starsAnsweredOn = (environmentId: string) => model.answeredOn(environmentId);
export const setStarFields = (starId: string, changes: RecordFields, environmentId: string) =>
  model.setFields(starId, changes, environmentId);
/** Whether Refresh Context is offered for the Star's channel `slug`: open, unheld, its home's plugin listing `star-channel-sleep`. */
export const canSleepChannel = (star: Star, slug: string) =>
  sleepableHome(star, slug) !== undefined;
/** Refresh Context: ends the current conversation of the Star's channel `slug`, its next message waking it in a fresh one. */
export const sleepChannel = (star: Star, slug: string) => model.sleep(star, slug);
/** Calls `listener` with the transcripts that appeared in a home since the page's earlier answer for it. */
export const onDidFindStarTranscripts = (listener: (found: FoundTranscripts) => void) =>
  model.onDidFindTranscripts(listener);
/** Calls `listener` as the Stars directory's watch tells of a transcript written for a channel but the default one (`channelTranscriptStars`). */
export const onDidWriteStarChannelTranscripts = (
  listener: (written: WrittenChannelTranscripts) => void,
) => model.onDidWriteChannelTranscripts(listener);

/** Whether the page holds the environment. */
const held = (environmentId: string) => connection.environment(environmentId) !== undefined;

/** A channel's tab among a Star's: the channel on one home. */
export interface ChannelTab {
  readonly environmentId: string;
  readonly slug: string;
}
/**
 * What the Star's tab shows: its current conversation, or while it sleeps
 * its default channel's draft in the home it wakes in (`wakeHome`); or a
 * channel's tab's, its conversation on its home, else its draft there;
 * undefined while none of its homes is on a held environment.
 */
export function starTarget(star: Star, channel?: ChannelTab): StarTarget | undefined {
  if (channel) {
    const home = star.homes.find((each) => each.environmentId === channel.environmentId);
    if (!home) return undefined;
    const open = home.channels.find((each) => each.slug === channel.slug);
    return open
      ? { kind: "thread", environmentId: home.environmentId, threadId: open.threadId }
      : {
          kind: "draft",
          environmentId: home.environmentId,
          projectId: home.projectId,
          tags: [`pult:channel:${channel.slug}`],
        };
  }
  if (star.current !== null)
    return { kind: "thread", environmentId: star.current.environmentId, threadId: star.current.id };
  const home = wakeHome(star, held);
  return home === undefined
    ? undefined
    : {
        kind: "draft",
        environmentId: home.environmentId,
        projectId: home.projectId,
        tags: [`pult:channel:${star.defaultChannel}`],
      };
}

/** The home whose folder stands for the Star, its instructions and its folder: its current conversation's or wake's, else its first held one. */
export function primaryHome(star: Star) {
  const target = starTarget(star);
  return (
    star.homes.find(
      (home) => home.environmentId === target?.environmentId && held(home.environmentId),
    ) ?? star.homes.find((home) => held(home.environmentId))
  );
}

/** The Star a thread is the conversation of: a root thread of one of its homes' projects, in any state. */
export function starOfThread(
  thread: Pick<ShellThread, "environmentId" | "projectId" | "parentId">,
): Star | undefined {
  return findStarOfThread(model.get(), thread);
}

/** The Star whose home `projectId` is. */
export function starOfProject(environmentId: string, projectId: string): Star | undefined {
  return findStarOfProject(model.get(), environmentId, projectId);
}

/** The model a sleeping channel's draft wakes it at, read from its home's plugin (`POST stars/<id>/model`) each time its ask is opened; null until read, and for the page's own. */
export function channelModel(starId: string, environmentId: string, channel: string) {
  let value: RouteModel | null = null;
  const listeners = new Set<() => void>();
  void starWakeModel(starId, environmentId, "full-access", channel).then((model) => {
    value = model;
    for (const listener of listeners) listener();
  });
  return {
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
