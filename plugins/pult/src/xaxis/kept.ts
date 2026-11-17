// The kept xaxis checkout (`pult/decisions`, `xaxis-kept-checkouts`): the checkout of `/` at
// `<pult>/xaxis`, beside the Stars directory, moved to main's tip by the driver's Get latest at every
// automatic-fetch interval and made a project. Its folder is the registration.
import { CommandId, ProjectId, type ThreadId } from "@t3tools/contracts";

import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Path,
  ProjectService,
  Scheduler,
  Schema,
  SecureRandom,
  ThreadManagementService,
  VcsStatusBroadcaster,
  XaxisCli,
  XaxisVcsDriver,
} from "../host.ts";

/** The folder beside the Stars directory that holds the kept checkout. */
const KEPT_FOLDER = "xaxis";
/** The kept checkout's project, until the user renames it. */
const KEPT_PROJECT_TITLE = "xaxis";

/** The refusals that mean the checkout waits for its user, or for the CLI's lock: its state, not a failure. */
const WAITING_CODES: ReadonlySet<string> = new Set([
  "uncommitted-edits",
  "unlanded-changes",
  "conflict-pending",
  "interrupted",
  "checkout-busy",
]);

export interface Attempt {
  readonly at: string;
  readonly outcome: "moved" | "up-to-date" | "waiting" | "failed";
  readonly code?: string;
  readonly message?: string;
}

export interface KeptCheckout {
  readonly dir: string;
  readonly prefix: string;
  readonly projectId: ProjectId | null;
  readonly last: Attempt | null;
  readonly running?: { readonly since: string };
  /** Threads with a run in progress whose working directory is inside the checkout. */
  readonly agentThreads: ReadonlyArray<ThreadId>;
}

export interface KeptView {
  readonly folder: string;
  readonly checkouts: ReadonlyArray<KeptCheckout>;
  readonly refused: ReadonlyArray<{ readonly dir: string; readonly reason: string }>;
}

export class XaxisKeptError extends Schema.TaggedError<XaxisKeptError>()("XaxisKeptError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const detail = (this.cause as { readonly detail?: unknown } | undefined)?.detail;
    return typeof detail === "string"
      ? `Pult could not read the kept xaxis checkout: ${detail}`
      : "Pult could not read the kept xaxis checkout.";
  }
}

export interface XaxisKept {
  readonly folder: string;
  /** The route's answer, the registry read afresh. */
  readonly view: Effect.Effect<KeptView, XaxisKeptError>;
}

/**
 * The kept one among the registry's checkouts, and the others at or under `folder`, refused: the
 * mirror rule (a folder at `<folder>` plus its prefix) holds for the checkout of `/` at `folder`
 * alone, and every other folder under it is nested in that one's.
 */
function classify(
  folder: string,
  listed: ReadonlyArray<XaxisCli.XaxisCheckout>,
  path: Path.Path,
): {
  readonly kept: XaxisCli.XaxisCheckout | undefined;
  readonly refused: KeptView["refused"];
} {
  let kept: XaxisCli.XaxisCheckout | undefined;
  const refused: Array<KeptView["refused"][number]> = [];
  for (const checkout of listed) {
    const dir = path.resolve(checkout.dir);
    const mirrored = path.resolve(folder, `.${checkout.prefix}`) === dir;
    if (dir === folder && mirrored) kept = checkout;
    else if (dir === folder)
      refused.push({
        dir,
        reason: `It holds ${checkout.prefix}, and only a checkout of the whole tree / is kept at ${folder}.`,
      });
    else if (dir.startsWith(`${folder}${path.sep}`))
      refused.push({
        dir,
        reason: `It is nested inside ${folder}, where only the checkout of the whole tree / is kept.`,
      });
  }
  return { kept, refused };
}

const inside = (folder: string, dir: string, path: Path.Path) => {
  const resolved = path.resolve(dir);
  return resolved === folder || resolved.startsWith(`${folder}${path.sep}`);
};

