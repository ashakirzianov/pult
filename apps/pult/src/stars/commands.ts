import {
  getService,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
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
import type { ComposerTarget } from "../../view/drafts.ts";
import { citedPath } from "../composer/citedPath.ts";
import { revealAsk } from "../panel/asks.ts";
import { StarInput, StarThreadInput } from "../threads/pane.tsx";
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
  starTarget,
} from "./model.ts";
import type { RouteAsk } from "./plugin.ts";
import {
  channelRows,
  drawnHome,
  rotatedChannelTab,
  type Star,
  type StarHome,
  starName,
} from "./stars.ts";
import { starEnabled } from "./settings.ts";
import { syncStar } from "./syncing.ts";

/** Whether the page holds a Star: Open Star, Edit Star Instructions, Open Star Folder, Open Star Schedule, Open Star Ask, Open Star Ask Source and Reply to Star Ask are offered then. */
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
 * An ask of the Star's (xaxis `pult/issues/star-asks-list.md`), from the
 * home it is drawn from, as Inbox lists them: `name`'s, or one picked by
 * its title among them; told by a notification when there is none.
 */
async function pickAsk(
  quickInput: IQuickInputService,
  star: Star,
  name: unknown,
  placeHolder: string,
): Promise<{ home: StarHome; ask: RouteAsk } | undefined> {
  const notifications = await getService(INotificationService);
  const home = drawnHome(star);
  if (home === undefined || connection.environment(home.environmentId) === undefined)
    return void notifications.info("Pult is not connected to your Star's environment.");
  const asks = home.asks;
  if (typeof name !== "string" && asks.length === 0)
    return void notifications.info(`${starName(star)} asks nothing of you.`);
  const ask =
    typeof name === "string"
      ? asks.find((each) => each.name === name)
      : asks.length === 1
        ? asks[0]
        : (
            await quickInput.pick(
              asks.map((each) => ({ ask: each, label: each.title, description: each.name })),
              { placeHolder },
            )
          )?.ask;
  if (ask === undefined) {
    if (typeof name === "string") notifications.info(`${starName(star)} has no ask ${name}.`);
    return undefined;
  }
  return { home, ask };
}

/**
 * An ask's row in Inbox expanded and brought into view, Inbox opened if
 * closed, and the Star selected (`src/panel/asks.ts`); while Show Star is
 * off, which draws no ask row, its file, as Open Source opens it.
 */
async function openStarAsk(quickInput: IQuickInputService, star: Star, name: unknown) {
  if (!starEnabled.get()) return openStarAskSource(quickInput, star, name);
  const picked = await pickAsk(quickInput, star, name, "Open an ask of the Star's");
  if (picked === undefined) return;
  revealAsk({ starId: star.id, name: picked.ask.name });
  await (await getService(ICommandService)).executeCommand("pult-shell.selectStar", star.id);
}

/**
 * An ask's file as a pinned tab among the Star's, the Star selected, and the
 * composer strip shown, so the Star's composer is under it: the row's Open
 * Source, the way to edit or read the file itself.
 */
async function openStarAskSource(quickInput: IQuickInputService, star: Star, name: unknown) {
  const picked = await pickAsk(quickInput, star, name, "Open an ask's file");
  if (picked === undefined) return;
  const commands = await getService(ICommandService);
  await commands.executeCommand("pult-shell.selectStar", star.id);
  // A switch cancelled over a modified file leaves the selection as it was, so the ask is not opened among its tabs.
  if (selectedStar() !== star.id) return;
  await (
    await getService(IEditorService)
  ).openEditor({
    resource: pultResource(picked.home.environmentId, toUriPath(picked.ask.path)),
    options: { pinned: true },
  });
  await commands.executeCommand("pult-shell.showComposer");
}

/** How long Reply waits for a sleeping Star's draft to reach the composer store once its tab shows it. */
const COMPOSER_WAIT_MS = 5_000;

/**
 * Reply: the Star selected, its tab shown, and the ask cited at the end of
 * its `user` composer's message, its current conversation's or, asleep, its
 * draft's, as Cite cites a file's lines (`view/citations.ts`): the ask's
 * whole text under its path relative to the Star's folder, whatever the
 * composer holds kept before it. Nothing is sent, and the ask stays until
 * the Star deletes it. A switch cancelled, or a composer not there in time,
 * says why Reply could not prepare it.
 */
