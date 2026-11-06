import { getService, ICommandService, INotificationService } from "@codingame/monaco-vscode-api";
import Severity from "@codingame/monaco-vscode-api/vscode/vs/base/common/severity";
import { request } from "@t3tools/client-runtime/rpc";
import { CommandId, type ProjectMutation, ProjectId, WS_METHODS } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { type Disposable, toFilesError, type WorkspaceServer } from "../files/files.ts";
import { environmentHome, environmentServer } from "../files/server.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import {
  AGENTS_FILE,
  AGENTS_TEXT,
  agentsOutdated,
  CONVERSATIONS_DIRECTORY,
  DEFAULT_STAR_FOLDER,
  INSTRUCTIONS_FILE,
  LEGACY_CONVERSATIONS_DIRECTORY,
  LEGACY_INSTRUCTIONS,
  LEGACY_MEMORY_DIRECTORY,
  newRecord,
  parseRecord,
  RECORD_FILE,
  recordText,
  STAR_PROJECT_ICON,
  type RecordFields,
  STAR_PROJECT_TITLE,
  type StarRecord,
  STARS_DIRECTORY,
  SYSTEM_DIRECTORY,
  withRecordFields,
} from "./record.ts";
import { starGit } from "./git.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { originOf } from "./sync.ts";
import { isTranscriptName, transcriptHead, transcriptsFolder } from "./transcript.ts";
import {
  creationTarget,
  findStarOfProject,
  findStarOfThread,
  foldersToAdopt,
  projectAt,
  type Star,
  type StarFolder,
  type StarHome,
  starName,
  starsOf,
  wakeHome,
} from "./stars.ts";

/** How long a burst of changes under the Stars' folder settles before the page reads it again. */
const REREAD_DELAY_MS = 300;

/** What the Star's tab mounts, in its environment: its current conversation, or while it sleeps its project's draft. */
export type StarTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string };

/** What a folder read needs of the page before it is in the current layout: a legacy one's migration, or Pult's `AGENTS.md`. */
type Upkeep = "migrate" | "agents";

/** The environment's Stars' repository, `~/.pult/stars`, and where it syncs. */
export interface StarRepository {
  readonly environmentId: string;
  readonly root: string;
  readonly origin?: string;
}

