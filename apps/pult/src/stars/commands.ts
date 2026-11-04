import {
  getService,
  ICommandService,
  IContextKeyService,
  IEditorService,
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
import { selectedStar } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { canCreateStarOn, createStar, primaryHome, starById, starStore } from "./model.ts";
import { RECORD_FILE } from "./record.ts";
import { type Star, starName } from "./stars.ts";

/** Whether the page holds a Star: Open Star, Edit Star Instructions and Open Star Folder are offered then. */
export const HasStarContext = new RawContextKey<boolean>("pult.hasStar", false);
/** Whether a held environment has no Star: Create Star is offered then. */
const CanCreateStarContext = new RawContextKey<boolean>("pult.canCreateStar", false);

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

/** The `pult:` URI of a path under the home's folder. */
function homeResource(home: NonNullable<ReturnType<typeof primaryHome>>, path = "") {
  return pultResource(
    home.environmentId,
    toUriPath(path === "" ? home.root : `${home.root.replace(/[/\\]+$/, "")}/${path}`),
  );
}

/** The Star's `AGENTS.md`, its record and standing instructions, as a tab among the selection's, from the home that stands for it. */
async function editStarInstructions(star: Star): Promise<void> {
  const home = primaryHome(star);
  if (home === undefined)
    return void (await getService(INotificationService)).info(
      "Pult is not connected to your Star's environment.",
    );
  await (
    await getService(IEditorService)
  ).openEditor({ resource: homeResource(home, RECORD_FILE), options: { pinned: true } });
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
  await commands.executeCommand("revealInExplorer", homeResource(home));
}

/**
 * The palette's Star commands: Pult: Create Star (`pult-shell.createStar
 * [environmentId]`, while a held environment has none, picked among them
 * while there are several), Edit Star Instructions
 * (`pult-shell.editStarInstructions [starId]`) and Open Star Folder
 * (`pult-shell.openStarFolder [starId]`), each on the page's Star, picked
 * while it holds several. Open Star is the selection's
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
        if (typeof environmentId === "string") return createStar(environmentId);
        const candidates = connection.environments.filter((environment) =>
          canCreateStarOn(environment.environmentId),
        );
        if (candidates.length === 0)
          return void (await getService(INotificationService)).info(
            "Every connected environment has a Star.",
          );
        const picked = await pickEnvironment(candidates, "Create a Star on an environment");
        if (picked !== undefined) await createStar(picked.environmentId);
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
  void getService(IContextKeyService).then((contextKeys) => {
    const hasStar = HasStarContext.bindTo(contextKeys);
    const canCreate = CanCreateStarContext.bindTo(contextKeys);
    const update = () => {
      hasStar.set(starStore.get().length > 0);
      canCreate.set(
        connection.environments.some((environment) => canCreateStarOn(environment.environmentId)),
      );
    };
    starStore.subscribe(update);
    connection.onDidChange(update);
    update();
  });
}