async function replyToStarAsk(quickInput: IQuickInputService, star: Star, name: unknown) {
  const picked = await pickAsk(quickInput, star, name, "Reply to an ask of the Star's");
  if (picked === undefined) return;
  const { home, ask } = picked;
  const notifications = await getService(INotificationService);
  await (await getService(ICommandService)).executeCommand("pult-shell.selectStar", star.id);
  if (selectedStar() !== star.id)
    return notifications.info(`Reply could not prepare ${ask.title}: the Star is not selected.`);
  await (
    await getService(IEditorService)
  ).openEditor((await getService(IInstantiationService)).createInstance(StarInput, star.id), {
    pinned: true,
  });
  const target = starTarget(star);
  const [drafts, citations] = await Promise.all([
    import("../../view/drafts.ts"),
    import("../../view/citations.ts"),
  ]);
  const ready =
    target !== undefined &&
    connection.environment(target.environmentId) !== undefined &&
    (await composerReady(drafts, target));
  const cited =
    ready &&
    citations.citeFileLines(target, {
      path: citedPath(
        { environmentId: home.environmentId, root: home.root },
        { environmentId: home.environmentId, hostPath: ask.path },
      ),
      startLine: 1,
      endLine: Math.max(1, ask.text.split("\n").length),
      contents: ask.text,
    });
  if (!cited)
    notifications.info(`Reply could not prepare ${ask.title}: the Star's composer is not ready.`);
}

/** Whether the composer store holds the target's composer, waiting a moment for a draft its tab is mounting. */
function composerReady(
  drafts: typeof import("../../view/drafts.ts"),
  target: ComposerTarget,
): Promise<boolean> {
  if (drafts.composerKey(target) !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      stop();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), COMPOSER_WAIT_MS);
    const stop = drafts.onDidChangeComposers(() => {
      if (drafts.composerKey(target) !== null) finish(true);
    });
  });
}

/**
 * An open channel's conversation of the Star's, but `user`'s, which is its
 * tab, as a thread's tab among the Star's (`StarThreadInput`), as its card
 * lists them: `slug`'s, or one picked among them; the Star selected first,
 * and the channel's tab left on an ended conversation by a rotation shown on
 * its current one in place (`rotatedChannelTab`).
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
  // A tab the channel's rotation left on its ended conversation becomes its current one, in place.
  const groups = await getService(IEditorGroupsService);
  const tabs = groups.groups.flatMap((group) =>
    group.editors.flatMap((editor) =>
      editor instanceof StarThreadInput ? [{ group, editor }] : [],
    ),
  );
  const rotated = rotatedChannelTab(
    tabs.map(({ editor }) => editor),
    channel.slug,
    channel.thread,
    threadStore.get().threads,
  );
  const replaced = tabs.find(({ editor }) => editor === rotated);
  if (replaced !== undefined) {
    const replacement = (await getService(IInstantiationService)).createInstance(
      StarThreadInput,
      environmentId,
      id,
      channel.slug,
    );
    await replaced.group.replaceEditors([
      { editor: replaced.editor, replacement, options: { pinned: true } },
    ]);
    await replaced.group.openEditor(replacement, { pinned: true });
    return;
  }
  await (
    await getService(IEditorService)
  ).openEditor(
    (await getService(IInstantiationService)).createInstance(
      StarThreadInput,
      environmentId,
      id,
      channel.slug,
    ),
    { pinned: true },
  );
}

/**
 * A Star's child, a thread it launched, as a thread's tab among the Star's
 * (`StarThreadInput`, no slug), as its card lists them; the Star selected first.
 */
