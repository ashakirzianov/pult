import {
  getService,
  ICommandService,
  INotificationService,
  IStorageService,
} from "@codingame/monaco-vscode-api";
import Severity from "@codingame/monaco-vscode-api/vscode/vs/base/common/severity";
import { StorageScope } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";

import { connection } from "../connection/index.ts";
import { type Disposable, toFilesError, type WorkspaceServer } from "../files/files.ts";
import { environmentServer } from "../files/server.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import { onDidChangePluginFeatures, pluginFeatures } from "./about.ts";
import { refreshTranscripts } from "./foldState.ts";
import { starGit } from "./git.ts";
import { hiddenProjects, setHiddenProjects } from "./hidden.ts";
import {
  createStarOn,
  type Credential,
  PluginAnswerError,
  writeStarRecord,
  readStars,
  STARS_FEATURE,
  type StarsAnswer,
  upkeepStars,
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
  starsOf,
  wakeHome,
} from "./stars.ts";

/** How long a burst of changes under the Stars directory, or of a Star's threads, settles before the page asks again. */
const REREAD_DELAY_MS = 300;
/** A re-read that failed after a good answer is tried again this long after. */
const RETRY_DELAY_MS = 30_000;

/** Where the page kept which transcripts it wrote, before the plugin wrote them: cleared at startup. */
const RETIRED_TRANSCRIPTS_KEY = "pult.stars.transcripts";

/** What the Star's tab mounts, in its environment: its current conversation, or while it sleeps its project's draft. */
export type StarTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string };

/** The environment's Stars' repository, its Stars directory, and where it syncs. */
export interface StarRepository {
  readonly environmentId: string;
  readonly root: string;
  readonly origin?: string;
}

/** Transcripts that appeared in a home since the page's earlier answer for it. */
export interface FoundTranscripts {
  readonly environmentId: string;
  readonly starId: string;
  readonly names: ReadonlyArray<string>;
}