/** How the page stands with an environment's Stars' folder. */
interface Reading {
  read: "pending" | "read" | "failed";
  folders: ReadonlyArray<StarFolder>;
  /** The Stars' repository, once read; its origin from its `.git/config`. */
  repository: StarRepository | undefined;
  /** The folders' upkeep due, by root. */
  upkeep: ReadonlyMap<string, Upkeep>;
  /** The roots whose upkeep the page ran since the environment last connected, each once. */
  readonly keptUp: Set<string>;
  /** Whether the last read read every folder, so none of them may be a Star the page cannot see. */
  complete: boolean;
  /** Whether the page tried to create a Star on it, or adopted its folders, since it last connected. */
  attempted: boolean;
  readonly adopted: Set<string>;
  wasReady: boolean;
  watch: Disposable | undefined;
  /** The latest read's, so an older one that answers late is dropped. */
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A host path joined with relative segments, as the environment's server takes it. */
function hostJoin(base: string, ...segments: ReadonlyArray<string>): string {
  return [base.replace(/[/\\]+$/, ""), ...segments].join("/");
}

const lastSegment = (path: string) =>
  path
    .split(/[/\\]/)
    .filter((segment) => segment !== "")
    .at(-1) ?? path;

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

/**
 * A directory's entries, or null for one that is not there. The server
 * fails the listing of a missing directory as it fails any other
 * (`directory_list_failed`), so a failed listing is absence only when a read
 * of the path finds nothing there, which the server tells only of a path
 * that does not exist; any other failure is the listing's.
 */
async function listed(server: WorkspaceServer, cwd: string, directoryPath: string) {
  try {
    return (await server.listEntries({ cwd, directoryPath })).entries;
  } catch (error) {
    if (toFilesError(error, directoryPath).code !== "FileNotFound") throw error;
    const there = await server
      .readFile({ cwd, relativePath: directoryPath, allowMissing: true })
      .catch(() => undefined);
    if (there?.exists === false) return null;
    throw error;
  }
}

/** A file of a Star's folder, or undefined while it has none. */
async function readStarFile(server: WorkspaceServer, root: string, relativePath: string) {
  const file = await server.readFile({ cwd: root, relativePath, allowMissing: true });
  return file.exists === false ? undefined : file;
}

/** A Star's `.pult/star.md`, or undefined while it has none. */
const readRecordFile = (server: WorkspaceServer, root: string) =>
  readStarFile(server, root, RECORD_FILE);

/**
 * The folder at `root` as a Star: its record and the upkeep it needs, from
 * `.pult/star.md`, else from a legacy `AGENTS.md`'s front matter, which is
 * migrated; "other" for a `.pult/star.md` that holds no record; undefined
 * for a folder that is no Star.
 */
async function starAt(
  server: WorkspaceServer,
  root: string,
): Promise<{ readonly record: StarRecord; readonly upkeep: Upkeep | null } | "other" | undefined> {
  const [file, agents] = await Promise.all([
    readRecordFile(server, root),
    readStarFile(server, root, AGENTS_FILE),
  ]);
  if (file !== undefined) {
    const record = parseRecord(file.contents);
    if (record === undefined) return "other";
    return { record, upkeep: agentsOutdated(agents?.contents) ? "agents" : null };
  }
  const legacy = agents === undefined ? undefined : parseRecord(agents.contents);
  return legacy === undefined ? undefined : { record: legacy, upkeep: "migrate" };
}

/** What `root` holds: no Star, a Star (in either layout), or a record file that is someone else's. */
async function recordAt(
  server: WorkspaceServer,
  root: string,
): Promise<"absent" | "star" | "other"> {
  const found = await starAt(server, root);
  return found === undefined ? "absent" : found === "other" ? "other" : "star";
}

/**
 * Moves a legacy Star's folder to the current layout (xaxis
 * `pult/issues/star-folder-layout`), each step skipped where it is done, so
 * a migration cut short finishes on the next read: `conversations/` into
 * `.pult/`, an `instructions.md` pointing at its `memory/`, the record into
 * `.pult/star.md`, and last Pult's `AGENTS.md` over the legacy one, whose
 * record marks the folder as not migrated until then.
 */
async function migrate(server: WorkspaceServer, root: string, record: StarRecord): Promise<void> {
  const legacy = await listed(server, root, LEGACY_CONVERSATIONS_DIRECTORY);
  if (legacy !== null && (await listed(server, root, CONVERSATIONS_DIRECTORY)) === null)
    await server.renameEntry({
      cwd: root,
      relativePath: LEGACY_CONVERSATIONS_DIRECTORY,
      newRelativePath: CONVERSATIONS_DIRECTORY,
    });
  if ((await readStarFile(server, root, INSTRUCTIONS_FILE)) === undefined) {
    const memory = await listed(server, root, LEGACY_MEMORY_DIRECTORY);
    await server.writeFile({
      cwd: root,
      relativePath: INSTRUCTIONS_FILE,
      contents: memory === null ? "" : LEGACY_INSTRUCTIONS,
    });
  }
  if ((await readRecordFile(server, root)) === undefined)
    await server.writeFile({ cwd: root, relativePath: RECORD_FILE, contents: recordText(record) });
  await server.writeFile({ cwd: root, relativePath: AGENTS_FILE, contents: AGENTS_TEXT });
}

/** The URL of the Stars' repository's `origin`, from its `.git/config`; undefined where it is no repository or has none. */
async function originAt(server: WorkspaceServer, repository: string) {
  const config = await readStarFile(server, repository, ".git/config");
  return config === undefined ? undefined : originOf(config.contents);
}

/** When each transcript read ended, by its front matter, by environment, home and name: read once per page session, and again once the page rewrites it. */
const transcriptEnds = new Map<string, string>();
const transcriptKey = (environmentId: string, root: string, name: string) =>
  JSON.stringify([environmentId, root, name]);

/** When the transcript `name` of the home at `root` ended, by its front matter; undefined where it says none or cannot be read. */
async function transcriptEnd(
  server: WorkspaceServer,
  environmentId: string,
  root: string,
  name: string,
): Promise<string | undefined> {
  const key = transcriptKey(environmentId, root, name);
  const known = transcriptEnds.get(key);
  if (known !== undefined) return known;
  try {
    const file = await server.readFile({
      cwd: root,
      relativePath: `${transcriptsFolder(environmentId)}/${name}`,
    });
    const ended = transcriptHead(file.contents)?.ended;
    if (ended !== undefined) transcriptEnds.set(key, ended);
    return ended;
  } catch (error) {
    console.warn(
      `[pult-shell] could not read when the Star's conversation ${name} ended: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * The Stars' folders under the environment's home: each folder of
 * `~/.pult/stars` with a record (`starAt`), and the upkeep each needs, with
 * the repository's origin; null while there is no such directory; each
 * folder read on its own, so one that fails leaves the others, and the read
 * incomplete.
 */
async function readFolders(server: WorkspaceServer, environmentId: string, home: string) {
  const entries = await listed(server, home, STARS_DIRECTORY);
  if (entries === null) return null;
  const repository = hostJoin(home, STARS_DIRECTORY);
  const origin = await originAt(server, repository);
  const results = await Promise.allSettled(
    entries
      // The repository's own `.git`, and anything else hidden, is no Star.
      .filter((entry) => entry.kind === "directory" && !lastSegment(entry.path).startsWith("."))
      .map(async (entry) => {
        const root = hostJoin(home, STARS_DIRECTORY, lastSegment(entry.path));
        const found = await starAt(server, root);
        if (found === undefined || found === "other") return [];
        const { record, upkeep } = found;
        const listing = await listed(server, root, transcriptsFolder(environmentId)).catch(
          () => null,
        );
        const transcripts = (listing ?? [])
          .flatMap((entry) => (entry.kind === "file" ? [lastSegment(entry.path)] : []))
          .filter(isTranscriptName)
          .toSorted();
        const newest = transcripts.at(-1);
        const newestEnded =
          newest === undefined
            ? undefined
            : await transcriptEnd(server, environmentId, root, newest);
        const folder: StarFolder = {
          environmentId,
          root,
          record,
          transcripts,
          ...(newestEnded === undefined ? {} : { newestEnded }),
          ...(origin === undefined ? {} : { origin }),
        };
        return [{ folder, upkeep }];
      }),
  );
  for (const result of results) {
    if (result.status === "rejected")
      console.warn(
        `[pult-shell] could not read a Star's folder on ${environmentId}: ${errorMessage(result.reason)}`,
      );
  }
  const read = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  return {
    repository: { environmentId, root: repository, ...(origin === undefined ? {} : { origin }) },
    folders: read.map((each) => each.folder),
    upkeep: new Map(
      read.flatMap((each) =>
        each.upkeep === null ? [] : [[each.folder.root, each.upkeep] as const],
      ),
    ),
    complete: results.every((result) => result.status === "fulfilled"),
  };
}

/** Whether a failed `project.create` names another project at its root, where the server sends the failure's cause. */
function isWorkspaceConflict(error: unknown): boolean {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  return (
    tag === "ProjectWorkspaceConflictError" ||
    tag === "ProjectConflictError" ||
    /already (belongs to|exists for)/i.test(errorMessage(cause))
  );
}

/** The roots the page refused to make a Star in, by environment: each told once per page session. */
const refused = new Set<string>();

/**
 * The page's Stars (xaxis `pult/issues/star-home`,
 * `pult/issues/star-folder-layout`): on each held environment the folders of
 * `~/.pult/stars` with a Star's record, read on each connect, after the
 * page's own writes and as the folder changes (`projects.watchEntries`, as
 * the explorer watches), merged by their record's id into Stars over the
 * thread model's projects and threads (`stars.ts`). While Show Star is on,
 * a legacy folder is migrated and an outdated `AGENTS.md` rewritten; a
 * folder with a record and no project is adopted as a project, and each
 * Star's projects are titled with its name; and while the page holds no
 * Star once every environment has answered, it creates one on the first
 * ready environment (`creationTarget`).
 */
class StarsModel {
  /** By environment id, as the connection holds them. */
  private readonly readings = new Map<string, Reading>();
  private stars: ReadonlyArray<Star> = [];
  private signature = "";
  private readonly listeners = new Set<() => void>();
  /** While a creation runs, until its re-read has landed: one at a time, across the environments. */
  private creating = false;
  /** Since a creation failed, was refused or lost a race, until an environment connects: no creation by default anywhere. */
  private halted = false;
  /** The Stars' projects this page made itself, by environment and root: an empty folder of one of them is the page's own. */
  private readonly made = new Set<string>();

