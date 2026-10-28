import {
  getService,
  ICommandService,
  IDecorationsService,
  IEditorService,
  ILanguageService,
  IModelService,
  ISCMService,
  ITextModelService,
  IUriIdentityService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
// The package ships `observable`'s types only; its parts are modules of their own.
import { constObservable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/constObservable";
import { observableValue } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/observableValue";
import type { IExtUri } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import { ResourceTree } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resourceTree";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { ITextModel } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/model";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import type {
  ISCMProvider,
  ISCMRepository,
  ISCMResource,
  ISCMResourceDecorations,
  ISCMResourceGroup,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm";
import type { ReviewDiffPreviewSource, ReviewDiffPreviewSourceKind } from "@t3tools/contracts";

import { pultUri } from "../panel/explorer.ts";
import { onDidSelectThread, selectedThread, selectThread } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { type ChangeType, patchFiles } from "./patch.ts";
import { changesServer } from "./server.ts";

/** The scheme of a change's two sides, served by the view's content provider from the server's file contents RPC. */
const DIFF_SCHEME = "pult-diff";
/** The source control's provider id, which `scmProvider` in menus' `when` names. */
const PROVIDER_ID = "pult-shell";

/** A changed file of a source, with what the server's file contents RPC needs to show its sides. */
interface Change {
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** Relative to `cwd`, after the change. */
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeType;
  readonly additions: number;
  readonly deletions: number;
}

/** The content provider's query: a change and which of its sides. */
interface Side {
  readonly change: Change;
  readonly side: "old" | "new";
}

const GROUPS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly kind: ReviewDiffPreviewSourceKind }> = [
  { id: "changes", label: "Changes", kind: "branch-range" },
  { id: "working-tree", label: "Working Tree", kind: "working-tree" },
];

const BADGES: Record<ChangeType, { readonly badge: string; readonly color: string; readonly label: string }> = {
  change: { badge: "M", color: "gitDecoration.modifiedResourceForeground", label: "Modified" },
  new: { badge: "A", color: "gitDecoration.addedResourceForeground", label: "Added" },
  deleted: { badge: "D", color: "gitDecoration.deletedResourceForeground", label: "Deleted" },
  "rename-pure": { badge: "R", color: "gitDecoration.renamedResourceForeground", label: "Renamed" },
  "rename-changed": { badge: "R", color: "gitDecoration.renamedResourceForeground", label: "Renamed and modified" },
};

class ChangeResource implements ISCMResource {
  readonly sourceUri: URI;
  readonly decorations: ISCMResourceDecorations;
  readonly contextValue = undefined;
  // No command: the view calls `open`.
  readonly command = undefined;
  readonly multiDiffEditorOriginalUri: URI;
  readonly multiDiffEditorModifiedUri: URI;

  constructor(
    readonly resourceGroup: ChangesGroup,
    readonly change: Change,
    private readonly view: ChangesView,
  ) {
    const sides = view.sides(change);
    this.sourceUri = view.fileUri(change);
    this.multiDiffEditorOriginalUri = sides.original;
    this.multiDiffEditorModifiedUri = sides.modified;
    this.decorations = {
      strikeThrough: change.changeType === "deleted",
      tooltip: `${BADGES[change.changeType].label}, +${change.additions} −${change.deletions}`,
    };
  }

  open(preserveFocus: boolean): Promise<void> {
    return this.view.open(this.change, preserveFocus);
  }
}

class ChangesGroup implements ISCMResourceGroup {
  resources: ReadonlyArray<ChangeResource> = [];
  contextValue: string | undefined = undefined;
  readonly hideWhenEmpty = true;
  readonly multiDiffEditorEnableViewChanges = false;
  // The label never changes.
  readonly onDidChange = Event.None;
  private readonly resourcesChanged = new Emitter<void>();
  readonly onDidChangeResources = this.resourcesChanged.event;
  private tree: ResourceTree<ChangeResource, ChangesGroup> | undefined;

  constructor(
    readonly provider: ChangesProvider,
    readonly id: string,
    readonly label: string,
    private readonly extUri: IExtUri,
  ) {}

  /** The tree view's folders, built when the view first asks. */
  get resourceTree() {
    if (this.tree === undefined) {
      this.tree = new ResourceTree<ChangeResource, ChangesGroup>(this, this.provider.rootUri, this.extUri);
      for (const resource of this.resources) this.tree.add(resource.sourceUri, resource);
    }
    return this.tree;
  }

  set(resources: ReadonlyArray<ChangeResource>): void {
    this.resources = resources;
    this.tree = undefined;
    this.resourcesChanged.fire();
  }

  dispose(): void {
    this.resourcesChanged.dispose();
  }
}

let providers = 0;
let inputs = 0;

/** The source control of one root: no input, no history, the two groups. */
class ChangesProvider implements ISCMProvider {
  readonly id = `pult-shell.changes.${++providers}`;
  readonly providerId = PROVIDER_ID;
  readonly label = "Pult";
  readonly groups: ReadonlyArray<ChangesGroup>;
  readonly onDidChangeResourceGroups = Event.None;
  private readonly resourcesChanged = new Emitter<void>();
  readonly onDidChangeResources = this.resourcesChanged.event;
  readonly count = observableValue<number | undefined>(this, undefined);
  readonly contextValue = constObservable(undefined);
  readonly commitTemplate = constObservable("");
  readonly artifactProvider = constObservable(undefined);
  readonly historyProvider = constObservable(undefined);
  readonly actionButton = constObservable(undefined);
  readonly statusBarCommands = constObservable(undefined);

  constructor(
    /** The root's host path, the server's `cwd`. */
    readonly root: string,
    readonly rootUri: URI,
    readonly name: string,
    readonly inputBoxTextModel: ITextModel,
    extUri: IExtUri,
  ) {
    this.groups = GROUPS.map(({ id, label }) => new ChangesGroup(this, id, label, extUri));
  }

  group(id: string): ChangesGroup {
    return this.groups.find((group) => group.id === id)!;
  }

  changed(count: number): void {
    this.count.set(count, undefined);
    this.resourcesChanged.fire();
  }

  getOriginalResource(): Promise<URI | null> {
    return Promise.resolve(null);
  }

  dispose(): void {
    for (const group of this.groups) group.dispose();
    this.resourcesChanged.dispose();
    this.inputBoxTextModel.dispose();
  }
}

type Services = {
  readonly scm: ISCMService;
  readonly models: IModelService;
  readonly languages: ILanguageService;
  readonly editors: IEditorService;
  readonly commands: ICommandService;
  readonly extUri: IExtUri;
};

/**
 * The changes view: VS Code's Source Control view over the selected
 * thread's project, in place of upstream's diff panel (`pult/decisions`,
 * `view-right-panel`). One source control, for the thread's root, with the
 * server's two diff sources as its groups, Changes (the branch against its
 * base) and Working Tree; a resource opens VS Code's diff editor, its old
 * side from the server, its new side the live `pult:` file, or the server's
 * for a deleted file or a committed change. It follows the shell's
 * selection, and refreshes when the thread's latest run finishes and on
 * "Pult: Refresh Changes".
 */
class ChangesView {
  private repository: { readonly repository: ISCMRepository; readonly provider: ChangesProvider; readonly key: string } | undefined;
  private threadId: string | null = null;
  private finishedAt: string | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private changes = new Map<string, Change>();
  /** The changes by their `pult:` URI's path, for the decorations. */
  private byPath = new Map<string, Change>();
  private readonly contents = new Map<string, Promise<{ readonly oldContents: string; readonly newContents: string }>>();
  private failure: string | null = null;
  private readonly decorationsChanged = new Emitter<URI[]>();

  constructor(private readonly services: Services) {}

  /** Starts following the selection and the store, with the `pult-diff:` sides and the badges registered. */
  static async start(): Promise<ChangesView> {
    const [scm, models, languages, editors, commands, textModels, decorations, uriIdentity] = await Promise.all([
      getService(ISCMService),
      getService(IModelService),
      getService(ILanguageService),
      getService(IEditorService),
      getService(ICommandService),
      getService(ITextModelService),
      getService(IDecorationsService),
      getService(IUriIdentityService),
    ]);
    const view = new ChangesView({ scm, models, languages, editors, commands, extUri: uriIdentity.extUri });
    textModels.registerTextModelContentProvider(DIFF_SCHEME, {
      provideTextContent: async (uri) => {
        const text = await view.sideContents(uri);
        return models.getModel(uri) ?? models.createModel(text, languages.createByFilepathOrFirstLine(uri), uri);
      },
    });
    decorations.registerDecorationsProvider({
      label: "Pult",
      onDidChange: view.decorationsChanged.event,
      provideDecorations: (uri) => view.decoration(uri),
    });
    onDidSelectThread(() => view.select(selectedThread()?.threadId ?? null));
    // The store may load after the selection, and a finished run changes the files.
    threadStore.subscribe(() => {
      const finishedAt = view.selected()?.latestRun?.finishedAt ?? null;
      const finished = finishedAt !== view.finishedAt;
      view.finishedAt = finishedAt;
      view.sync(finished);
    });
    view.select(selectedThread()?.threadId ?? null);
    return view;
  }

  private selected() {
    return this.threadId === null ? undefined : threadStore.get().threads.find((thread) => thread.id === this.threadId);
  }

  /** The thread whose project the view shows; its root decides the source control. */
  select(threadId: string | null): void {
    this.threadId = threadId;
    this.finishedAt = this.selected()?.latestRun?.finishedAt ?? null;
    this.sync(true);
  }

  /** The source control follows the selected thread's root as the store knows it; `refresh` reloads an unchanged one too. */
  private sync(refresh: boolean): void {
    const thread = this.selected();
    const environmentId = threadStore.get().environment?.id;
    const root = thread === undefined ? undefined : (thread.projectRoot ?? threadStore.project(thread.projectId)?.root ?? undefined);
    if (thread === undefined || environmentId === undefined || root === undefined) {
      if (this.repository === undefined) return;
      this.generation += 1;
      this.repository.repository.dispose();
      this.repository = undefined;
      this.apply([]);
      return;
    }
    const key = `${environmentId}\n${root}`;
    if (this.repository?.key === key) {
      if (refresh) this.refresh();
      return;
    }
    this.repository?.repository.dispose();
    const { scm, models, extUri } = this.services;
    // The input box stays hidden, but the view's input widget takes a model.
    const input = models.createModel("", null, URI.from({ scheme: "pult-scm-input", path: `/${++inputs}` }));
    const provider = new ChangesProvider(root, pultUri(environmentId, root), thread.projectName, input, extUri);
    const repository = scm.registerSCMProvider(provider);
    repository.input.visible = false;
    this.repository = { repository, provider, key };
    this.apply([]);
    this.refresh();
  }

  /** The Source Control view, on `threadId` selected, with the change of `path` open when the view has it. */
  async show(threadId: string | null, path: string | null): Promise<void> {
    if (threadId !== null && threadId !== selectedThread()?.threadId) await selectThread(threadId);
    await this.services.commands.executeCommand("workbench.view.scm");
    if (path === null) return;
    await this.pending;
    const change = GROUPS.map((group) => this.changes.get(`${group.kind}:${path}`)).find((found) => found !== undefined);
    if (change !== undefined) await this.open(change, false);
  }

  /** The newest refresh wins; an older one's answer is dropped. */
  refresh(): void {
    const current = this.repository;
    if (current === undefined) return;
    const generation = ++this.generation;
    this.pending = changesServer.diffPreview({ cwd: current.provider.root }).then(
      (preview) => {
        if (generation !== this.generation) return;
        this.failure = null;
        this.apply(preview.sources);
      },
      (error: unknown) => {
        // Not a repository, or a server without the review calls: no changes to show.
        if (generation !== this.generation) return;
        this.failure = error instanceof Error ? error.message : String(error);
        this.apply([]);
      },
    );
  }

  private apply(sources: ReadonlyArray<ReviewDiffPreviewSource>): void {
    const provider = this.repository?.provider;
    const previous = [...this.changes.values()].map((change) => this.fileUri(change));
    this.changes = new Map();
    this.contents.clear();
    if (provider !== undefined) {
      for (const { id, kind } of GROUPS) {
        const source = sources.find((candidate) => candidate.kind === kind);
        const changes = source === undefined ? [] : changesOf(provider.root, source);
        for (const change of changes) this.changes.set(`${kind}:${change.path}`, change);
        const group = provider.group(id);
        group.set(changes.map((change) => new ChangeResource(group, change, this)));
      }
      // The badge counts files, not their appearances in both groups.
      provider.changed(new Set([...this.changes.values()].map((change) => change.path)).size);
    }
    const current = [...this.changes.values()].map((change) => this.fileUri(change));
    this.byPath = new Map([...this.changes.values()].map((change) => [this.fileUri(change).path, change]));
    this.decorationsChanged.fire([...previous, ...current]);
  }

  /** VS Code's diff editor on the change's two sides. */
  async open(change: Change, preserveFocus: boolean): Promise<void> {
    const { original, modified } = this.sides(change);
    const group = GROUPS.find((candidate) => candidate.kind === change.sourceKind)?.label ?? "Changes";
    await this.services.editors.openEditor({
      original: { resource: original },
      modified: { resource: modified },
      label: `${change.path.split("/").at(-1)} (${group})`,
      options: { pinned: false, preserveFocus },
    });
  }

  /** The diff's sides: the server's old one, and the live file for a working-tree change but a deletion, else the server's new one. */
  sides(change: Change): { readonly original: URI; readonly modified: URI } {
    const live = change.sourceKind === "working-tree" && change.changeType !== "deleted";
    return { original: this.sideUri(change, "old"), modified: live ? this.fileUri(change) : this.sideUri(change, "new") };
  }

  private async sideContents(uri: URI): Promise<string> {
    const { change, side } = JSON.parse(uri.query) as Side;
    const key = JSON.stringify([change.cwd, change.sourceKind, change.baseRef, change.headRef, change.previousPath, change.path]);
    let loading = this.contents.get(key);
    if (loading === undefined) {
      loading = changesServer.diffFileContents({
        cwd: change.cwd,
        sourceKind: change.sourceKind,
        changeType: change.changeType,
        baseRef: change.baseRef,
        headRef: change.headRef,
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
      });
      this.contents.set(key, loading);
    }
    const contents = await loading;
    return side === "old" ? contents.oldContents : contents.newContents;
  }

  private decoration(uri: URI) {
    if (uri.scheme !== "pult") return undefined;
    const change = this.byPath.get(uri.path);
    if (change === undefined) return undefined;
    const { badge, color, label } = BADGES[change.changeType];
    return { letter: badge, color, tooltip: label, bubble: true };
  }

  fileUri(change: Change): URI {
    return pultUri(this.environmentId(), joinPath(change.cwd, change.path));
  }

  private sideUri(change: Change, side: Side["side"]): URI {
    const path = side === "old" ? (change.previousPath ?? change.path) : change.path;
    return pultUri(this.environmentId(), joinPath(change.cwd, path)).with({
      scheme: DIFF_SCHEME,
      query: JSON.stringify({ change, side } satisfies Side),
    });
  }

  private environmentId(): string {
    return this.repository?.provider.rootUri.authority ?? threadStore.get().environment?.id ?? "";
  }

  /** What the view shows and why, for the console. */
  state() {
    const provider = this.repository?.provider;
    return {
      threadId: this.threadId,
      root: provider?.root ?? null,
      groups: Object.fromEntries((provider?.groups ?? []).map((group) => [group.id, group.resources.length])),
      failure: this.failure,
    };
  }
}

/** A source's files as changes: its stats, with how each changed from its patch; a file the truncated patch missed counts as modified. */
function changesOf(cwd: string, source: ReviewDiffPreviewSource): Change[] {
  const parsed = new Map(patchFiles(source.diff).map((file) => [file.path, file]));
  const stats = source.files ?? [...parsed.values()].map((file) => ({ ...file, additions: 0, deletions: 0 }));
  return stats.map((stat) => {
    const file = parsed.get(stat.path);
    return {
      cwd,
      sourceKind: source.kind,
      baseRef: source.baseRef,
      headRef: source.headRef,
      path: stat.path,
      previousPath: file?.previousPath ?? stat.previousPath,
      changeType: file?.changeType ?? (stat.previousPath === null ? "change" : "rename-changed"),
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
}

function joinPath(root: string, relativePath: string): string {
  if (relativePath === "") return root;
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

let started: Promise<ChangesView> | undefined;

/**
 * Opens the Source Control view on `threadId`, selecting it first if another
 * is selected, with the change of `path`, relative to its project's root,
 * open when the view lists it: the thread view's "Open diff".
 */
export async function showChanges(threadId: string | null, path: string | null): Promise<void> {
  await (await started)?.show(threadId, path);
}

/** What the changes view shows and why, for the console's `pult.changes()`. */
export async function changesState() {
  return (await started)?.state();
}

/**
 * The changes view, started once the workbench's services are up, with
 * `pult-shell.showChanges <threadId> <path|null>` and "Pult: Refresh
 * Changes" (`pult-shell.refreshChanges`, also in the Source Control view's
 * title).
 */
export function registerChanges(): void {
  started = ChangesView.start();
  started.catch((error: unknown) => console.error("[pult-shell] the changes view did not start", error));
  CommandsRegistry.registerCommand("pult-shell.showChanges", (_accessor, threadId: unknown, path: unknown) =>
    showChanges(typeof threadId === "string" ? threadId : null, typeof path === "string" ? path : null),
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.refreshChanges",
          title: { value: "Refresh Changes", original: "Refresh Changes" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.refresh,
          f1: true,
          menu: [{ id: MenuId.SCMTitle, group: "navigation", when: ContextKeyExpr.equals("scmProvider", PROVIDER_ID) }],
        });
      }

      async run(): Promise<void> {
        (await started)?.refresh();
      }
    },
  );
}
