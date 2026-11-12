import {
  getService,
  ICommandService,
  IContextKeyService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

import { connection, pickEnvironment } from "../connection/index.ts";
import { toUriPath } from "../files/paths.ts";
import { pultResource } from "../files/workspace.ts";
import { ChannelInput } from "../threads/pane.tsx";
import { selectedStar } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { onDidChangePluginFeatures } from "./about.ts";
import {
  canCreateStarOn,
  canSleepStar,
  createStar,
  primaryHome,
  sleepStar,
  starById,
  starStore,
} from "./model.ts";
import { channelRows, drawnHome, type Star, starName } from "./stars.ts";
import { syncStar } from "./syncing.ts";

/** Whether the page holds a Star: Open Star, Edit Star Instructions, Open Star Folder, Open Star Schedule and Open Star Ask are offered then. */
export const HasStarContext = new RawContextKey<boolean>("pult.hasStar", false);
/** Whether a held environment's Pult plugin serves Stars: Create Star is offered then. */
const CanCreateStarContext = new RawContextKey<boolean>("pult.canCreateStar", false);
/** Whether a Star can be put to sleep by hand (`canSleepStar`): Refresh Context is offered then. */
const CanSleepStarContext = new RawContextKey<boolean>("pult.canRefreshContext", false);

/** The Star `starId` names, or with none the page's one, or one picked in the shell's quick input while it holds several. */
export async function pickStar(
  quickInput: IQuickInputService,
  starId: unknown,
  placeHolder: string,
): Promise<Star | undefined> {
  if (typeof starId === "string") return starById(starId);
  const stars = starStore.get();
  if (stars.length <= 1) return stars[0];
  const environmentsOf = (star: Star) =>
    star.homes
      .map((home) => threadStore.environment(home.environmentId)?.name ?? home.environmentId)
      .join(", ");
  const picked = await quickInput.pick(
    stars.map((star) => ({ star, label: starName(star), description: environmentsOf(star) })),
    { placeHolder },
  );
  return picked?.star;
}

/** The Star's own `instructions.md`, which its `AGENTS.md` loads, as a tab among the selection's, from the home that stands for it, where its plugin says it is. */
async function editStarInstructions(star: Star): Promise<void> {
  const home = primaryHome(star);
  if (home === undefined)
    return void (await getService(INotificationService)).info(
      "Pult is not connected to your Star's environment.",
    );
  await (
    await getService(IEditorService)
  ).openEditor({
    resource: pultResource(home.environmentId, toUriPath(home.instructions)),
    options: { pinned: true },
  });
}

/**
 * A schedule's file of the Star's as a tab among the Star's, from the home
 * it is drawn from, as its card lists them: `name`'s, or one picked among
 * them; the Star selected first, as Open Star Ask selects it.
 */
async function openStarSchedule(
  quickInput: IQuickInputService,
  star: Star,
  name: unknown,
): Promise<void> {
  const notifications = await getService(INotificationService);
  const home = drawnHome(star);
  if (home === undefined || connection.environment(home.environmentId) === undefined)
    return notifications.info("Pult is not connected to your Star's environment.");
  const schedules = home.schedules;
  if (typeof name !== "string" && schedules.length === 0)
    return notifications.info(`${starName(star)} has no schedules.`);
  const schedule =
    typeof name === "string"
      ? schedules.find((each) => each.name === name)
      : schedules.length === 1
        ? schedules[0]
        : (
            await quickInput.pick(
              schedules.map((each) => ({
                schedule: each,
                label: each.name,
                description: each.rule ?? "not a schedule",
              })),
              { placeHolder: "Open a schedule of the Star's" },
            )
          )?.schedule;
  if (schedule === undefined) {
    if (typeof name === "string") notifications.info(`${starName(star)} has no schedule ${name}.`);
    return;
  }
  await (await getService(ICommandService)).executeCommand("pult-shell.selectStar", star.id);
  // A switch cancelled over a modified file leaves the selection as it was, so the schedule is not opened among its tabs.
  if (selectedStar() !== star.id) return;
  await (
    await getService(IEditorService)
  ).openEditor({
    resource: pultResource(home.environmentId, toUriPath(schedule.path)),
    options: { pinned: true },
  });
}

/**
 * An ask of the Star's (xaxis `pult/issues/star-asks.md`), from the home it
 * is drawn from, as its card lists them: `name`'s, or one picked by its
 * title among them; the Star selected, the ask's file a pinned tab among
 * its tabs and the composer strip shown, so the Star's composer is under
 * the ask, where the user answers.
 */
async function openStarAsk(
  quickInput: IQuickInputService,
  star: Star,
  name: unknown,
): Promise<void> {
  const notifications = await getService(INotificationService);
  const home = drawnHome(star);
  if (home === undefined || connection.environment(home.environmentId) === undefined)
    return notifications.info("Pult is not connected to your Star's environment.");
  const asks = home.asks;
  if (typeof name !== "string" && asks.length === 0)
    return notifications.info(`${starName(star)} asks nothing of you.`);
  const ask =
    typeof name === "string"
      ? asks.find((each) => each.name === name)
      : asks.length === 1
        ? asks[0]
        : (
            await quickInput.pick(
              asks.map((each) => ({ ask: each, label: each.title, description: each.name })),
              { placeHolder: "Open an ask of the Star's" },
            )
          )?.ask;
  if (ask === undefined) {
    if (typeof name === "string") notifications.info(`${starName(star)} has no ask ${name}.`);
    return;
  }
  const commands = await getService(ICommandService);
  await commands.executeCommand("pult-shell.selectStar", star.id);
  // A switch cancelled over a modified file leaves the selection as it was, so the ask is not opened among its tabs.
  if (selectedStar() !== star.id) return;
  await (
    await getService(IEditorService)
  ).openEditor({
    resource: pultResource(home.environmentId, toUriPath(ask.path)),
    options: { pinned: true },
  });
  await commands.executeCommand("pult-shell.showComposer");
}

/**
 * An open channel's conversation of the Star's, but `user`'s, which is its
 * tab, as a thread's tab among the Star's (`ChannelInput`), as its card
 * lists them: `slug`'s, or one picked among them; the Star selected first.
 */
async function openStarChannel(
  quickInput: IQuickInputService,
  star: Star,
  slug: unknown,
): Promise<void> {
  const notifications = await getService(INotificationService);
  const rows = channelRows(star);
  if (typeof slug !== "string" && rows.length === 0)
    return notifications.info(`${starName(star)} has no channel open but yours.`);
  const channel =
    typeof slug === "string"
      ? rows.find((each) => each.slug === slug)
      : rows.length === 1
        ? rows[0]
        : (
            await quickInput.pick(
              rows.map((each) => ({ channel: each, label: each.slug })),
              { placeHolder: "Open a channel of the Star's" },
            )
          )?.channel;
  if (channel === undefined) {
    if (typeof slug === "string") notifications.info(`${starName(star)} has no ${slug} open.`);
    return;
  }
  const commands = await getService(ICommandService);
  await commands.executeCommand("pult-shell.selectStar", star.id);
  // A switch cancelled over a modified file leaves the selection as it was, so the channel is not opened among its tabs.
  if (selectedStar() !== star.id) return;
  const { environmentId, id } = channel.thread;
  await (
    await getService(IEditorService)
  ).openEditor(
    (await getService(IInstantiationService)).createInstance(
      ChannelInput,
      environmentId,
      id,
      channel.slug,
    ),
    { pinned: true },
  );
}

/**
 * The Explorer tab at the Star's folder: narrowed to it while the Star is
 * selected, as its composer bar's Explorer narrows, else the environments'
 * folders with the Star's revealed, leaving the selection as it is.
 */
async function openStarFolder(star: Star): Promise<void> {
  const commands = await getService(ICommandService);
  const home = primaryHome(star);
  if (home === undefined)
    return void (await getService(INotificationService)).info(
      "Pult is not connected to your Star's environment.",
    );
  if (selectedStar() === star.id)
    return void (await commands.executeCommand("pult-shell.openThreadExplorer"));
  await commands.executeCommand("pult-shell.openEnvironmentExplorer");
  await commands.executeCommand(
    "revealInExplorer",
    pultResource(home.environmentId, toUriPath(home.root)),
  );
}

/**
 * The palette's Star commands: Pult: Create Star (`pult-shell.createStar
 * [environmentId]`, a new Star on any held environment whose Pult plugin
 * serves Stars, picked among them while there are several; while the
 * page's Stars sync, their repository cloned there from its origin, where
 * none is), Edit Star Instructions
 * (`pult-shell.editStarInstructions [starId]`), Open Star Folder
 * (`pult-shell.openStarFolder [starId]`), Open Star Schedule…
 * (`pult-shell.openStarSchedule [starId] [name]`, the card's schedule rows),
 * Open Star Ask… (`pult-shell.openStarAsk [starId] [name]`, the card's ask
 * rows), Open Star Channel… (`pult-shell.openStarChannel [starId] [slug]`,
 * the card's channel rows), Sync Star (`pult-shell.syncStar
 * [starId]`, `syncing.ts`) and Refresh Context (`pult-shell.refreshContext
 * [starId]`, the Star's current conversation in `user` put to sleep, offered only
 * while `canSleepStar`), each on the page's Star, picked while it holds
 * several. Open Star is the selection's
 * (`src/threads/selection.ts`); Show Star and Hide Star the setting's
 * (`settings.ts`). Registered before the workbench starts.
 */
export function registerStarCommands(): void {
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.createStar",
          title: { value: "Create Star", original: "Create Star" },
          category,
          f1: true,
          precondition: CanCreateStarContext,
        });
      }

      async run(_accessor: ServicesAccessor, environmentId?: unknown): Promise<void> {
        // Stars that sync are cloned to an environment holding none, each a second home there, rather than a new Star made beside them.
        const create = (environmentId: string) => {
          const holds = starStore
            .get()
            .some((star) => star.homes.some((home) => home.environmentId === environmentId));
          const origin = holds
            ? undefined
            : starStore.get().find((star) => star.origin !== undefined)?.origin;
          return createStar(environmentId, origin);
        };
        if (typeof environmentId === "string") return create(environmentId);
        const candidates = connection.environments.filter((environment) =>
          canCreateStarOn(environment.environmentId),
        );
        if (candidates.length === 0)
          return void (await getService(INotificationService)).info(
            "No connected environment's server keeps Stars.",
          );
        const picked = await pickEnvironment(candidates, "Create a Star on an environment");
        if (picked !== undefined) await create(picked.environmentId);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.editStarInstructions",
          title: { value: "Edit Star Instructions", original: "Edit Star Instructions" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown): Promise<void> {
        const star = await pickStar(
          accessor.get(IQuickInputService),
          starId,
          "Edit a Star's instructions",
        );
        if (star !== undefined) await editStarInstructions(star);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openStarFolder",
          title: { value: "Open Star Folder", original: "Open Star Folder" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown): Promise<void> {
        const star = await pickStar(
          accessor.get(IQuickInputService),
          starId,
          "Open a Star's folder",
        );
        if (star !== undefined) await openStarFolder(star);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openStarSchedule",
          title: { value: "Open Star Schedule…", original: "Open Star Schedule…" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown, name?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const star = await pickStar(quickInput, starId, "Open a Star's schedule");
        if (star !== undefined) await openStarSchedule(quickInput, star, name);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openStarAsk",
          title: { value: "Open Star Ask…", original: "Open Star Ask…" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown, name?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const star = await pickStar(quickInput, starId, "Open a Star's ask");
        if (star !== undefined) await openStarAsk(quickInput, star, name);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openStarChannel",
          title: { value: "Open Star Channel…", original: "Open Star Channel…" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown, slug?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const star = await pickStar(quickInput, starId, "Open a Star's channel");
        if (star !== undefined) await openStarChannel(quickInput, star, slug);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.syncStar",
          title: { value: "Sync Star", original: "Sync Star" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown): Promise<void> {
        const star = await pickStar(
          accessor.get(IQuickInputService),
          starId,
          "Sync a Star with its origin",
        );
        if (star !== undefined) await syncStar(star.id);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.refreshContext",
          title: { value: "Refresh Context", original: "Refresh Context" },
          category,
          f1: true,
          precondition: CanSleepStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const sleepable = starStore.get().filter(canSleepStar);
        const star =
          typeof starId === "string"
            ? starById(starId)
            : sleepable.length <= 1
              ? sleepable[0]
              : (
                  await quickInput.pick(
                    sleepable.map((each) => ({ star: each, label: starName(each) })),
                    { placeHolder: "Refresh a Star's context" },
                  )
                )?.star;
        if (star !== undefined) await sleepStar(star);
      }
    },
  );
  void getService(IContextKeyService).then((contextKeys) => {
    const hasStar = HasStarContext.bindTo(contextKeys);
    const canCreate = CanCreateStarContext.bindTo(contextKeys);
    const canSleep = CanSleepStarContext.bindTo(contextKeys);
    const update = () => {
      hasStar.set(starStore.get().length > 0);
      canCreate.set(
        connection.environments.some((environment) => canCreateStarOn(environment.environmentId)),
      );
      canSleep.set(starStore.get().some(canSleepStar));
    };
    starStore.subscribe(update);
    connection.onDidChange(update);
    onDidChangePluginFeatures(update);
    update();
  });
}