  start(): void {
    connection.onDidChange(() => this.followEnvironments());
    threadStore.subscribe(() => this.update());
    starEnabled.subscribe(() => this.update());
    this.followEnvironments();
  }

  get(): ReadonlyArray<Star> {
    return this.stars;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether every ready environment's folders have been read, so each Star has all the homes the page can see. */
  allRead(): boolean {
    return connection.environments.every(
      (environment) =>
        environment.phase !== "ready" ||
        this.readings.get(environment.environmentId)?.read !== "pending",
    );
  }

  /** Whether the environment's Stars' folder was read, every folder in it, and holds no Star: a Star may be created on it by hand. */
  canCreateOn(environmentId: string): boolean {
    const reading = this.readings.get(environmentId);
    return (
      reading?.read === "read" &&
      reading.complete &&
      reading.folders.length === 0 &&
      connection.environment(environmentId)?.phase === "ready"
    );
  }

  repository(environmentId: string): StarRepository | undefined {
    return this.readings.get(environmentId)?.repository;
  }

  /** Follows every environment the connection holds and no other, reading each one's Stars as it becomes ready. */
  private followEnvironments(): void {
    const environments = connection.environments;
    for (const [environmentId, reading] of this.readings) {
      if (environments.some((environment) => environment.environmentId === environmentId)) continue;
      reading.watch?.dispose();
      clearTimeout(reading.timer);
      this.readings.delete(environmentId);
    }
    for (const environment of environments) {
      let reading = this.readings.get(environment.environmentId);
      if (reading === undefined) {
        reading = {
          read: "pending",
          folders: [],
          repository: undefined,
          upkeep: new Map(),
          keptUp: new Set(),
          complete: false,
          attempted: false,
          adopted: new Set(),
          wasReady: false,
          watch: undefined,
          generation: 0,
          timer: undefined,
        };
        this.readings.set(environment.environmentId, reading);
      }
      const ready = environment.phase === "ready";
      if (ready && !reading.wasReady) {
        // A failed creation or adoption is tried again on the next connect.
        reading.attempted = false;
        reading.adopted.clear();
        reading.keptUp.clear();
        this.halted = false;
        void this.read(environment.environmentId);
      }
      reading.wasReady = ready;
    }
    this.update();
  }

  /** Reads the environment's Stars' folder again, and watches it once it is there. */
  async read(environmentId: string): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading === undefined) return;
    const generation = ++reading.generation;
    try {
      const home = await environmentHome(environmentId);
      const server = environmentServer(environmentId);
      const folders = await readFolders(server, environmentId, home);
      if (reading.generation !== generation || this.readings.get(environmentId) !== reading) return;
      reading.read = "read";
      reading.folders = folders?.folders ?? [];
      reading.repository = folders?.repository ?? {
        environmentId,
        root: hostJoin(home, STARS_DIRECTORY),
      };
      reading.upkeep = folders?.upkeep ?? new Map();
      reading.complete = folders?.complete ?? true;
      if (folders !== null)
        await this.watch(environmentId, reading, server, hostJoin(home, STARS_DIRECTORY));
    } catch (error) {
      if (reading.generation !== generation) return;
      console.warn(
        `[pult-shell] could not read the Stars of ${environmentId}: ${errorMessage(error)}`,
      );
      reading.read = "failed";
    }
    this.update();
  }

