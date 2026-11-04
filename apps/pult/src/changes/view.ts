import {
  getService,
  ICommandService,
  IContextKeyService,
  IDecorationsService,
  IEditorService,
  IFileService,
  IHostService,
  ILanguageService,
  IModelService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  ISCMService,
  ISCMViewService,
  ITextModelService,
  IUriIdentityService,
  IViewsService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import type { ThemeIcon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/themables";
// The package ships `observable`'s types only; its parts are modules of their own.
import { constObservable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/constObservable";
import { observableValue } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/observableValue";
import type { IExtUri } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import { ResourceTree } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resourceTree";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { ITextModel } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/model";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import {
  ContextKeyExpr,
  RawContextKey,
  type IContextKey,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ProgressLocation } from "@codingame/monaco-vscode-api/vscode/vs/platform/progress/common/progress";
import { Registry } from "@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform";
import { registerColor } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colorUtils";
import {
  Extensions as ViewExtensions,
  type IViewsRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import type {
  ISCMActionButtonDescriptor,
  ISCMProvider,
  ISCMRepository,
  ISCMResource,
  ISCMResourceDecorations,
  ISCMResourceGroup,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm";
import { ProjectId, ThreadId, type ReviewDiffPreviewSourceKind } from "@t3tools/contracts";

import type { TurnCheckpoints } from "../../thread-view/shell/main.tsx";

import { pultUri } from "../panel/explorer.ts";
import {
  onDidSelectThread,
  selectedThread,
  selectThread,
  type ThreadSelection,
} from "../threads/selection.ts";
import { threadProjectIcon } from "../threads/projectIcon.ts";
import { scopedKey, type ShellThread, threadStore } from "../threads/store.ts";
import { setChangesCard, mountChangesCard } from "./card.tsx";
import {
  type Change,
  type Checkout,
  checkoutKey,
  checkoutName,
  checkoutsOf,
  shownChanges,
} from "./checkouts.ts";
import {
  actionStarted,
  COMMIT_STARTED,
  commitFailure,
  commitPlaceholder,
  type CommitProgress,
  commitProgress,
} from "./commit.ts";
import { type ChangeType, patchFiles } from "./patch.ts";
import { changesServer } from "./server.ts";
import {
  afterStep,
  hasSync,
  pullFailure,
  SYNC_INTERVAL_MS,
  syncAction,
  syncState,
  type SyncState,
  syncSteps,
  syncTitle,
  syncTooltip,
} from "./sync.ts";

/** The scheme of a change's two sides, served by the view's content provider from the server's file contents RPC. */
const DIFF_SCHEME = "pult-diff";
/** The source controls' provider id, which `scmProvider` in menus' `when` names. */
const PROVIDER_ID = "pult-shell";
/** Source Control's view container, whose visibility decides whether the view refreshes. */
const SCM_CONTAINER = "workbench.view.scm";
/** How many checkouts' diffs a refresh asks for at once. */
const REFRESH_CONCURRENCY = 4;
/** How long the view waits after a file changes under a checkout before reading it again, so a burst of writes is one read. */
const FILE_CHANGE_DELAY_MS = 300;
/** Commits a checkout, the one its key names, else the filter's or a pick of those shown with uncommitted changes. */
const COMMIT_COMMAND = "pult-shell.commit";
/** Commits a checkout and pushes it, picked as Commit picks. */
const COMMIT_PUSH_COMMAND = "pult-shell.commitAndPush";
/** Pulls then pushes a checkout, the one its key names, else the filter's or a pick of those with commits to sync. */
const SYNC_COMMAND = "pult-shell.sync";
const PULL_COMMAND = "pult-shell.pull";
/** Pushes a checkout's branch, publishing it when it has no upstream. */
const PUSH_COMMAND = "pult-shell.push";

/** While the view shows one thread's checkout, under its card: for `when` clauses. */
const ChangesFilteredContext = new RawContextKey<boolean>("pult.changesFiltered", false);

/** The content provider's query: a change and which of its sides. */
interface Side {
  readonly change: Change;
  readonly side: "old" | "new";
}

/** The group of a turn the thread view named, alone in the view while the filter's thread has one. */
const TURN_GROUP = "turn";

const GROUPS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly kind: ReviewDiffPreviewSourceKind;
}> = [
  { id: "changes", label: "Changes", kind: "branch-range" },
  { id: "working-tree", label: "Working Tree", kind: "working-tree" },
];

function groupLabel(kind: ReviewDiffPreviewSourceKind | undefined): string {
  return GROUPS.find((group) => group.kind === kind)?.label ?? "Changes";
}

// The badges' colours, which VS Code's git extension registers and this build does not run: its defaults, which themes override.
registerColor(
  "gitDecoration.modifiedResourceForeground",
  { dark: "#E2C08D", light: "#895503", hcDark: "#E2C08D", hcLight: "#895503" },
  "Modified files in the changes view.",
);
registerColor(
  "gitDecoration.addedResourceForeground",
  { dark: "#81B88B", light: "#587C0C", hcDark: "#A1E3AD", hcLight: "#374E06" },
  "Added files in the changes view.",
);
registerColor(
  "gitDecoration.deletedResourceForeground",
  { dark: "#C74E39", light: "#AD0707", hcDark: "#C74E39", hcLight: "#AD0707" },
  "Deleted files in the changes view.",
);
registerColor(
  "gitDecoration.renamedResourceForeground",
  { dark: "#73C991", light: "#007100", hcDark: "#73C991", hcLight: "#007100" },
  "Renamed files in the changes view.",
);

/** A change's badge through the decorations service, and its icon in the turn's group, whose rows the service does not badge. */
const BADGES: Record<
  ChangeType,
  {
    readonly badge: string;
    readonly icon: ThemeIcon;
    readonly color: string;
    readonly label: string;
  }
> = {
  change: {
    badge: "M",
    icon: Codicon.diffModified,
    color: "gitDecoration.modifiedResourceForeground",
    label: "Modified",
  },
  new: {
    badge: "A",
    icon: Codicon.diffAdded,
    color: "gitDecoration.addedResourceForeground",
    label: "Added",
  },
  deleted: {
    badge: "D",
    icon: Codicon.diffRemoved,
    color: "gitDecoration.deletedResourceForeground",
    label: "Deleted",
  },
  "rename-pure": {
    badge: "R",
    icon: Codicon.diffRenamed,
    color: "gitDecoration.renamedResourceForeground",
    label: "Renamed",
  },
  "rename-changed": {
    badge: "R",
    icon: Codicon.diffRenamed,
    color: "gitDecoration.renamedResourceForeground",
    label: "Renamed and modified",
  },
};

/** The live file a change is of. */
function fileUri(change: Change): URI {
  return pultUri(change.environmentId, joinPath(change.cwd, change.path));
}

/** A `pult:` file's key among the decorated, the authority in any case. */
function decorationKey(uri: URI): string {
  return `${uri.authority.toLowerCase()}\n${uri.path}`;
}

function sideUri(change: Change, side: Side["side"]): URI {
  const path = side === "old" ? (change.previousPath ?? change.path) : change.path;
  return pultUri(change.environmentId, joinPath(change.cwd, path)).with({
    scheme: DIFF_SCHEME,
    query: JSON.stringify({ change, side } satisfies Side),
  });
}

/** The diff's sides: the server's old one, and the live file for a working-tree change but a deletion, else the server's new one; a turn's both its checkpoints'. */
function sides(change: Change): { readonly original: URI; readonly modified: URI } {
  const live = change.sourceKind === "working-tree" && change.changeType !== "deleted";
  return {
    original: sideUri(change, "old"),
    modified: live ? fileUri(change) : sideUri(change, "new"),
  };
}

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
    private readonly opener: (change: Change, preserveFocus: boolean) => Promise<void>,
  ) {
    const { original, modified } = sides(change);
    this.sourceUri = fileUri(change);
    this.multiDiffEditorOriginalUri = original;
    this.multiDiffEditorModifiedUri = modified;
    const { icon, color, label } = BADGES[change.changeType];
    // A turn's files are history: a badge through the decorations service would mark the live files in the explorer too.
    const turnIcon = change.sourceKind === "turn" ? { ...icon, color: { id: color } } : undefined;
    this.decorations = {
      strikeThrough: change.changeType === "deleted",
      tooltip: `${label}, +${change.additions} −${change.deletions}`,
      ...(turnIcon === undefined ? {} : { icon: turnIcon, iconDark: turnIcon }),
    };
  }

  open(preserveFocus: boolean): Promise<void> {
    return this.opener(this.change, preserveFocus);
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
      this.tree = new ResourceTree<ChangeResource, ChangesGroup>(
        this,
        this.provider.rootUri,
        this.extUri,
      );
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

/**
 * The source control of one checkout: no history, the turn's group and the
 * server's two, of which one at most holds files, and its commit message box
 * with the Commit button under it, Cmd+Enter in the box committing too.
 */
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
  /** The Commit button, set by the view as the checkout's changes and its commit go. */
  readonly actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
  readonly statusBarCommands = constObservable(undefined);
  /** Cmd+Enter in the message box, through the workbench's `scm.acceptInput`. */
  readonly acceptInputCommand: NonNullable<ISCMProvider["acceptInputCommand"]>;
  readonly iconPath: ThemeIcon;
  /** What the groups were last filled with, so an unchanged render leaves them be. */
  rendered: { readonly version: number; readonly turn: Turn | undefined } | undefined;

  constructor(
    readonly checkout: Checkout,
    readonly rootUri: URI,
    readonly name: string,
    readonly inputBoxTextModel: ITextModel,
    extUri: IExtUri,
  ) {
    this.acceptInputCommand = {
      id: COMMIT_COMMAND,
      title: "Commit",
      arguments: [checkoutKey(checkout.environmentId, checkout.root)],
    };
    this.iconPath = checkout.worktree === null ? Codicon.repo : Codicon.worktree;
    this.groups = [
      new ChangesGroup(this, TURN_GROUP, "Changed Files", extUri),
      ...GROUPS.map(({ id, label }) => new ChangesGroup(this, id, label, extUri)),
    ];
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

/** A checkout's latest diff, and its source control while the view shows it. */
interface Entry {
  readonly key: string;
  readonly checkout: Checkout;
  /** The one source it shows (`shownChanges`), after the last refresh; undefined before one, without changes, or when it failed. */
  shown: ReturnType<typeof shownChanges>;
  /** Bumped on every answer, for the provider's `rendered`. */
  version: number;
  failure: string | null;
  /** The refresh in flight; a newer one's answer wins. */
  loading: Promise<void> | undefined;
  generation: number;
  registered:
    | { readonly repository: ISCMRepository; readonly provider: ChangesProvider }
    | undefined;
  /** The message box's text, kept while the view does not show the checkout; null until it first shows. */
  message: string | null;
  /** The commit, push, pull or sync under way, as its progress events have it. */
  running: CommitProgress | undefined;
  /** Its branch against its upstream, after the last status read; undefined before one, or off a repository. */
  sync: SyncState | undefined;
  /** When its status was last asked for, which every read fetches, so a read waits `SYNC_INTERVAL_MS` unless forced. */
  syncReadAt: number | undefined;
  syncGeneration: number;
}

type Services = {
  readonly scm: ISCMService;
  readonly scmView: ISCMViewService;
  readonly models: IModelService;
  readonly editors: IEditorService;
  readonly commands: ICommandService;
  readonly notifications: INotificationService;
  readonly progress: IProgressService;
  readonly quickInput: IQuickInputService;
  readonly extUri: IExtUri;
  readonly filteredKey: IContextKey<boolean>;
};

/**
 * The changes view: VS Code's Source Control view, in place of upstream's
 * diff panel (`pult/decisions`, `view-right-panel`). One source control per
 * checkout of the held environments (`checkouts.ts`: each project's root and
 * each thread's worktree), and of each the one source it shows, its working
 * tree while it has uncommitted changes, else its branch against its base; a
 * resource opens VS Code's diff editor, its old side from the server, its
 * new side the live `pult:` file, or the server's for a deleted file or a
 * committed change. With no filter, the checkouts with changes alone; with
 * one (`pult-shell.showChanges`), the selected thread's checkout, changes or
 * none, under its card (`card.tsx`), the filter following the selection and
 * letting the view show everything while no thread is selected; while the
 * thread has one, a turn instead, its files alone under Changed Files: the
 * turn the thread view's changed files card last opened for the thread,
 * both sides of each file from the turn's checkpoints. It reads every
 * checkout, shown or not, so Source Control's badge counts them all: each
 * as the store brings it, when a thread on it finishes a run or a file
 * under it changes, and all when the window regains focus; what it shows on
 * showing and on "Pult: Refresh Changes". The badge is VS Code's, the files
 * of the source controls shown, so a filter's alone while one narrows. Each
 * checkout shown has a message box and a Commit button, which commit its
 * whole working tree through the server (`commit`), but under a turn.
 */
class ChangesView {
  private readonly entries = new Map<string, Entry>();
  /** Whether the view is narrowed to the selected thread, while one is. */
  private filtered = false;
  private selection: ThreadSelection | null = null;
  private visible: boolean;
  /** Each thread's latest run's end, by `scopedKey`, as last seen. */
  private finished = new Map<string, string | null>();
  /** Each thread's turn, by `turnKey`, until the filter is cleared or the thread's changes are asked for without one. */
  private readonly turns = new Map<string, Promise<Turn>>();
  private readonly loadedTurns = new Map<string, Turn>();
  /** The decorated files, by `decorationKey`: what the view shows but a turn's. */
  private decorated = new Map<string, Change>();
  private readonly contents = new Map<
    string,
    Promise<{ readonly oldContents: string; readonly newContents: string }>
  >();
  private readonly decorationsChanged = new Emitter<URI[]>();
  /** The checkouts a file changed under, read again together once the burst settles. */
  private readonly stale = new Set<Entry>();
  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly services: Services,
    private readonly views: IViewsService,
  ) {
    this.visible = views.isViewContainerVisible(SCM_CONTAINER);
  }

  /** Starts following the store, the selection and Source Control's visibility, with the `pult-diff:` sides and the badges registered. */
  static async start(): Promise<ChangesView> {
    const [
      scm,
      scmView,
      models,
      languages,
      editors,
      commands,
      textModels,
      decorations,
      uriIdentity,
      contextKeys,
      views,
      notifications,
      progress,
      quickInput,
      files,
      host,
    ] = await Promise.all([
      getService(ISCMService),
      getService(ISCMViewService),
      getService(IModelService),
      getService(ILanguageService),
      getService(IEditorService),
      getService(ICommandService),
      getService(ITextModelService),
      getService(IDecorationsService),
      getService(IUriIdentityService),
      getService(IContextKeyService),
      getService(IViewsService),
      getService(INotificationService),
      getService(IProgressService),
      getService(IQuickInputService),
      getService(IFileService),
      getService(IHostService),
    ]);
    const filteredKey = ChangesFilteredContext.bindTo(contextKeys);
    const view = new ChangesView(
      {
        scm,
        scmView,
        models,
        editors,
        commands,
        notifications,
        progress,
        quickInput,
        extUri: uriIdentity.extUri,
        filteredKey,
      },
      views,
    );
    textModels.registerTextModelContentProvider(DIFF_SCHEME, {
      provideTextContent: async (uri) => {
        const text = await view.sideContents(uri);
        return (
          models.getModel(uri) ??
          models.createModel(text, languages.createByFilepathOrFirstLine(uri), uri)
        );
      },
    });
    decorations.registerDecorationsProvider({
      label: "Pult",
      onDidChange: view.decorationsChanged.event,
      provideDecorations: (uri) => view.decoration(uri),
    });
    views.onDidChangeViewContainerVisibility(({ id, visible }) => {
      if (id === SCM_CONTAINER) view.setVisible(visible);
    });
    // A file written through the page, or changed as a folder's watch reports it, makes its checkout's diff stale.
    const { extUri } = uriIdentity;
    files.onDidFilesChange((event) => view.filesChanged((root) => event.affects(root)));
    files.onDidRunOperation(({ resource, target }) =>
      view.filesChanged(
        (root) =>
          extUri.isEqualOrParent(resource, root) ||
          (target !== undefined && extUri.isEqualOrParent(target.resource, root)),
      ),
    );
    // What changed while the page was away (a terminal, another editor, a commit) shows on its return.
    host.onDidChangeFocus((focused) => {
      if (focused) view.refreshAll();
    });
    onDidSelectThread(() => view.select(selectedThread() ?? null));
    // The store may load after the selection, adds and drops checkouts, and a finished run changes the files.
    threadStore.subscribe(() => view.syncStore());
    view.syncStore();
    view.select(selectedThread() ?? null);
    return view;
  }

  /** The thread the view is narrowed to: the selected one, while filtered. */
  private filterThread(): ShellThread | undefined {
    const selection = this.selection;
    return !this.filtered || selection === null
      ? undefined
      : threadStore.thread(selection.environmentId, selection.threadId);
  }

  private entryOf(thread: ShellThread | undefined): Entry | undefined {
    const root = thread?.checkoutRoot ?? null;
    return thread === undefined || root === null
      ? undefined
      : this.entries.get(checkoutKey(thread.environmentId, root));
  }

  /** The checkouts what the view shows comes from: the filter's thread's, or every one. */
  private scope(): ReadonlyArray<Entry> {
    const thread = this.filterThread();
    if (thread === undefined) return [...this.entries.values()];
    const entry = this.entryOf(thread);
    return entry === undefined ? [] : [entry];
  }

  /** The store's checkouts kept, new ones read while the view shows them, and a checkout read again when a thread on it finishes a run. */
  private syncStore(): void {
    const state = threadStore.get();
    const checkouts = checkoutsOf(state);
    const keys = new Set(
      checkouts.map((checkout) => checkoutKey(checkout.environmentId, checkout.root)),
    );
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue;
      entry.registered?.repository.dispose();
      this.entries.delete(key);
    }
    const added: Entry[] = [];
    for (const checkout of checkouts) {
      const key = checkoutKey(checkout.environmentId, checkout.root);
      if (this.entries.has(key)) continue;
      const entry: Entry = {
        key,
        checkout,
        shown: undefined,
        version: 0,
        failure: null,
        loading: undefined,
        generation: 0,
        registered: undefined,
        message: null,
        running: undefined,
        sync: undefined,
        syncReadAt: undefined,
        syncGeneration: 0,
      };
      this.entries.set(key, entry);
      added.push(entry);
    }
    const ended = new Set<Entry>();
    const finished = new Map<string, string | null>();
    for (const thread of state.threads) {
      const finishedAt = thread.latestRun?.finishedAt ?? null;
      const key = scopedKey(thread.environmentId, thread.id);
      const seen = this.finished.get(key);
      finished.set(key, finishedAt);
      if (seen === undefined || seen === finishedAt || finishedAt === null) continue;
      const entry = this.entryOf(thread);
      if (entry !== undefined) ended.add(entry);
    }
    this.finished = finished;
    // Shown or not, so Source Control's badge counts every checkout.
    for (const entry of added) void this.refresh(entry, false);
    // A run may have committed, so its upstream is asked about at once.
    for (const entry of ended) void this.refresh(entry, true, true);
    this.render();
  }

  /** The selected thread, which the filter follows. */
  private select(selection: ThreadSelection | null): void {
    this.selection = selection;
    if (this.filtered && this.visible) this.refreshScope(false);
    this.render();
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.refreshScope(false);
  }

  /** Marks the checkouts whose root `touches` names as stale, reading them again once writes settle. */
  private filesChanged(touches: (root: URI) => boolean): void {
    for (const entry of this.entries.values())
      if (touches(pultUri(entry.checkout.environmentId, entry.checkout.root)))
        this.stale.add(entry);
    if (this.stale.size === 0 || this.staleTimer !== undefined) return;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = undefined;
      const stale = [...this.stale];
      this.stale.clear();
      // A read already under way may predate the change.
      for (const entry of stale)
        if (this.entries.get(entry.key) === entry) void this.refresh(entry, true);
    }, FILE_CHANGE_DELAY_MS);
  }

  /** Reads every checkout again, for the badge as much as the view. */
  refreshAll(): void {
    for (const entry of this.entries.values()) void this.refresh(entry, false);
  }

  /** Reads what the view shows again; `force` asks anew even for a checkout already being read, and for its status within its interval. */
  refreshScope(force: boolean): void {
    for (const entry of this.scope()) void this.refresh(entry, force, force);
  }

  /**
   * Reads a checkout's changes, and its status once its interval is up or
   * with `fetch`; the newest refresh of a checkout wins, an older one's
   * answer dropped.
   */
  private refresh(entry: Entry, force: boolean, fetch = false): Promise<void> {
    void this.readSync(entry, fetch);
    if (entry.loading !== undefined && !force) return entry.loading;
    const generation = ++entry.generation;
    const { environmentId, root } = entry.checkout;
    const current = () => generation === entry.generation && this.entries.get(entry.key) === entry;
    const loading = limited(() => changesServer(environmentId).diffPreview({ cwd: root })).then(
      (preview) => {
        if (!current()) return;
        entry.failure = null;
        entry.shown = shownChanges(environmentId, root, preview.sources);
      },
      (error: unknown) => {
        // Not a repository, a worktree gone, or a server without the review calls: no changes to show.
        if (!current()) return;
        entry.failure = error instanceof Error ? error.message : String(error);
        entry.shown = undefined;
      },
    );
    entry.loading = loading.then(() => {
      if (!current()) return;
      entry.loading = undefined;
      entry.version += 1;
      this.contents.clear();
      this.render();
    });
    return entry.loading;
  }

  /** The checkout's status against its upstream, unless read within `SYNC_INTERVAL_MS` and not forced; the newest read wins. */
  private async readSync(entry: Entry, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && entry.syncReadAt !== undefined && now - entry.syncReadAt < SYNC_INTERVAL_MS)
      return;
    entry.syncReadAt = now;
    const generation = ++entry.syncGeneration;
    const { environmentId, root } = entry.checkout;
    let sync: SyncState | undefined;
    try {
      sync = syncState(await limited(() => changesServer(environmentId).status(root)));
    } catch {
      // Not a repository, a worktree gone: nothing to sync.
      sync = undefined;
    }
    if (generation !== entry.syncGeneration || this.entries.get(entry.key) !== entry) return;
    if (JSON.stringify(sync) === JSON.stringify(entry.sync)) return;
    entry.sync = sync;
    this.render();
  }

  /** The filter's thread's turn, when loaded and read under the thread's checkout. */
  private shownTurn(): Turn | undefined {
    const thread = this.filterThread();
    const selection = this.selection;
    if (thread === undefined || selection === null) return undefined;
    const turn = this.loadedTurns.get(turnKey(selection));
    return turn !== undefined && turn.root === thread.checkoutRoot ? turn : undefined;
  }

  /**
   * The source controls, the card and the badges as the view's state has
   * them: filtered, the thread's checkout alone, changes or none, its turn
   * instead while it has one; else every checkout with changes.
   */
  private render(): void {
    const thread = this.filterThread();
    const narrowed = thread === undefined ? undefined : this.entryOf(thread);
    const turn = this.shownTurn();
    const decorated = new Map<string, Change>();
    for (const entry of this.entries.values()) {
      const shows =
        thread === undefined
          ? entry.shown !== undefined || hasSync(entry.sync)
          : entry === narrowed;
      if (!shows) {
        entry.registered?.repository.dispose();
        entry.registered = undefined;
        continue;
      }
      entry.registered ??= this.register(entry);
      const registered = entry.registered;
      const entryTurn = entry === narrowed ? turn : undefined;
      if (entryTurn === undefined)
        for (const change of entry.shown?.changes ?? [])
          decorated.set(decorationKey(fileUri(change)), change);
      this.syncActions(entry, entryTurn !== undefined);
      const { provider } = registered;
      if (provider.rendered?.version === entry.version && provider.rendered.turn === entryTurn)
        continue;
      provider.rendered = { version: entry.version, turn: entryTurn };
      const open = (change: Change, preserveFocus: boolean) => this.open(change, preserveFocus);
      const turnGroup = provider.group(TURN_GROUP);
      turnGroup.set(
        (entryTurn?.changes ?? []).map((change) => new ChangeResource(turnGroup, change, open)),
      );
      for (const { id, kind } of GROUPS) {
        const group = provider.group(id);
        const changes =
          entryTurn === undefined && entry.shown?.kind === kind ? entry.shown.changes : [];
        group.set(changes.map((change) => new ChangeResource(group, change, open)));
      }
      provider.changed(entryTurn?.changes.length ?? entry.shown?.changes.length ?? 0);
    }
    const previous = this.decorated;
    this.decorated = decorated;
    if (!sameKeys(previous, decorated)) {
      this.decorationsChanged.fire([...previous.values(), ...decorated.values()].map(fileUri));
    }
    setChangesCard(
      thread === undefined
        ? undefined
        : {
            project: threadProjectIcon(thread),
            group: groupLabel(narrowed?.shown?.kind),
            turn: turn?.turnCount ?? null,
            threadTitle: thread.title,
            branch: thread.branch,
          },
    );
    this.services.filteredKey.set(thread !== undefined);
  }

  /** A checkout's source control, its message box holding what the user last typed in it. */
  private register(entry: Entry): NonNullable<Entry["registered"]> {
    const { scm, scmView, models, extUri } = this.services;
    const { checkout } = entry;
    // The view's input widget takes the model; the input's value is what it holds.
    const input = models.createModel(
      "",
      null,
      URI.from({ scheme: "pult-scm-input", path: `/${++inputs}` }),
    );
    const environment = threadStore.distinguishing(checkout.environmentId);
    const name =
      environment === undefined
        ? checkoutName(checkout)
        : `${checkoutName(checkout)} (${environment})`;
    const provider = new ChangesProvider(
      checkout,
      pultUri(checkout.environmentId, checkout.root),
      name,
      input,
      extUri,
    );
    const repository = scm.registerSCMProvider(provider);
    // The view decides which checkouts show; the workbench, while repositories still arrive after a reload, hides one it
    // knew but did not show last time, from Source Control and from the badge.
    scmView.toggleVisibility(repository, true);
    // The input starts from its history's latest entry, which holds the text a reload left in the box: the checkout's first
    // showing takes it, a later one the text the box held when the view last showed the checkout.
    if (entry.message === null) entry.message = repository.input.value;
    else repository.input.setValue(entry.message, true);
    repository.input.onDidChange(({ value }) => {
      if (entry.registered?.repository === repository) entry.message = value;
    });
    return { repository, provider };
  }

  /** The thread a commit of the checkout names, for the server's project settings: the filter's, when on it, else the first on it. */
  private threadOn(entry: Entry): ShellThread | undefined {
    const filtered = this.filterThread();
    if (filtered !== undefined && this.entryOf(filtered) === entry) return filtered;
    return threadStore.get().threads.find((thread) => this.entryOf(thread) === entry);
  }

  /**
   * The checkout's message box and its action button: hidden under a turn,
   * which is history, else the box with its branch in the placeholder, and
   * the button (`syncAction`): Commit, with Commit & Push beside it, while the
   * working tree has changes, else Sync with its counts, else Publish Branch,
   * else Commit disabled; while an action runs, its step.
   */
  private syncActions(entry: Entry, turnShown: boolean): void {
    const registered = entry.registered;
    if (registered === undefined) return;
    const { repository, provider } = registered;
    if (repository.input.visible === turnShown) repository.input.visible = !turnShown;
    const branch = this.branchOf(entry);
    const placeholder = commitPlaceholder(branch);
    if (repository.input.placeholder !== placeholder) repository.input.placeholder = placeholder;
    const button = turnShown ? undefined : this.actionButton(entry, branch);
    if (JSON.stringify(button) !== JSON.stringify(provider.actionButton.get()))
      provider.actionButton.set(button, undefined);
  }

  /** The checkout's branch: its status's, else a worktree's own, else the filter's thread's on it, which a project's root does not record. */
  private branchOf(entry: Entry): string | null {
    if (entry.sync?.branch != null) return entry.sync.branch;
    const filtered = this.filterThread();
    return (
      entry.checkout.worktree?.branch ??
      (filtered !== undefined && this.entryOf(filtered) === entry ? filtered.branch : null)
    );
  }

  private actionButton(entry: Entry, branch: string | null): ISCMActionButtonDescriptor {
    const on = branch === null ? "" : ` on "${branch}"`;
    const running = entry.running;
    if (running !== undefined) {
      return {
        command: {
          id: COMMIT_COMMAND,
          title: `$(loading~spin) ${running.label}`,
          tooltip: running.label,
          arguments: [entry.key],
        },
        enabled: false,
      };
    }
    const action = syncAction(entry.shown?.kind === "working-tree", entry.sync);
    switch (action.kind) {
      case "commit":
        return {
          command: {
            id: COMMIT_COMMAND,
            title: "$(check) Commit",
            tooltip: `Commit All Changes${on}, untracked files included; with no message, the server writes one`,
            arguments: [entry.key],
          },
          ...(action.enabled
            ? {
                secondaryCommands: [
                  [{ id: COMMIT_PUSH_COMMAND, title: "Commit & Push", arguments: [entry.key] }],
                ],
              }
            : {}),
          enabled: action.enabled,
        };
      case "sync":
        return {
          command: {
            id: SYNC_COMMAND,
            title: syncTitle("sync", action.ahead, action.behind),
            tooltip: `${syncTooltip(action.ahead, action.behind)}${on}`,
            arguments: [entry.key],
          },
          enabled: true,
        };
      case "diverged":
        return {
          command: {
            id: SYNC_COMMAND,
            title: syncTitle("diverged", action.ahead, action.behind),
            tooltip: `"${branch ?? "HEAD"}" has diverged from its upstream, which a fast-forward pull refuses; merge or rebase it in a terminal`,
            arguments: [entry.key],
          },
          enabled: false,
        };
      case "publish":
        return {
          command: {
            id: PUSH_COMMAND,
            title: "$(cloud-upload) Publish Branch",
            tooltip: `Push "${branch}" and set its upstream`,
            arguments: [entry.key],
          },
          enabled: true,
        };
    }
  }

  /** Runs `action` on the checkout, its step on the button and the view's progress bar, reading it again after, since a hook may have changed its files. */
  private async runAction(
    entry: Entry,
    label: string,
    action: (progressed: (next: CommitProgress) => void) => Promise<void>,
  ): Promise<void> {
    if (entry.running !== undefined) return;
    const progressed = (next: CommitProgress) => {
      entry.running = next;
      this.syncActions(entry, entry.registered?.provider.rendered?.turn !== undefined);
    };
    progressed(actionStarted(label));
    try {
      await this.services.progress.withProgress({ location: ProgressLocation.Scm }, () =>
        action(progressed),
      );
    } finally {
      entry.running = undefined;
      this.syncActions(entry, entry.registered?.provider.rendered?.turn !== undefined);
    }
    if (this.entries.get(entry.key) === entry) await this.refresh(entry, true, true);
  }

  /**
   * Commits every change of the checkout's working tree, untracked files
   * included, with the message box's text, or with none a message the
   * server writes, and with `push` pushes it after; the box cleared on a
   * commit, kept on a failure, which a notification tells with the
   * server's message.
   */
  async commit(entry: Entry, push = false): Promise<void> {
    const name = this.nameOf(entry);
    const message = (entry.message ?? "").trim();
    await this.runAction(entry, COMMIT_STARTED.label, async (progressed) => {
      const { notifications } = this.services;
      try {
        const latest = await this.stacked(
          entry,
          push ? "commit_push" : "commit",
          message,
          progressed,
        );
        const result = latest.result;
        if (result?.commit.status === "skipped_no_changes") {
          notifications.info(`Pult: nothing to commit in ${name}.`);
        } else if (result?.commit.status === "created") {
          entry.message = "";
          // Not transient, so the message joins the box's history.
          entry.registered?.repository.input.setValue("", false);
          if (message === "" || push) notifications.info(`Pult: ${toast(result)}`);
        }
      } catch (error) {
        notifications.error(
          `Pult could not ${push ? "commit and push" : "commit"} in ${name}. ${error instanceof ActionFailed ? error.message : String(error)}`,
        );
      }
    });
  }

  /** Pushes the checkout's branch, publishing it with an upstream when it has none. */
  async push(entry: Entry): Promise<void> {
    const name = this.nameOf(entry);
    await this.runAction(entry, "Pushing…", async (progressed) => {
      try {
        const latest = await this.stacked(entry, "push", "", progressed);
        if (latest.result !== null)
          this.services.notifications.info(`Pult: ${toast(latest.result)}`);
      } catch (error) {
        this.services.notifications.error(
          `Pult could not push ${name}. ${error instanceof ActionFailed ? error.message : String(error)}`,
        );
      }
    });
  }

  /** Fast-forwards the checkout's branch from its upstream; a diverged branch fails, told as such. */
  async pull(entry: Entry): Promise<void> {
    await this.runAction(entry, "Pulling…", async () => {
      await this.pullStep(entry);
    });
  }

  /** Pulls while behind, then pushes while ahead, stopping at the first failure. */
  async sync(entry: Entry): Promise<void> {
    const state = entry.sync;
    if (state === undefined) return;
    const name = this.nameOf(entry);
    await this.runAction(entry, "Syncing…", async (progressed) => {
      for (const step of syncSteps(state)) {
        if (step === "pull") {
          progressed(actionStarted("Pulling…"));
          if (!(await this.pullStep(entry))) return;
        } else {
          progressed(actionStarted("Pushing…"));
          try {
            await this.stacked(entry, "push", "", progressed);
          } catch (error) {
            this.services.notifications.error(
              `Pult could not push ${name}. ${error instanceof ActionFailed ? error.message : String(error)}`,
            );
            return;
          }
        }
      }
      this.services.notifications.info(`Pult: synced ${name}.`);
    });
  }

  /** One pull, its failure notified; whether it went through. */
  private async pullStep(entry: Entry): Promise<boolean> {
    const name = this.nameOf(entry);
    try {
      const result = await changesServer(entry.checkout.environmentId).pull(entry.checkout.root);
      this.stepped(entry, "pull");
      if (result.status === "skipped_up_to_date")
        this.services.notifications.info(`Pult: ${name} is up to date.`);
      return true;
    } catch (error) {
      console.error("[pult-shell] the pull failed", error);
      this.services.notifications.error(
        `Pult could not pull ${name}. ${pullFailure(entry.sync, errorDetail(error))}`,
      );
      return false;
    }
  }

  /** The server's stacked action on the checkout, its progress through `progressed`; fails with `ActionFailed`, the server's message and a hook's last line. */
  private async stacked(
    entry: Entry,
    action: "commit" | "commit_push" | "push",
    message: string,
    progressed: (next: CommitProgress) => void,
  ): Promise<CommitProgress> {
    const { environmentId, root, projectId } = entry.checkout;
    const thread = this.threadOn(entry);
    let latest = entry.running ?? COMMIT_STARTED;
    try {
      await changesServer(environmentId).runStackedAction(
        {
          actionId: globalThis.crypto.randomUUID(),
          cwd: root,
          action,
          ...(message === "" ? {} : { commitMessage: message }),
          ...(thread === undefined ? {} : { threadId: ThreadId.make(thread.id) }),
          projectId: ProjectId.make(projectId),
        },
        (event) => {
          latest = commitProgress(latest, event);
          progressed(latest);
        },
      );
      if (latest.result?.commit.status === "created") this.stepped(entry, "commit");
      if (latest.result?.push.status === "pushed") this.stepped(entry, "push");
      return latest;
    } catch (error) {
      console.error(`[pult-shell] the ${action} failed`, error);
      throw new ActionFailed(commitFailure(latest, error));
    }
  }

  /**
   * The button as a step left the checkout, at once: its counts, and after a
   * commit, which takes the whole working tree, no uncommitted changes; the
   * reads after the action confirm them, and a status read already under way
   * is dropped.
   */
  private stepped(entry: Entry, step: "commit" | "push" | "pull"): void {
    entry.sync = afterStep(entry.sync, step);
    entry.syncGeneration += 1;
    if (step === "commit" && entry.shown?.kind === "working-tree") {
      entry.shown = undefined;
      entry.version += 1;
    }
    this.render();
  }

  private nameOf(entry: Entry): string {
    return entry.registered?.provider.name ?? checkoutName(entry.checkout);
  }

  /**
   * An action's command: the checkout its key names, else the filter's,
   * else one of the checkouts `applies` to, picked while several.
   */
  async command(kind: ActionKind, key: string | null): Promise<void> {
    const { run, applies, placeHolder, none } = this.actions[kind];
    if (key !== null) {
      const entry = this.entries.get(key);
      if (entry !== undefined) await run(entry);
      return;
    }
    const thread = this.filterThread();
    const narrowed = thread === undefined ? undefined : this.entryOf(thread);
    const candidates =
      narrowed !== undefined ? [narrowed] : [...this.entries.values()].filter(applies);
    if (candidates.length === 0) {
      this.services.notifications.info(`Pult: ${none}`);
      return;
    }
    if (candidates.length === 1) return run(candidates[0]!);
    const picked = await this.services.quickInput.pick(
      candidates.map((entry) => ({
        label: this.nameOf(entry),
        description: entry.checkout.root,
        detail:
          kind === "commit" || kind === "commitAndPush"
            ? (entry.message ?? "").trim().split("\n")[0] || "No message: the server writes one"
            : syncDetail(entry.sync),
        entry,
      })),
      { placeHolder },
    );
    if (picked !== undefined) await run(picked.entry);
  }

  private readonly actions: Record<
    ActionKind,
    {
      run: (entry: Entry) => Promise<void>;
      applies: (entry: Entry) => boolean;
      placeHolder: string;
      none: string;
    }
  > = {
    commit: {
      run: (entry) => this.commit(entry),
      applies: (entry) => entry.registered !== undefined && entry.shown?.kind === "working-tree",
      placeHolder: "Commit all changes of",
      none: "no checkout the changes view shows has uncommitted changes.",
    },
    commitAndPush: {
      run: (entry) => this.commit(entry, true),
      applies: (entry) => entry.registered !== undefined && entry.shown?.kind === "working-tree",
      placeHolder: "Commit and push all changes of",
      none: "no checkout the changes view shows has uncommitted changes.",
    },
    sync: {
      run: (entry) => this.sync(entry),
      applies: (entry) => hasSync(entry.sync),
      placeHolder: "Sync",
      none: "no checkout has commits to pull or push.",
    },
    pull: {
      run: (entry) => this.pull(entry),
      applies: (entry) =>
        entry.sync !== undefined && entry.sync.hasUpstream && entry.sync.behind > 0,
      placeHolder: "Pull",
      none: "no checkout is behind its upstream.",
    },
    push: {
      run: (entry) => this.push(entry),
      applies: (entry) =>
        entry.sync !== undefined &&
        entry.sync.branch !== null &&
        (!entry.sync.hasUpstream ? entry.shown !== undefined : entry.sync.ahead > 0),
      placeHolder: "Push",
      none: "no checkout has commits to push.",
    },
  };

  /**
   * The Source Control view narrowed to `thread`, selected first if another
   * is, or to the selected thread; with `turn` its turn's files, else its
   * checkout's; and the change of `path` open when the view has it, the
   * turn's first.
   */
  async show(
    thread: ThreadSelection | null,
    path: string | null,
    turn: TurnCheckpoints | null,
  ): Promise<void> {
    const target = thread ?? this.selection;
    this.filtered = true;
    if (target !== null) {
      this.forgetTurn(target);
      const checkoutRoot =
        threadStore.thread(target.environmentId, target.threadId)?.checkoutRoot ?? null;
      if (turn !== null && checkoutRoot !== null)
        this.rememberTurn(target, loadTurn(target, checkoutRoot, turn));
    }
    const selected = selectedThread();
    if (
      thread !== null &&
      (thread.threadId !== selected?.threadId || thread.environmentId !== selected.environmentId)
    ) {
      await selectThread(thread.environmentId, thread.threadId);
    }
    await this.reveal();
    if (path === null || target === null) return;
    const turnChange = (await this.turns.get(turnKey(target)))?.changes.find(
      (change) => change.path === path,
    );
    if (turnChange !== undefined) return this.open(turnChange, false);
    const entry = this.entryOf(threadStore.thread(target.environmentId, target.threadId));
    await entry?.loading;
    const change = entry?.shown?.changes.find((candidate) => candidate.path === path);
    if (change !== undefined) await this.open(change, false);
  }

  /** Every checkout's changes, the filter and the turns dropped: the card's clear mark, and the left panel's tab. */
  async showAll(): Promise<void> {
    this.filtered = false;
    this.turns.clear();
    this.loadedTurns.clear();
    await this.reveal();
  }

  /** Source Control shown as the view now stands, read again if it showed already; showing it reads it otherwise. */
  private async reveal(): Promise<void> {
    const shown = this.visible;
    this.render();
    await this.services.commands.executeCommand("workbench.view.scm");
    if (shown) this.refreshScope(false);
  }

  private rememberTurn(selection: ThreadSelection, loading: Promise<Turn>): void {
    const key = turnKey(selection);
    this.turns.set(key, loading);
    void loading.then((turn) => {
      if (this.turns.get(key) !== loading) return;
      this.loadedTurns.set(key, turn);
      this.render();
    });
  }

  private forgetTurn(selection: ThreadSelection): void {
    this.turns.delete(turnKey(selection));
    this.loadedTurns.delete(turnKey(selection));
  }

  /** VS Code's diff editor on the change's two sides. */
  async open(change: Change, preserveFocus: boolean): Promise<void> {
    const { original, modified } = sides(change);
    const group =
      change.sourceKind === "turn"
        ? `Turn ${this.shownTurn()?.turnCount ?? ""}`.trim()
        : groupLabel(change.sourceKind);
    await this.services.editors.openEditor({
      original: { resource: original },
      modified: { resource: modified },
      label: `${change.path.split("/").at(-1)} (${group})`,
      options: { pinned: false, preserveFocus },
    });
  }

  private async sideContents(uri: URI): Promise<string> {
    const { change, side } = JSON.parse(uri.query) as Side;
    const key = JSON.stringify([
      uri.authority,
      change.cwd,
      change.sourceKind,
      change.baseRef,
      change.headRef,
      change.previousPath,
      change.path,
    ]);
    let loading = this.contents.get(key);
    if (loading === undefined && change.sourceKind === "turn") {
      loading = turnContents(uri.authority, change);
      this.contents.set(key, loading);
    }
    if (loading === undefined) {
      const sourceKind = change.sourceKind === "turn" ? "working-tree" : change.sourceKind;
      loading = changesServer(uri.authority).diffFileContents({
        cwd: change.cwd,
        sourceKind,
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
    const change = this.decorated.get(decorationKey(uri));
    if (change === undefined) return undefined;
    const { badge, color, label } = BADGES[change.changeType];
    return { letter: badge, color, tooltip: label, bubble: true };
  }

  /** What the view shows and why, for the console. */
  state() {
    const thread = this.filterThread();
    return {
      filtered: this.filtered,
      filter:
        thread === undefined
          ? null
          : { environmentId: thread.environmentId, threadId: thread.id, root: thread.checkoutRoot },
      turn: this.shownTurn()?.turnCount ?? null,
      visible: this.visible,
      checkouts: [...this.entries.values()].map((entry) => ({
        environmentId: entry.checkout.environmentId,
        root: entry.checkout.root,
        name: checkoutName(entry.checkout),
        shown: entry.registered !== undefined,
        source: entry.shown?.kind ?? null,
        files: entry.shown?.changes.length ?? 0,
        loading: entry.loading !== undefined,
        failure: entry.failure,
        running: entry.running?.label ?? null,
        sync: entry.sync ?? null,
      })),
    };
  }
}

function sameKeys(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): boolean {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

type ActionKind = "commit" | "commitAndPush" | "sync" | "pull" | "push";

/** A stacked action's failure, its message already the user's. */
class ActionFailed extends Error {}

/** The server's toast on a stacked action, title and description in one line. */
function toast(result: NonNullable<CommitProgress["result"]>): string {
  return [result.toast.title, result.toast.description].filter(Boolean).join(": ");
}

/** What a failed RPC says: the server's detail when it has one, else its message. */
function errorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string") return error.detail;
    if ("message" in error) return String(error.message);
  }
  return String(error);
}

/** A pick's line for a checkout's sync: its branch and counts. */
function syncDetail(state: SyncState | undefined): string {
  if (state === undefined) return "";
  if (!state.hasUpstream) return `${state.branch ?? "HEAD"}: no upstream`;
  return `${state.branch ?? "HEAD"}: ${state.behind} behind, ${state.ahead} ahead`;
}

let running = 0;
const waiting: Array<() => void> = [];

/** `task` once fewer than `REFRESH_CONCURRENCY` others run: every checkout's diff is one call. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running < REFRESH_CONCURRENCY) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    // The slot passes to the next waiting task, if any.
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }
}

/** A turn the changes view shows for a thread: its number, the checkout it was read under, and its files. */
interface Turn {
  readonly turnCount: number;
  readonly root: string;
  readonly changes: ReadonlyArray<Change>;
}

function turnKey(selection: ThreadSelection): string {
  return `${selection.environmentId}\n${selection.threadId}`;
}

/**
 * A turn's files as changes: the card's files with their counts, with how
 * each changed from the server's patch of the turn (upstream's turn diff,
 * whitespace kept, as the card counts it); a file the patch misses, or every
 * file when the patch fails, counts as modified.
 */
async function loadTurn(
  selection: ThreadSelection,
  root: string,
  turn: TurnCheckpoints,
): Promise<Turn> {
  const patch = await changesServer(selection.environmentId)
    .turnDiff({
      threadId: ThreadId.make(selection.threadId),
      fromTurnCount: turn.turnCount - 1,
      toTurnCount: turn.turnCount,
      ignoreWhitespace: false,
    })
    .then(
      (result) => result.diff,
      () => "",
    );
  const parsed = new Map(patchFiles(patch).map((file) => [file.path, file]));
  const changes = turn.files.map((stat): Change => {
    const file = parsed.get(stat.path);
    return {
      environmentId: selection.environmentId,
      cwd: root,
      sourceKind: "turn",
      baseRef: turn.fromRef,
      headRef: turn.toRef,
      path: stat.path,
      previousPath: file?.previousPath ?? null,
      changeType: file?.changeType ?? "change",
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
  return { turnCount: turn.turnCount, root, changes };
}

/**
 * A turn's change's two sides, each its file in one of the turn's
 * checkpoints, which are commits under refs of the repository: the server's
 * file contents RPC reads a working-tree change's old side at its base ref,
 * and a deletion's new side not at all, so a deletion based on a checkpoint
 * reads that checkpoint's file alone.
 */
async function turnContents(
  environmentId: string,
  change: Change,
): Promise<{ readonly oldContents: string; readonly newContents: string }> {
  const read = async (ref: string | null, path: string) => {
    if (ref === null) return "";
    const contents = await changesServer(environmentId).diffFileContents({
      cwd: change.cwd,
      sourceKind: "working-tree",
      changeType: "deleted",
      baseRef: ref,
      headRef: null,
      oldPath: path,
      newPath: path,
    });
    return contents.oldContents;
  };
  const [oldContents, newContents] = await Promise.all([
    change.changeType === "new" ? "" : read(change.baseRef, change.previousPath ?? change.path),
    change.changeType === "deleted" ? "" : read(change.headRef, change.path),
  ]);
  return { oldContents, newContents };
}

function joinPath(root: string, relativePath: string): string {
  if (relativePath === "") return root;
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

let started: Promise<ChangesView> | undefined;

/**
 * Opens the Source Control view narrowed to `thread`, selecting it first if
 * another is selected (the selected thread's when null), with `turn` as its
 * turn's group when given, and the change of `path`, relative to the
 * thread's checkout, open when the view lists it: the thread's bar's Source
 * Control, the thread view's "Open diff" and the changed files card's files.
 */
export async function showChanges(
  thread: ThreadSelection | null,
  path: string | null,
  turn: TurnCheckpoints | null = null,
): Promise<void> {
  await (await started)?.show(thread, path, turn);
}

/** What the changes view shows and why, for the console's `pult.changes()`. */
export async function changesState() {
  return (await started)?.state();
}

/**
 * The changes view, started once the workbench's services are up, with
 * `pult-shell.showChanges <environmentId|null> <threadId|null> <path|null> [turn]`,
 * "Pult: Show Thread Changes" (`pult-shell.showThreadChanges`, the selected
 * thread's), "Pult: Show All Changes" (`pult-shell.showAllChanges`, also the
 * card's clear mark and the left panel's Source Control tab), "Pult: Refresh
 * Changes" (`pult-shell.refreshChanges`, also in the Source Control view's
 * title), "Pult: Commit" (`pult-shell.commit [checkoutKey]`, also each
 * checkout's Commit button and Cmd+Enter in its message box), "Pult: Commit
 * & Push", "Pult: Sync", "Pult: Pull" and "Pult: Push"
 * (`pult-shell.commitAndPush`, `.sync`, `.pull`, `.push`, each with an
 * optional checkout key, also the checkout's button and its secondary
 * command) and the card.
 */
export function registerChanges(): void {
  started = ChangesView.start();
  void mountChangesCard();
  started.catch((error: unknown) =>
    console.error("[pult-shell] the changes view did not start", error),
  );
  CommandsRegistry.registerCommand(
    "pult-shell.showChanges",
    (_accessor, environmentId: unknown, threadId: unknown, path: unknown, turn: unknown) =>
      showChanges(
        typeof environmentId === "string" && typeof threadId === "string"
          ? { environmentId, threadId }
          : null,
        typeof path === "string" ? path : null,
        isTurnCheckpoints(turn) ? turn : null,
      ),
  );
  // In place of "No source control providers registered.": a checkout without changes has none.
  Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
    "workbench.scm",
    {
      content: "No changes.",
      when: ContextKeyExpr.equals("scm.providerCount", 0),
    },
  );
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.showThreadChanges",
          title: { value: "Show Thread Changes", original: "Show Thread Changes" },
          category,
          f1: true,
          precondition: ChangesFilteredContext.toNegated(),
        });
      }

      async run(): Promise<void> {
        await showChanges(null, null);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.showAllChanges",
          title: { value: "Show All Changes", original: "Show All Changes" },
          category,
          f1: true,
        });
      }

      async run(): Promise<void> {
        await (await started)?.showAll();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: COMMIT_COMMAND,
          title: { value: "Commit", original: "Commit" },
          category,
          f1: true,
        });
      }

      async run(_accessor: unknown, key: unknown): Promise<void> {
        await (await started)?.command("commit", typeof key === "string" ? key : null);
      }
    },
  );
  for (const [id, kind, title] of [
    [COMMIT_PUSH_COMMAND, "commitAndPush", "Commit & Push"],
    [SYNC_COMMAND, "sync", "Sync"],
    [PULL_COMMAND, "pull", "Pull"],
    [PUSH_COMMAND, "push", "Push"],
  ] as const) {
    registerAction2(
      class extends Action2 {
        constructor() {
          super({ id, title: { value: title, original: title }, category, f1: true });
        }

        async run(_accessor: unknown, key: unknown): Promise<void> {
          await (await started)?.command(kind, typeof key === "string" ? key : null);
        }
      },
    );
  }
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.refreshChanges",
          title: { value: "Refresh Changes", original: "Refresh Changes" },
          category,
          icon: Codicon.refresh,
          f1: true,
          // Every checkout's title, which names a provider only while it shows one.
          menu: [{ id: MenuId.SCMTitle, group: "navigation" }],
        });
      }

      async run(): Promise<void> {
        (await started)?.refreshScope(true);
      }
    },
  );
}

function isTurnCheckpoints(value: unknown): value is TurnCheckpoints {
  if (typeof value !== "object" || value === null) return false;
  const { turnCount, fromRef, toRef, files } = value as Partial<
    Record<keyof TurnCheckpoints, unknown>
  >;
  return (
    typeof turnCount === "number" &&
    typeof fromRef === "string" &&
    typeof toRef === "string" &&
    Array.isArray(files)
  );
}