/** How the page stands with an environment's Stars. */
interface Reading {
  /** The plugin's features this reading last acted on, `about`'s of one connect. */
  features: ReadonlySet<string> | undefined;
  /** Pending until `about` and, where it lists `stars`, the first answer are in; none without the plugin. */
  status: "pending" | "read" | "none" | "failed";
  answer: StarsAnswer | undefined;
  /** The Stars' repository's origin, from its `.git/config`, read with each answer. */
  origin: string | undefined;
  /** Whether the page asked for a Star on it since it last connected. */
  attempted: boolean;
  wasReady: boolean;
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

/** The environments told answering in another shape, each once per page session. */
const misshapen = new Set<string>();

/** A host path's parent and last segment, as the server takes a listing of it. */
function split(path: string): { readonly parent: string; readonly name: string } {
  const trimmed = path.replace(/[/\\]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return { parent: at <= 0 ? "/" : trimmed.slice(0, at), name: trimmed.slice(at + 1) };
}

/**
 * Whether the directory is missing or holds nothing, where a clone may go.
 * The server fails the listing of a missing directory as it fails any
 * other, so a failed listing is absence only when a read of the path finds
 * nothing there.
 */
async function vacant(server: WorkspaceServer, directory: string): Promise<boolean> {
  const { parent, name } = split(directory);
  try {
    return (await server.listEntries({ cwd: parent, directoryPath: name })).entries.length === 0;
  } catch (error) {
    if (toFilesError(error, name).code !== "FileNotFound") throw error;
    const there = await server
      .readFile({ cwd: parent, relativePath: name, allowMissing: true })
      .catch(() => undefined);
    if (there?.exists === false) return true;
    throw error;
  }
}

/** The URL of the Stars' repository's `origin`, from its `.git/config`, git's own format; undefined where it is no repository or has none. */
async function originAt(environmentId: string, directory: string): Promise<string | undefined> {
  const config = await environmentServer(environmentId).readFile({
    cwd: directory,
    relativePath: ".git/config",
    allowMissing: true,
  });
  return config.exists === false ? undefined : originOf(config.contents);
}

/**
 * The page's Stars (xaxis `pult/design-durable-agent-sleep`, The page on
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

  /** Whether every ready environment has answered, so each Star has all the homes the page can see. */
  allRead(): boolean {
    return connection.environments.every(
      (environment) =>
        environment.phase !== "ready" ||
        this.readings.get(environment.environmentId)?.status !== "pending",
    );
  }

  /** Whether a Star may be created on the environment by hand: it is ready and its plugin serves Stars. */
  canCreateOn(environmentId: string): boolean {
    return (
      this.readings.get(environmentId)?.status === "read" &&
      connection.environment(environmentId)?.phase === "ready"
    );
  }

  repository(environmentId: string): StarRepository | undefined {
    const reading = this.readings.get(environmentId);
    if (reading?.answer === undefined) return undefined;
    return {
      environmentId,
      root: reading.answer.directory,
      ...(reading.origin === undefined ? {} : { origin: reading.origin }),
    };
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
          origin: undefined,
          attempted: false,
          wasReady: false,
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
    reading.origin = undefined;
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
      const origin =
        answer.stars.length === 0
          ? undefined
          : await originAt(environmentId, answer.directory).catch((error: unknown) => {
              console.warn(
                `[pult-shell] could not read where the Stars of ${environmentId} sync: ${errorMessage(error)}`,
              );
              return reading.origin;
            });
      if (current()) this.take(environmentId, reading, answer, origin);
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
    origin: string | undefined,
  ): void {
    const found = newTranscripts(reading.answer, answer);
    reading.answer = answer;
    reading.origin = origin;
    reading.status = "read";
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
            // A transcript the plugin rewrote, its conversation un-settled and settled again, is read again where the fold shows it.
            if (
              event.truncated ||
              event.changes.some((change) => change.path.includes(".pult/conversations/"))
            )
              for (const star of reading.answer?.stars ?? [])
                refreshTranscripts(environmentId, star.id);
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
              ...(reading.origin === undefined ? {} : { origin: reading.origin }),
            },
          ];
    });
    const stars = starsOf(answers, threadStore.get().threads);
    // The readings too, which tell where a Star may be created.
    const signature = JSON.stringify([
      stars.map((star) => [
        star.id,
        star.name,
        star.tint,
        star.origin,
        star.homes,
        star.state,
        star.current?.id,
        star.current?.workingSince,
        star.asleepSince,
      ]),
      [...this.readings.values()].map((reading) => reading.status),
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
   * (`ifNone`), so two pages make one, and by Create Star always. One
   * notification says the Star is ready; a failure notifies, and is tried
   * again on the next connect, with no creation by default anywhere until
   * one connects.
   *
   * With an `origin`, where the page's Stars sync, the environment's Stars
   * directory is a clone of it instead, cloned only where it is missing or
   * empty, every Star in it a home there, made a project by the plugin's
   * upkeep at once (`POST /stars/upkeep`).
   */
  async create(
    environmentId: string,
    how: { readonly ifNone: boolean } | { readonly origin: string },
  ): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading === undefined || this.creating) return;
    reading.attempted = true;
    this.creating = true;
    const notifications = await getService(INotificationService);
    try {
      const credential = this.credential(environmentId);
      if ("origin" in how) {
        const directory = reading.answer?.directory;
        if (directory === undefined)
          throw new Error("the environment's Pult plugin has not said where its Stars live");
        if (!(await vacant(environmentServer(environmentId), directory))) {
          this.halted = true;
          notifications.error(
            `Pult did not clone ${how.origin}: ${directory} holds something already.`,
          );
          return;
        }
        await starGit(environmentId).clone(how.origin, directory);
        await upkeepStars(credential);
        notifications.info(`Your Stars are here too, synced with ${how.origin}.`);
        return;
      }
      const star = await createStarOn(credential, { ifNone: how.ifNone });
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
   * Writes Name or Tint into the Star's record on the environment, through
   * its plugin (`POST /stars/<id>`), which retitles its project too; a
   * failure notifies. Whether it took. `syncing.ts` (`setStarRecord`) runs
   * it on each home after that home's pull, and commits it.
   */
  async setFields(
    starId: string,
    changes: { readonly name?: string; readonly tint?: string },
    environmentId: string,
  ): Promise<boolean> {
    try {
      await writeStarRecord(this.credential(environmentId), starId, changes);
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

/** Asks for a new Star on the environment, or with `origin` clones the Stars' repository syncing through it there. */
export const createStar = (environmentId: string, origin?: string) =>
  model.create(environmentId, origin === undefined ? { ifNone: false } : { origin });
/** Asks the environment's plugin for its Stars again: after a sync occasion, which a watch may tell late or not at all. */
export const rereadStars = (environmentId: string) => model.read(environmentId);
export const canCreateStarOn = (environmentId: string) => model.canCreateOn(environmentId);
/** The environment's Stars' repository, once its plugin answered. */
export const starRepository = (environmentId: string) => model.repository(environmentId);
/** Whether every ready environment has answered (`syncing.ts` waits for it). */
export const starsRead = () => model.allRead();
export const setStarFields = (
  starId: string,
  changes: { readonly name?: string; readonly tint?: string },
  environmentId: string,
) => model.setFields(starId, changes, environmentId);
/** Calls `listener` with the transcripts that appeared in a home since the page's earlier answer for it. */
export const onDidFindStarTranscripts = (listener: (found: FoundTranscripts) => void) =>
  model.onDidFindTranscripts(listener);

/** Whether the page holds the environment. */
const held = (environmentId: string) => connection.environment(environmentId) !== undefined;

/**
 * What the Star's tab shows: its current conversation, or while it sleeps
 * its project's draft in the home it wakes in (`wakeHome`); undefined while
 * none of its homes is on a held environment.
 */
export function starTarget(star: Star): StarTarget | undefined {
  if (star.current !== null)
    return { kind: "thread", environmentId: star.current.environmentId, threadId: star.current.id };
  const home = wakeHome(star, held);
  return home === undefined
    ? undefined
    : { kind: "draft", environmentId: home.environmentId, projectId: home.projectId };
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