  /**
   * Watches the Stars' folder, where the server can, reading it again a
   * moment after each burst of changes. A placeholder holds the reading's
   * watch while the server's features are asked, so a read meanwhile starts
   * no second one, and the watch starts only if the model still follows the
   * reading and the placeholder is still its watch.
   */
  private async watch(
    environmentId: string,
    reading: Reading,
    server: WorkspaceServer,
    directory: string,
  ): Promise<void> {
    if (reading.watch !== undefined) return;
    const placeholder: Disposable = { dispose: () => {} };
    reading.watch = placeholder;
    const watchable = await server.features().then(
      (features) => features.watchEntries,
      (error: unknown) => {
        console.warn(
          `[pult-shell] could not watch the Stars of ${environmentId}: ${errorMessage(error)}`,
        );
        return false;
      },
    );
    if (reading.watch !== placeholder) return;
    reading.watch = undefined;
    if (!watchable || this.readings.get(environmentId) !== reading) return;
    const reread = () => {
      clearTimeout(reading.timer);
      reading.timer = setTimeout(() => void this.read(environmentId), REREAD_DELAY_MS);
    };
    const watch = server.watchEntries(directory, {
      subscribed: async () => {},
      changed: reread,
      gone: () => {
        if (reading.watch === watch) reading.watch = undefined;
        reread();
      },
    });
    reading.watch = watch;
  }