export const make = Effect.fn("XaxisKept.make")(function* (starsDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* XaxisVcsDriver.XaxisVcsDriver;
  const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const interval = yield* VcsStatusBroadcaster.VcsAutomaticFetchInterval;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduler = yield* Scheduler.Scheduler;
  const newId = (yield* SecureRandom.SecureRandom).uuidV4();

  const pult = path.dirname(starsDirectory);
  const folder = path.join(pult, KEPT_FOLDER);
  const state: { last: Attempt | null; running: { since: string } | null } = {
    last: null,
    running: null,
  };
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * The registry, read from `<pult>` so it never queues behind the kept checkout's own commands,
   * against the folder's real path, as the CLI records a checkout's.
   */
  const list = Effect.gen(function* () {
    if (!(yield* fs.exists(folder))) return { kept: undefined, refused: [] };
    const real = yield* fs.realPath(folder);
    return classify(real, yield* driver.checkouts(pult), path);
  });

  const ensureProject = Effect.fn("XaxisKept.ensureProject")(function* (dir: string) {
    const owned = (yield* projects.listShells()).some(
      (project) => path.resolve(project.workspaceRoot) === dir,
    );
    if (owned) return;
    yield* projects.create({
      commandId: CommandId.make(yield* newId),
      projectId: ProjectId.make(yield* newId),
      title: KEPT_PROJECT_TITLE,
      workspaceRoot: dir,
    });
  });

  const refresh = (dir: string) =>
    broadcaster
      .refreshStatus(dir)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh the kept xaxis checkout's status.", { dir, cause }),
        ),
      );

  const move = Effect.fn("XaxisKept.move")(function* (dir: string) {
    state.running = { since: yield* nowIso };
    const result = yield* driver
      .getLatest(dir)
      .pipe(Effect.result, Effect.ensuring(Effect.sync(() => (state.running = null))));
    const at = yield* nowIso;
    if (result._tag === "Success") {
      const moved = result.success.status === "pulled";
      state.last = { at, outcome: moved ? "moved" : "up-to-date" };
      if (moved) yield* refresh(dir);
      return;
    }
    const error = result.failure;
    const code = XaxisCli.refusalCode(error);
    if (code !== null && WAITING_CODES.has(code)) {
      state.last = { at, outcome: "waiting", code, message: error.detail };
      return;
    }
    state.last = {
      at,
      outcome: "failed",
      ...(code === null ? {} : { code }),
      message: error.detail,
    };
    yield* Effect.logWarning("Could not keep the xaxis checkout up to date.", {
      dir,
      code,
      message: error.detail,
    });
    // The status's tip read names a lost login or an unreachable server to a page that listens.
    yield* refresh(dir);
  });

  let lastPass: number | undefined;
  const pass = Effect.gen(function* () {
    const every = Duration.toMillis(yield* interval);
    if (every <= 0) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (lastPass !== undefined && now - lastPass < every) return;
    lastPass = now;
    const { kept, refused } = yield* list;
    for (const each of refused)
      yield* Effect.logWarning("An xaxis checkout under the kept folder is not kept.", each);
    if (kept === undefined) return;
    const dir = path.resolve(kept.dir);
    yield* ensureProject(dir).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not make the kept xaxis checkout a project.", { dir, cause }),
      ),
    );
    yield* move(dir);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not list the xaxis checkouts to keep.", { cause }),
    ),
    Effect.withSpan("XaxisKept.pass"),
  );
  // The scheduler runs it at once and on its ticks, one run at a time, so a Get latest that hangs
  // holds the next until it ends.
  yield* scheduler.register("pult-xaxis-kept", pass);

  const view = Effect.gen(function* () {
    const { kept, refused } = yield* list;
    if (kept === undefined) return { folder, checkouts: [], refused } satisfies KeptView;
    const dir = path.resolve(kept.dir);
    const shells = yield* projects.listShells();
    const project = shells.find(
      (each) => each.archivedAt == null && path.resolve(each.workspaceRoot) === dir,
    );
    const roots = new Map(shells.map((each) => [each.id, each.workspaceRoot]));
    const { threads: open } = yield* threads.getShellSnapshot({ unsettledOnly: true });
    const agentThreads = open
      .filter((thread) => {
        if (thread.activeRunId === null) return false;
        const cwd = thread.worktreePath ?? roots.get(thread.projectId);
        return cwd !== undefined && inside(dir, cwd, path);
      })
      .map((thread) => thread.id);
    return {
      folder,
      checkouts: [
        {
          dir,
          prefix: kept.prefix,
          projectId: project?.id ?? null,
          last: state.last,
          ...(state.running === null ? {} : { running: state.running }),
          agentThreads,
        },
      ],
      refused,
    } satisfies KeptView;
  }).pipe(Effect.mapError((cause) => new XaxisKeptError({ cause })));

  return { folder, view } satisfies XaxisKept;
});