async function openStarChild(star: Star, environmentId: string, threadId: string): Promise<void> {
  const commands = await getService(ICommandService);
  await commands.executeCommand("pult-shell.selectStar", star.id);
  // A switch cancelled over a modified file leaves the selection as it was, so the child is not opened among its tabs.
  if (selectedStar() !== star.id) return;
  await (
    await getService(IEditorService)
  ).openEditor(
    (await getService(IInstantiationService)).createInstance(
      StarThreadInput,
      environmentId,
      threadId,
      null,
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

/** What the Star's commands do not do yet, loud where it is asked for: `grep 'todo('` lists it. */
function todo(reason: string): never {
  throw new Error(`Pult's Stars do not do this yet: ${reason}.`);
}

/**
 * The palette's Star commands: Pult: Create Star (`pult-shell.createStar
 * [environmentId]`, a new Star on any held environment whose Pult plugin
 * serves Stars, picked among them while there are several, named in an
 * input box first; not yet on an environment holding no Star while a Star
 * the page holds syncs, which a clone per Star will bring there), Edit Star Instructions
 * (`pult-shell.editStarInstructions [starId]`), Open Star Folder
 * (`pult-shell.openStarFolder [starId]`), Open Star Schedule…
 * (`pult-shell.openStarSchedule [starId] [name]`, the card's schedule rows),
 * Open Star Ask… (`pult-shell.openStarAsk [starId] [name]`, the card's badge
 * and an ask's notification: its row in Inbox expanded), Open Star Ask
 * Source… (`pult-shell.openStarAskSource [starId] [name]`, the row's Open
 * Source), Reply to Star Ask… (`pult-shell.replyToStarAsk [starId] [name]`,
 * the row's Reply), Open Star Channel… (`pult-shell.openStarChannel [starId] [slug]`,
 * the card's channel rows), Sync Star (`pult-shell.syncStar
 * [starId]`, `syncing.ts`) and Refresh Context (`pult-shell.refreshContext
 * [starId]`, the Star's current conversation in `user` put to sleep, offered only
 * while `canSleepStar`), each on the page's Star, picked while it holds
 * several. `pult-shell.openStarChild <starId> <environmentId> <threadId>`,
 * off the palette, is the card's child rows'. Open Star is the selection's
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
        // A new Star is named before it is made, its folder named after it by the plugin.
        const create = async (environmentId: string) => {
          const holds = starStore
            .get()
            .some((star) => star.homes.some((home) => home.environmentId === environmentId));
          // Stars that sync go to an environment holding none as second homes, cloned there, rather than a new Star made beside them.
          if (
            !holds &&
            starStore.get().some((star) => star.homes.some((home) => home.origin !== undefined))
          )
            todo("clone per Star");
          const name = await (
            await getService(IQuickInputService)
          ).input({
            title: "Create Star",
            prompt: "The Star's name, which also names its folder",
            placeHolder: "Vega",
            ignoreFocusLost: true,
            validateInput: async (text) => (text.trim() === "" ? "Enter a name." : undefined),
          });
          if (name === undefined || name.trim() === "") return;
          return createStar(environmentId, name.trim());
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
          id: "pult-shell.openStarAskSource",
          title: { value: "Open Star Ask Source…", original: "Open Star Ask Source…" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown, name?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const star = await pickStar(quickInput, starId, "Open a Star's ask's file");
        if (star !== undefined) await openStarAskSource(quickInput, star, name);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.replyToStarAsk",
          title: { value: "Reply to Star Ask…", original: "Reply to Star Ask…" },
          category,
          f1: true,
          precondition: HasStarContext,
        });
      }

      async run(accessor: ServicesAccessor, starId?: unknown, name?: unknown): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const star = await pickStar(quickInput, starId, "Reply to a Star's ask");
        if (star !== undefined) await replyToStarAsk(quickInput, star, name);
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
          id: "pult-shell.openStarChild",
          title: { value: "Open Star Child", original: "Open Star Child" },
          category,
          precondition: HasStarContext,
        });
      }

      async run(
        _accessor: ServicesAccessor,
        starId?: unknown,
        environmentId?: unknown,
        threadId?: unknown,
      ): Promise<void> {
        const star = typeof starId === "string" ? starById(starId) : undefined;
        if (star === undefined || typeof environmentId !== "string" || typeof threadId !== "string")
          throw new Error(
            "pult-shell.openStarChild takes a held Star's id, an environment and a thread.",
          );
        await openStarChild(star, environmentId, threadId);
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