  /** Merges the folders into Stars over the store's projects and threads, tells the listeners when they changed, then creates or adopts as due. */
  private update(): void {
    const { projects, threads } = threadStore.get();
    const folders = [...this.readings.values()].flatMap((reading) => reading.folders);
    // A legacy folder is a Star once migrated, so nothing writes into it meanwhile: its transcripts' keeper would put them where the migration moves the old ones.
    const migrated = [...this.readings.values()].flatMap((reading) =>
      reading.folders.filter((folder) => reading.upkeep.get(folder.root) !== "migrate"),
    );
    const stars = starsOf(migrated, projects, threads);
    // The readings too, which tell where a Star may be created.
    const signature = JSON.stringify([
      stars.map((star) => [
        star.id,
        star.name,
        star.tint,
        star.homes,
        star.state,
        star.current?.id,
        star.current?.workingSince,
        star.latest?.id,
        star.lastEnded,
      ]),
      [...this.readings.values()].map((reading) => reading.read),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.stars = stars;
      for (const listener of this.listeners) listener();
    }
    const enabled = starSettingKnown() && starEnabled.get();
    if (enabled) {
      this.keepUp();
      this.adopt(migrated);
      this.title(stars);
    }
    const target = creationTarget({
      enabled,
      restoring: connection.connecting,
      halted: this.halted,
      stars: new Set(folders.map((folder) => folder.record.id)).size,
      environments: connection.environments.map((environment) => {
        const reading = this.readings.get(environment.environmentId);
        return {
          id: environment.environmentId,
          phase: environment.phase,
          loaded: threadStore.environment(environment.environmentId)?.loaded === true,
          // A folder it could not read may be the Star.
          read:
            reading?.read === "read" && !reading.complete ? "failed" : (reading?.read ?? "pending"),
          attempted: reading?.attempted ?? false,
        };
      }),
    });
    if (target !== undefined && !this.creating) void this.create(target);
  }

  /** Runs each folder's upkeep due, a legacy one's migration or Pult's `AGENTS.md`, once per connect, then reads the folder again; a failure is tried again on the next connect. */
  private keepUp(): void {
    for (const [environmentId, reading] of this.readings) {
      for (const [root, upkeep] of reading.upkeep) {
        const folder = reading.folders.find((each) => each.root === root);
        if (folder === undefined || reading.keptUp.has(root)) continue;
        reading.keptUp.add(root);
        const server = environmentServer(environmentId);
        const run =
          upkeep === "migrate"
            ? migrate(server, root, folder.record)
            : server.writeFile({ cwd: root, relativePath: AGENTS_FILE, contents: AGENTS_TEXT });
        void Promise.resolve(run).then(
          () => this.read(environmentId),
          (error: unknown) =>
            console.warn(
              `[pult-shell] could not ${upkeep === "migrate" ? "migrate" : "update the AGENTS.md of"} the Star at ${root}: ${errorMessage(error)}`,
            ),
        );
      }
    }
  }

  /** The Stars' projects whose title is not the Star's name: each retitled once per name, so the page and upstream's own apps name the project as the Star. */
  private readonly titled = new Set<string>();
  private title(stars: ReadonlyArray<Star>): void {
    for (const star of stars) {
      const name = starName(star);
      for (const home of star.homes) {
        if (home.projectId === null) continue;
        const project = threadStore.project(home.environmentId, home.projectId);
        const key = JSON.stringify([home.environmentId, home.projectId, name]);
        if (project === undefined || project.name === name || this.titled.has(key)) continue;
        this.titled.add(key);
        void mutate(home.environmentId, {
          type: "project.update",
          commandId: newCommandId(),
          projectId: ProjectId.make(home.projectId),
          title: name,
        }).catch((error: unknown) => {
          console.warn(
            `[pult-shell] could not title the Star's project ${home.projectId}: ${errorMessage(error)}`,
          );
        });
      }
    }
  }

  /** Makes each folder with a record and no project a project, once per connect: the folder of a Star made elsewhere, or by a creation cut short. */
  private adopt(folders: ReadonlyArray<StarFolder>): void {
    const loaded = (environmentId: string) =>
      threadStore.environment(environmentId)?.loaded === true;
    for (const folder of foldersToAdopt(folders, threadStore.get().projects, loaded)) {
      const reading = this.readings.get(folder.environmentId);
      if (reading === undefined || reading.adopted.has(folder.root)) continue;
      reading.adopted.add(folder.root);
      void this.createProject(folder.environmentId, folder.root, starName(folder.record)).then(
        (projectId) =>
          setStarIcon(folder.environmentId, projectId).then(() => this.read(folder.environmentId)),
        (error: unknown) =>
          console.warn(
            `[pult-shell] could not adopt the Star at ${folder.root}: ${errorMessage(error)}`,
          ),
      );
    }
  }

  /**
   * Creates a Star on the environment, `~/.pult/stars/star`: the project,
   * titled Star, which makes the folder, then its `.pult/`, its empty
   * `instructions.md`, its record and Pult's `AGENTS.md`, written only where
   * a read at the folder finds no record, then the project's 🌟. A folder
   * there that is a Star already is read and adopted; one holding only what
   * a creation writes is finished only when this page made its project; a
   * project another page has just made there is left to that page; anything
   * else there is refused, told once per page session. One notification says
   * the Star is ready; a failure notifies, and is tried again on the next
   * connect. Until its re-read lands no other creation starts, and after a
   * failure, a refusal or a lost race none by default until an environment
   * connects.
   *
   * With an `origin`, where the page's Stars sync, the environment's
   * `~/.pult/stars` is a clone of it instead, every Star in it a home there
   * (`syncing.ts`), cloned only where nothing is there yet; the read then
   * adopts each as a project.
   */
  async create(environmentId: string, origin?: string): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading === undefined || this.creating) return;
    reading.attempted = true;
    this.creating = true;
    const notifications = await getService(INotificationService);
    let created: StarFolder | undefined;
    try {
      const home = await environmentHome(environmentId);
      const server = environmentServer(environmentId);
      const root = hostJoin(home, STARS_DIRECTORY, DEFAULT_STAR_FOLDER);
      const key = `${environmentId}\n${root}`;
      const refuse = (
        what = `~/${STARS_DIRECTORY}/${DEFAULT_STAR_FOLDER} exists and is not a Star`,
      ) => {
        this.halted = true;
        if (refused.has(key)) return;
        refused.add(key);
        notifications.error(`Pult did not create your Star: ${what}.`);
      };
      if (origin !== undefined) {
        const there = await listed(server, home, STARS_DIRECTORY);
        if (there !== null && there.length > 0)
          return refuse(`~/${STARS_DIRECTORY} exists, so Pult does not clone ${origin} into it`);
        await starGit(environmentId).clone(origin, hostJoin(home, STARS_DIRECTORY));
        notifications.info(`Your Stars are here too, synced with ${origin}.`);
        return;
      }
      const project = projectAt(threadStore.get().projects, environmentId, root);
      const entries = await listed(server, home, `${STARS_DIRECTORY}/${DEFAULT_STAR_FOLDER}`);
      if (entries !== null) {
        const found = await recordAt(server, root);
        if (found === "star") return;
        if (found === "other") return refuse();
        // A folder of this page's own making, its project made here and nothing in it but what a creation writes, is finished; anything else is someone's.
        const ours =
          project !== undefined &&
          this.made.has(key) &&
          entries.every((entry) =>
            [SYSTEM_DIRECTORY, INSTRUCTIONS_FILE, AGENTS_FILE].includes(lastSegment(entry.path)),
          );
        if (!ours) return refuse();
      }
      let projectId = project?.id;
      if (projectId === undefined) {
        try {
          projectId = await this.createProject(environmentId, root, STAR_PROJECT_TITLE);
          this.made.add(key);
        } catch (error) {
          // The server tells no reason, so a project at the root, or the folder there now, means another page got there first: its Star shows as it writes the folder.
          const won =
            projectAt(threadStore.get().projects, environmentId, root) !== undefined ||
            isWorkspaceConflict(error) ||
            (await listed(server, home, `${STARS_DIRECTORY}/${DEFAULT_STAR_FOLDER}`).then(
              (now) => now !== null,
              () => false,
            ));
          if (!won) throw error;
          this.halted = true;
          return;
        }
      }
      await server.createDirectory({ cwd: root, relativePath: CONVERSATIONS_DIRECTORY });
      // Never over a record there: another page's is adopted, anything else refused.
      const found = await recordAt(server, root);
      if (found === "star") return;
      if (found === "other") return refuse();
      if ((await readStarFile(server, root, INSTRUCTIONS_FILE)) === undefined)
        await server.writeFile({ cwd: root, relativePath: INSTRUCTIONS_FILE, contents: "" });
      await server.writeFile({ cwd: root, relativePath: AGENTS_FILE, contents: AGENTS_TEXT });
      const record = newRecord(crypto.randomUUID(), new Date().toISOString());
      await server.writeFile({
        cwd: root,
        relativePath: RECORD_FILE,
        contents: recordText(record),
      });
      created = { environmentId, root, record, transcripts: [] };
      await setStarIcon(environmentId, projectId);
      notifications.prompt(Severity.Info, "Your Star is ready.", [
        { label: "Open Star", run: () => void openStar(record.id) },
      ]);
    } catch (error) {
      this.halted = true;
      notifications.error(`Pult could not create your Star: ${errorMessage(error)}`);
    } finally {
      // The new folder counts until the re-read lands, which a read already under way may not: no second Star meanwhile.
      const folder = created;
      if (folder !== undefined && !reading.folders.some((each) => each.root === folder.root))
        reading.folders = [...reading.folders, folder];
      await this.read(environmentId);
      this.creating = false;
      this.update();
    }
  }

  /** A project titled `title` at `root`, which the server makes when it is missing; its id. */
  private async createProject(environmentId: string, root: string, title: string): Promise<string> {
    const project = await mutate(environmentId, {
      type: "project.create",
      commandId: newCommandId(),
      projectId: ProjectId.make(crypto.randomUUID()),
      title,
      workspaceRoot: root,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
    });
    return project.id;
  }

  /**
   * Writes the record's `changes` into `homes` of the Star, a
   * read-modify-write of `.pult/star.md`'s front matter alone, over the
   * version read where the server tells versions; a failure notifies.
   * Whether every home took it. `syncing.ts` (`setStarRecord`) runs it on
   * each home after that home's pull, and commits it.
   */
  async setFields(
    starId: string,
    changes: RecordFields,
    homes: ReadonlyArray<StarHome>,
  ): Promise<boolean> {
    const notifications = await getService(INotificationService);
    const written = await Promise.all(
      homes.map(async (home) => {
        try {
          const server = environmentServer(home.environmentId);
          const file = await readRecordFile(server, home.root);
          if (file === undefined || parseRecord(file.contents)?.id !== starId) return false;
          await server.writeFile({
            cwd: home.root,
            relativePath: RECORD_FILE,
            contents: withRecordFields(file.contents, changes),
            ...(file.version === undefined ? {} : { expectedVersion: file.version }),
          });
          return true;
        } catch (error) {
          notifications.error(`Pult could not change your Star: ${errorMessage(error)}`);
          return false;
        } finally {
          await this.read(home.environmentId);
        }
      }),
    );
    return written.every(Boolean);
  }
}

function newCommandId() {
  return CommandId.make(crypto.randomUUID());
}

function mutate(environmentId: string, mutation: ProjectMutation) {
  return connection.run(environmentId, request(WS_METHODS.projectsMutate, mutation));
}

/** The 🌟 upstream's UI shows for the Star's project. */
function setStarIcon(environmentId: string, projectId: string) {
  return mutate(environmentId, {
    type: "project.update",
    commandId: newCommandId(),
    projectId: ProjectId.make(projectId),
    projectIcon: STAR_PROJECT_ICON,
  });
}

/** Selects the Star, through its command, which `selection.ts` registers. */
async function openStar(starId: string): Promise<void> {
  await (await getService(ICommandService)).executeCommand("pult-shell.selectStar", starId);
}

const model = new StarsModel();

/** Starts the Stars' model on the page's connection and thread model; before the workbench, as they are. */
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

/** Creates a Star on the environment, or with `origin` clones the Stars' repository syncing through it there. */
export const createStar = (environmentId: string, origin?: string) =>
  model.create(environmentId, origin);
/** Reads the environment's Stars' folders again: after the page wrote a transcript, which a watch may tell late or not at all. */
export const rereadStars = (environmentId: string) => model.read(environmentId);
/** Forgets when a transcript ended, before its rewrite is read. */
export const forgetTranscriptEnd = (environmentId: string, root: string, name: string) =>
  transcriptEnds.delete(transcriptKey(environmentId, root, name));
export const canCreateStarOn = (environmentId: string) => model.canCreateOn(environmentId);
/** The environment's Stars' repository, once its folder was read. */
export const starRepository = (environmentId: string) => model.repository(environmentId);
/** Whether every ready environment's Stars' folders have been read (`syncing.ts` waits for it). */
export const starFoldersRead = () => model.allRead();
export const setStarFields = (
  starId: string,
  changes: RecordFields,
  homes: ReadonlyArray<StarHome>,
) => model.setFields(starId, changes, homes);

/** Whether the page holds the environment. */
const held = (environmentId: string) => connection.environment(environmentId) !== undefined;

/**
 * What the Star's tab shows: its current conversation, or while it sleeps
 * its project's draft in the home it wakes in (`wakeHome`); undefined while
 * none of its homes has a project on a held environment.
 */
export function starTarget(star: Star): StarTarget | undefined {
  if (star.current !== null)
    return { kind: "thread", environmentId: star.current.environmentId, threadId: star.current.id };
  const home = wakeHome(star, held);
  return home?.projectId == null
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
