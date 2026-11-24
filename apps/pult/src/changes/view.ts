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
import { autorun } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/reactions/autorun";
import { transaction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/transaction";
import type { IExtUri } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import type { Command } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/languages";
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
  ISCMHistoryItem,
  ISCMHistoryItemChange,
  ISCMHistoryItemRef,
  ISCMHistoryItemRefsChangeEvent,
  ISCMHistoryOptions,
  ISCMHistoryProvider,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/history";
import type {
  ISCMActionButtonDescriptor,
  ISCMProvider,
  ISCMRepository,
  ISCMResource,
  ISCMResourceDecorations,
  ISCMResourceGroup,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm";
import { DEFAULT_EDITOR_ASSOCIATION } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import { HISTORY_VIEW_PANE_ID } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm";
import {
  ProjectId,
  REVIEW_LOG_MAX_LIMIT,
  ThreadId,
  type ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

import type { TurnCheckpoints } from "../../view/main.tsx";

import { pultUri } from "../panel/explorer.ts";
import {
  holdsThread,
  onDidSelectThread,
  selectionTarget,
  selectThread,
  type ThreadSelection,
} from "../threads/selection.ts";
import { threadProjectIcon } from "../threads/projectIcon.ts";
import { isHiddenProject } from "../stars/hidden.ts";
import { scopedKey, type ShellThread, threadStore } from "../threads/store.ts";
import { setChangesCard, mountChangesCard } from "./card.tsx";
import {
  type Change,
  type Checkout,
  checkoutKey,
  checkoutName,
  checkoutsOf,
  shownChanges,
  withoutConflicts,
} from "./checkouts.ts";
import {
  actionStarted,
  COMMIT_STARTED,
  commitFailure,
  commitPlaceholder,
  type CommitProgress,
  commitProgress,
} from "./commit.ts";
import { keptAt, onDidChangeKept, rereadKept, startKept } from "./kept.ts";
import { historyItem, type HistoryRefs, historyRefs, refsChange } from "./history.ts";
import { type ChangeType, patchFiles } from "./patch.ts";
import { setRepository } from "./repositories.ts";
import { changesServer } from "./server.ts";
import {
  afterStep,
  failedRead,
  hasSync,
  pullFailure,
  SYNC_INTERVAL_MS,
  syncAction,
  syncState,
  keptStateLine,
  type SyncState,
  syncSteps,
  syncTitle,
  syncTooltip,
  XAXIS_PLACEHOLDER,
  type XaxisState,
  type XaxisStateItem,
  xaxisStateLine,
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
/** Opens the first file of an xaxis checkout's conflict that holds markers, else shows the Conflicts group: its state line's click. */
const OPEN_CONFLICT_COMMAND = "pult-shell.openConflict";
/** An xaxis conflict's row's `contextValue` while its server serves `vcs.resolveConflict`, for Keep mine and Take latest. */
const RESOLVABLE_CONFLICT = "pult-xaxis-conflict";

/** While the view shows one thread's checkout, under its card: for `when` clauses. */
const ChangesFilteredContext = new RawContextKey<boolean>("pult.changesFiltered", false);

/** The content provider's query: a change, or a file of a commit the Graph lists, and which of its sides. */
type Side =
  | { readonly change: Change; readonly side: "old" | "new" }
  | { readonly commit: CommitFile; readonly side: "old" | "new" };

/** A file a commit changed, as the Graph lists it, from the server's metadata alone: how it changed is read from its own patch when a side is shown. */
interface CommitFile {
  readonly environmentId: string;
  readonly cwd: string;
  /** The repository's root, which `path` is relative to. */
  readonly repositoryRoot: string;
  readonly sha: string;
  /** The commit's first parent, or the empty tree for a root commit, as the server diffs it. */
  readonly parent: string;
  readonly path: string;
  readonly previousPath: string | null;
}

/** A Graph page's size when it asks for none, the git extension's. */
const HISTORY_PAGE = 50;

/** The group of a turn the thread view named, alone in the view while the filter's thread has one. */
const TURN_GROUP = "turn";
/** An xaxis checkout's conflicted paths, above its changes, which leave them out. */
const CONFLICTS_GROUP = "conflicts";

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
  return pultUri(change.environmentId, joinPath(change.repositoryRoot, change.path));
}

/** A `pult:` file's key among the decorated, the authority in any case; a Graph row's file at a commit, its `ref=` query, is not the live file. */
function decorationKey(uri: URI): string {
  return `${uri.authority.toLowerCase()}\n${uri.path}\n${uri.query}`;
}

function sideUri(change: Change, side: Side["side"]): URI {
  const path = side === "old" ? (change.previousPath ?? change.path) : change.path;
  return pultUri(change.environmentId, joinPath(change.repositoryRoot, path)).with({
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

function commitSideUri(file: CommitFile, side: Side["side"]): URI {
  const path = side === "old" ? (file.previousPath ?? file.path) : file.path;
  return pultUri(file.environmentId, joinPath(file.repositoryRoot, path)).with({
    scheme: DIFF_SCHEME,
    query: JSON.stringify({ commit: file, side } satisfies Side),
  });
}

/**
 * A checkout's history for VS Code's Graph, on a server with the fork's log
 * (`review.getLog`, `review.getRefs`), after the git extension's: its branch,
 * upstream and base, which the Graph's default filter walks, every ref for
 * the others, read again whenever the checkout's changes are while the Graph
 * shows it (`GraphFocus`); a commit's files from upstream's commit preview,
 * each a diff of `pult-diff:` sides. No incoming or outgoing changes nodes,
 * which need a merge base.
 */
class CheckoutHistory implements ISCMHistoryProvider {
  readonly historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
  readonly historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
  readonly historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
  readonly historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, {
    added: [],
    removed: [],
    modified: [],
    silent: true,
  });
  private refs: HistoryRefs | undefined;
  private generation = 0;
  /** The base of the last `refresh`, and whether its read was skipped while the Graph showed another checkout or none. */
  private baseRef: string | null = null;
  private skipped = true;

  constructor(
    private readonly checkout: Checkout,
    private readonly graph: GraphFocus,
  ) {}

  private get server() {
    return changesServer(this.checkout.environmentId);
  }

  /**
   * Reads the refs again, `baseRef` the base the server diffs the branch
   * against, while the Graph shows the checkout, else on its next showing;
   * the Graph refreshes as they moved. The newest read wins.
   */
  async refresh(baseRef: string | null): Promise<void> {
    this.baseRef = baseRef;
    this.skipped = !this.graph.shows(this);
    if (this.skipped) return;
    const generation = ++this.generation;
    let refs: HistoryRefs;
    try {
      refs = historyRefs(await this.server.refs(this.checkout.root), baseRef);
    } catch (error) {
      // Not a repository, a worktree gone: the Graph keeps what it showed.
      console.warn("[pult-shell] could not read a checkout's refs", error);
      return;
    }
    if (generation !== this.generation) return;
    const change = refsChange(this.refs, refs);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const recoloured = !same(this.refs?.remote, refs.remote) || !same(this.refs?.base, refs.base);
    this.refs = refs;
    if (change === undefined && !recoloured) return;
    // One transaction, so the Graph, which reads the refs and their changes, refreshes once.
    transaction((tx) => {
      this.historyItemRemoteRef.set(refs.remote, tx);
      this.historyItemBaseRef.set(refs.base, tx);
      this.historyItemRef.set(refs.current, tx);
      this.historyItemRefChanges.set(
        change ?? { added: [], removed: [], modified: [], silent: true },
        tx,
      );
    });
  }

  /** The Graph shows the checkout: its refs are read now, when its last refresh skipped them or with `fresh`. */
  showing(fresh: boolean): Promise<void> {
    return fresh || this.skipped ? this.refresh(this.baseRef) : Promise.resolve();
  }

  /** After the read the ask starts, since the Graph drops a saved filter none of whose refs it is given. */
  async provideHistoryItemRefs(): Promise<ISCMHistoryItemRef[]> {
    await this.graph.ask(this);
    return [...(this.refs?.all ?? [])];
  }

  async provideHistoryItems(options: ISCMHistoryOptions): Promise<ISCMHistoryItem[]> {
    // The Graph asks the checkout it shows, whichever its picker names.
    void this.graph.ask(this);
    if (typeof options.limit === "object") todo("a history page that ends at a commit");
    if (options.filterText !== undefined) todo("a history filtered by text");
    const [first, ...rest] = options.historyItemRefs ?? [];
    // A checkout with no branch or commit yet has nothing to walk.
    if (first === undefined) return [];
    const page = await this.server.log({
      cwd: this.checkout.root,
      refs: [first, ...rest],
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      limit: Math.min(options.limit ?? HISTORY_PAGE, REVIEW_LOG_MAX_LIMIT),
    });
    return page.commits.map((commit) => historyItem(commit, this.refs));
  }

  /** The commit's files against its first parent, the one the Graph names, as the server diffs a commit. */
  async provideHistoryItemChanges(
    historyItemId: string,
    historyItemParentId: string | undefined,
  ): Promise<ISCMHistoryItemChange[]> {
    const { environmentId, root } = this.checkout;
    const [preview, repository] = await Promise.all([
      this.server.diffPreview({ cwd: root, commitSha: historyItemId, metadataOnly: true }),
      repositoryRoot(environmentId, root),
    ]);
    const source = preview.sources.find((candidate) => candidate.kind === "commit");
    if (source === undefined || source.baseRef === null || source.headRef === null) return [];
    if (historyItemParentId !== undefined && historyItemParentId !== source.baseRef)
      todo("a commit's changes against another than its first parent");
    const { baseRef: parent, headRef: sha } = source;
    return (source.files ?? []).map((stat) => {
      const file: CommitFile = {
        environmentId,
        cwd: root,
        repositoryRoot: repository,
        sha,
        parent,
        path: stat.path,
        previousPath: stat.previousPath,
      };
      return {
        // At the commit, as the git extension's rows are, so the badge of the live file's change does not mark it.
        uri: pultUri(environmentId, joinPath(repository, stat.path)).with({ query: `ref=${sha}` }),
        originalUri: commitSideUri(file, "old"),
        modifiedUri: commitSideUri(file, "new"),
      };
    });
  }

  async resolveHistoryItem(historyItemId: string): Promise<ISCMHistoryItem | undefined> {
    const page = await this.server.log({
      cwd: this.checkout.root,
      refs: [historyItemId],
      limit: 1,
    });
    const commit = page.commits[0];
    return commit === undefined ? undefined : historyItem(commit, this.refs);
  }

  // The page runs no chat to hand a commit to.
  resolveHistoryItemChatContext(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  resolveHistoryItemChangeRangeChatContext(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  // Without a merge base the Graph draws no incoming or outgoing changes node.
  resolveHistoryItemRefsCommonAncestor(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
}

/**
 * Which checkouts VS Code's Graph may show, while it is visible, so only
 * theirs refs are read, every branch, remote branch and tag being the
 * costly part of a refresh: the active repository's, which a fresh Graph
 * waits on and follows, else the first repository's, which it waits on
 * while none is active; and the one the Graph last asked for history, its
 * picker's, which the Graph keeps to itself.
 */
class GraphFocus {
  private active: CheckoutHistory | undefined;
  private asked: CheckoutHistory | undefined;

  constructor(
    private visible: boolean,
    private readonly first: () => CheckoutHistory | undefined,
  ) {}

  shows(history: CheckoutHistory): boolean {
    return this.visible && (history === (this.active ?? this.first()) || history === this.asked);
  }

  /** The active repository's history, read when its last refresh skipped its refs. */
  setActive(history: CheckoutHistory | undefined): void {
    this.active = history;
    if (this.visible) void history?.showing(false);
  }

  /** A checkout's history attached, read when the Graph may show it. */
  attached(history: CheckoutHistory): void {
    if (this.shows(history)) void history.showing(false);
  }

  /** The Graph asked `history` for its history or refs, read when its last refresh skipped them. */
  ask(history: CheckoutHistory): Promise<void> {
    this.asked = history;
    return this.visible ? history.showing(false) : Promise.resolve();
  }

  /** The Graph shown, the refs of the repository a fresh Graph shows read afresh, or hidden. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.asked = undefined;
    if (visible) void (this.active ?? this.first())?.showing(true);
  }
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

/** A path of an xaxis checkout's conflict: opens the live file; Keep mine and Take latest beside it while its server resolves. */
class ConflictResource implements ISCMResource {
  readonly sourceUri: URI;
  readonly decorations: ISCMResourceDecorations;
  readonly contextValue: string | undefined;
  readonly command = undefined;
  readonly multiDiffEditorOriginalUri = undefined;
  readonly multiDiffEditorModifiedUri = undefined;

  constructor(
    readonly resourceGroup: ChangesGroup,
    /** The checkout's `checkoutKey`. */
    readonly key: string,
    readonly conflict: XaxisState["conflicts"][number],
    root: URI,
    resolvable: boolean,
    private readonly opener: (uri: URI, preserveFocus: boolean) => Promise<void>,
  ) {
    this.sourceUri = URI.joinPath(root, conflict.path);
    this.contextValue = resolvable ? RESOLVABLE_CONFLICT : undefined;
    const icon = { ...Codicon.warning, color: { id: "gitDecoration.modifiedResourceForeground" } };
    this.decorations = {
      icon,
      iconDark: icon,
      tooltip: conflict.markers ? "Conflict: the file holds markers" : "Conflict: keep a side",
    };
  }

  open(preserveFocus: boolean): Promise<void> {
    return this.opener(this.sourceUri, preserveFocus);
  }
}

class ChangesGroup implements ISCMResourceGroup {
  resources: ReadonlyArray<ChangeResource | ConflictResource> = [];
  contextValue: string | undefined = undefined;
  readonly hideWhenEmpty = true;
  readonly multiDiffEditorEnableViewChanges = false;
  // The label never changes.
  readonly onDidChange = Event.None;
  private readonly resourcesChanged = new Emitter<void>();
  readonly onDidChangeResources = this.resourcesChanged.event;
  private tree: ResourceTree<ChangeResource | ConflictResource, ChangesGroup> | undefined;

  constructor(
    readonly provider: ChangesProvider,
    readonly id: string,
    readonly label: string,
    private readonly extUri: IExtUri,
  ) {}

  /** The tree view's folders, built when the view first asks. */
  get resourceTree() {
    if (this.tree === undefined) {
      this.tree = new ResourceTree<ChangeResource | ConflictResource, ChangesGroup>(
        this,
        this.provider.rootUri,
        this.extUri,
      );
      for (const resource of this.resources) this.tree.add(resource.sourceUri, resource);
    }
    return this.tree;
  }

  set(resources: ReadonlyArray<ChangeResource | ConflictResource>): void {
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

/** Whether a checkout is a thread's xaxis copy (`pult/decisions`, `xaxis-copies`): a worktree its status, read or kept, says is xaxis's. */
function isCopy(entry: Entry): boolean {
  return entry.checkout.worktree !== null && entry.sync?.xaxis != null;
}

/**
 * The source control of one checkout: its history on a server with the
 * fork's log, the turn's group and the server's two, of which one at most
 * holds files, and its commit message box with the Commit button under it,
 * Cmd+Enter in the box committing too.
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
  /** The checkout's history, set once the server tells it serves the fork's log; none on a stock server. */
  readonly historyProvider = observableValue<CheckoutHistory | undefined>(this, undefined);
  /** The Commit button, set by the view as the checkout's changes and its commit go. */
  readonly actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
  /** An xaxis checkout's state line (`xaxisStateLine`); none for git's. */
  readonly statusBarCommands = observableValue<ReadonlyArray<Command> | undefined>(this, undefined);
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
      new ChangesGroup(this, CONFLICTS_GROUP, "Conflicts", extUri),
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
  /** The base the server diffs its branch against (`main`, `origin/main`), after the last refresh, which its history colours; null with none. */
  baseRef: string | null;
  /** Bumped on every answer, for the provider's `rendered`. */
  version: number;
  failure: string | null;
  /** The refresh in flight; a newer one's answer wins. */
  loading: Promise<void> | undefined;
  generation: number;
  registered:
    | {
        readonly repository: ISCMRepository;
        readonly provider: ChangesProvider;
        /** Whether it was named as an xaxis copy, by its folder (`checkoutName`). */
        readonly copy: boolean;
      }
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
  /** An xaxis checkout's root, its conflict's paths' base, from its status; undefined for git's or before a read. */
  xaxisRoot: string | undefined;
  /** Whether its server serves `vcs.resolveConflict`, asked once its status first says xaxis. */
  resolvable: boolean | undefined;
  /** After a Commit & Land that failed: the next status read opens its conflict. */
  revealConflict: boolean;
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
 * one (`pult-shell.showChanges`), the named thread's checkout, changes or
 * none, under its card (`card.tsx`), the filter following the selection (a
 * Star's its current conversation) and letting the view show everything
 * while the selection has no thread; while the
 * thread has one, a turn instead, its files alone under Changed Files: the
 * turn the thread view's changed files card last opened for the thread,
 * both sides of each file from the turn's checkpoints. It reads every
 * checkout, shown or not, so Source Control's badge counts them all: each
 * as the store brings it, when a thread on it finishes a run or a file
 * under it changes, and all when the window regains focus; what it shows on
 * showing and on "Pult: Refresh Changes". The badge is VS Code's, the sum
 * of the shown source controls' counts, so a filter's alone while one
 * narrows, each count its checkout's uncommitted changes alone, a branch's
 * committed ones listed but not counted, as the git extension counts. Each
 * checkout shown has a message box and a Commit button, which commit its
 * whole working tree through the server (`commit`), but under a turn.
 */
class ChangesView {
  private readonly entries = new Map<string, Entry>();
  /** Whether the view is narrowed to the selected thread, while one is. */
  private filtered = false;
  /** The thread the filter follows: the selection's, a Star's its current conversation, or the one `show` last named, until the selection changes. */
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
  /** The checkouts whose refs the Graph's refreshes read. */
  private readonly graph: GraphFocus;
  /** The checkouts a file changed under, read again together once the burst settles. */
  private readonly stale = new Set<Entry>();
  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly services: Services,
    private readonly views: IViewsService,
  ) {
    this.visible = views.isViewContainerVisible(SCM_CONTAINER);
    this.graph = new GraphFocus(views.isViewVisible(HISTORY_VIEW_PANE_ID), () => {
      const [first] = services.scm.repositories;
      const history = first?.provider.historyProvider.get();
      return history instanceof CheckoutHistory ? history : undefined;
    });
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
    views.onDidChangeViewVisibility(({ id, visible }) => {
      if (id === HISTORY_VIEW_PANE_ID) view.graph.setVisible(visible);
    });
    // The active repository's history, attached once its server tells it serves the fork's log.
    autorun((reader) => {
      const history = scmView.activeRepository
        .read(reader)
        ?.repository.provider.historyProvider.read(reader);
      view.graph.setActive(history instanceof CheckoutHistory ? history : undefined);
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
    // What changed while the page was away (a terminal, another editor, a commit) shows on its return, in what the view shows, or in the filter's checkout, which the badge counts alone; the other checkouts wait for their next read (a run's end, a watched file, Refresh Changes, the view shown).
    host.onDidChangeFocus((focused) => {
      if (focused) {
        if (view.visible || view.filterThread() !== undefined) view.refreshScope(false);
        rereadKept();
      }
    });
    startKept();
    onDidChangeKept(() => view.render());
    onDidSelectThread(() => view.select(selectionThread()));
    // The store may load after the selection, adds and drops checkouts, and a finished run changes the files.
    threadStore.subscribe(() => view.syncStore());
    view.syncStore();
    view.select(selectionThread());
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
    const checkouts = checkoutsOf(state, isHiddenProject);
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
        baseRef: null,
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
        xaxisRoot: undefined,
        resolvable: undefined,
        revealConflict: false,
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
    // Asked beside the diff, and waited for only when there are changes to place: a folder off any repository has none.
    const repository = repositoryRoot(environmentId, root);
    repository.catch(() => undefined);
    const loading = limited(() => changesServer(environmentId).diffPreview({ cwd: root })).then(
      async (preview) => {
        const shown =
          preview.sources.length === 0
            ? undefined
            : shownChanges(environmentId, root, await repository, preview.sources);
        if (!current()) return;
        entry.failure = null;
        entry.shown = shown;
        entry.baseRef =
          preview.sources.find((source) => source.kind === "branch-range")?.baseRef ?? null;
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
      // Its history moves with its changes: a commit, a pull, a run's end.
      void entry.registered?.provider.historyProvider.get()?.refresh(entry.baseRef);
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
    // A failed read counts as a repository, for the thread bar's Source Control.
    let isRepo = true;
    let xaxisRoot: string | undefined;
    try {
      const server = changesServer(environmentId);
      const status = await limited(() => server.status(root));
      sync = syncState(status);
      isRepo = status.isRepo;
      if (status.xaxis !== undefined) {
        xaxisRoot = checkoutRepositoryRoot(root, status.workingTree.rootPath);
        // A failed ask is asked again on the next read.
        entry.resolvable ??= await server.canResolveConflicts().catch(() => undefined);
      }
    } catch (error) {
      // Not a repository, a worktree gone: nothing to sync; an xaxis checkout keeps its words and tells the failure.
      sync = failedRead(entry.sync, errorDetail(error));
      xaxisRoot = entry.xaxisRoot;
    }
    if (generation !== entry.syncGeneration || this.entries.get(entry.key) !== entry) return;
    setRepository(entry.key, isRepo);
    entry.xaxisRoot = xaxisRoot;
    if (entry.revealConflict) {
      entry.revealConflict = false;
      if ((sync?.xaxis?.conflicts.length ?? 0) > 0) void this.openConflict(entry, sync);
    }
    if (JSON.stringify(sync) === JSON.stringify(entry.sync)) return;
    entry.sync = sync;
    // The Conflicts group is the status's, which the groups are filled from on a new version.
    entry.version += 1;
    this.render();
  }

  /** The state line's click on a conflict: the checkout its key names. */
  async openConflictOf(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry !== undefined) await this.openConflict(entry);
  }

  /** The first file of the checkout's conflict that holds markers, open; else Source Control shown, the Conflicts group at its top. */
  async openConflict(entry: Entry, sync = entry.sync): Promise<void> {
    const conflicts = sync?.xaxis?.conflicts ?? [];
    const marked = conflicts.find((conflict) => conflict.markers);
    if (marked === undefined || entry.xaxisRoot === undefined) {
      await this.services.commands.executeCommand("workbench.view.scm");
      return;
    }
    await this.openFile(
      URI.joinPath(pultUri(entry.checkout.environmentId, entry.xaxisRoot), marked.path),
      false,
    );
  }

  /** A conflicted file, in Source whatever its default, since its markers are resolved there. */
  private async openFile(uri: URI, preserveFocus: boolean): Promise<void> {
    await this.services.editors.openEditor({
      resource: uri,
      options: { preserveFocus, override: DEFAULT_EDITOR_ASSOCIATION.id },
    });
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
  render(): void {
    const thread = this.filterThread();
    const narrowed = thread === undefined ? undefined : this.entryOf(thread);
    const turn = this.shownTurn();
    const decorated = new Map<string, Change>();
    for (const entry of this.entries.values()) {
      const shows =
        thread === undefined
          ? entry.shown !== undefined ||
            hasSync(entry.sync) ||
            // A kept checkout's warning keeps it listed, as a conflict does.
            this.keptLine(entry).length > 0
          : entry === narrowed;
      // A copy is named by its folder once its status says xaxis, and stays so: the workbench reads a provider's name only
      // as it registers it, so the copy's is registered again, once.
      if (!shows || (entry.registered?.copy === false && isCopy(entry))) {
        entry.registered?.repository.dispose();
        entry.registered = undefined;
      }
      if (!shows) continue;
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
      const conflicts = entry.sync?.xaxis?.conflicts ?? [];
      const conflictsGroup = provider.group(CONFLICTS_GROUP);
      const xaxisRoot = entry.xaxisRoot;
      conflictsGroup.set(
        entryTurn !== undefined || xaxisRoot === undefined
          ? []
          : conflicts.map(
              (conflict) =>
                new ConflictResource(
                  conflictsGroup,
                  entry.key,
                  conflict,
                  pultUri(entry.checkout.environmentId, xaxisRoot),
                  entry.resolvable === true,
                  (uri, preserveFocus) => this.openFile(uri, preserveFocus),
                ),
            ),
      );
      for (const { id, kind } of GROUPS) {
        const group = provider.group(id);
        const changes =
          entryTurn === undefined && entry.shown?.kind === kind
            ? withoutConflicts(entry.shown.changes, conflicts)
            : [];
        group.set(changes.map((change) => new ChangeResource(group, change, open)));
      }
      // The badge counts what is left to commit, under a turn too.
      provider.changed(entry.shown?.kind === "working-tree" ? entry.shown.changes.length : 0);
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
    const copy = isCopy(entry);
    const environment = threadStore.distinguishing(checkout.environmentId);
    const name =
      environment === undefined
        ? checkoutName(checkout, copy)
        : `${checkoutName(checkout, copy)} (${environment})`;
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
    void this.attachHistory(entry, provider);
    return { repository, provider, copy };
  }

  /** The checkout's history, on a server that serves the fork's log; a stock server's checkout keeps none, as upstream's view has no Graph. */
  private async attachHistory(entry: Entry, provider: ChangesProvider): Promise<void> {
    const served = await changesServer(entry.checkout.environmentId)
      .hasHistory()
      .catch(() => false);
    if (!served || entry.registered?.provider !== provider) return;
    const history = new CheckoutHistory(entry.checkout, this.graph);
    // Its base first, so the Graph, should it show the checkout as it attaches, reads its refs once.
    await history.refresh(entry.baseRef);
    provider.historyProvider.set(history, undefined);
    this.graph.attached(history);
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
    const xaxis = entry.sync?.xaxis ?? null;
    const placeholder = xaxis === null ? commitPlaceholder(branch) : XAXIS_PLACEHOLDER;
    if (repository.input.placeholder !== placeholder) repository.input.placeholder = placeholder;
    const button = turnShown ? undefined : this.actionButton(entry, branch);
    if (JSON.stringify(button) !== JSON.stringify(provider.actionButton.get()))
      provider.actionButton.set(button, undefined);
    const kept = this.keptLine(entry);
    // A kept checkout's own items stand alone where its status never read as xaxis's (the CLI missing, say).
    const line =
      (entry.sync === undefined || xaxis === null) && kept.length === 0
        ? undefined
        : [
            ...(entry.sync === undefined || xaxis === null
              ? []
              : xaxisStateLine(
                  entry.sync,
                  xaxis,
                  entry.shown?.kind === "working-tree" ? entry.shown.changes.length : 0,
                )),
            ...kept,
          ].map((item): Command =>
            typeof item.click === "object" && item.click !== null
              ? {
                  id: "pult-shell.selectThread",
                  title: item.title,
                  tooltip: item.tooltip,
                  arguments: [entry.checkout.environmentId, item.click.openThread],
                }
              : {
                  id:
                    item.click === "open-conflict"
                      ? OPEN_CONFLICT_COMMAND
                      : item.click === "get-latest"
                        ? PULL_COMMAND
                        : // Nothing to do but show the checkout.
                          "workbench.view.scm",
                  title: item.title,
                  tooltip: item.tooltip,
                  arguments: item.click === null ? [] : [entry.key],
                },
          );
    if (JSON.stringify(line) !== JSON.stringify(provider.statusBarCommands.get()))
      provider.statusBarCommands.set(line, undefined);
  }

  /** What the state line adds for the checkout the environment's plugin keeps at main's tip (`kept.ts`); none for any other. */
  private keptLine(entry: Entry): ReadonlyArray<XaxisStateItem> {
    const kept = keptAt(entry.checkout.environmentId, entry.checkout.root);
    return kept === undefined ? [] : keptStateLine(kept.answer, kept.checkout, Date.now());
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
      case "commit-land":
      case "get-latest":
        return {
          command: {
            // Commit commits and lands on an xaxis checkout; Pull is Get latest.
            id: action.kind === "commit-land" ? COMMIT_COMMAND : PULL_COMMAND,
            title: action.title,
            tooltip: action.tooltip,
            arguments: [entry.key],
          },
          enabled: action.enabled,
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
    const xaxis = entry.sync?.xaxis ?? null;
    if (xaxis !== null) return this.commitAndLand(entry, xaxis);
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

  /**
   * An xaxis checkout's Commit & Land: every change committed, then landed on
   * main. A commit needs a message, which the server never writes for xaxis:
   * the box's text, else the filter's thread's title on the checkout, else
   * one the shell asks for. A failure is the server's message, and the status
   * read after it opens the conflict it left.
   */
  private async commitAndLand(entry: Entry, xaxis: XaxisState): Promise<void> {
    const name = this.nameOf(entry);
    const uncommitted = entry.shown?.kind === "working-tree";
    // Cmd+Enter in the box, whatever the button offers.
    const offered = syncAction(uncommitted, entry.sync);
    if (offered.kind !== "commit-land" || !offered.enabled) {
      this.services.notifications.info(`Pult: nothing to commit or land in ${name}.`);
      return;
    }
    const typed = (entry.message ?? "").trim();
    // A pending conflict is cleared only by a commit, though Take latest may have left nothing to commit.
    const commits = uncommitted || xaxis.conflicts.length > 0;
    let message = typed;
    if (message === "" && commits) {
      const filtered = this.filterThread();
      message =
        filtered !== undefined && this.entryOf(filtered) === entry ? filtered.title.trim() : "";
    }
    if (message === "" && commits) {
      message =
        (
          await this.services.quickInput.input({
            title: `Commit & Land in ${name}`,
            placeHolder: "Message",
            prompt: "xaxis needs a message for every commit",
            validateInput: async (value) =>
              value.trim() === "" ? "Type a message to commit with" : undefined,
          })
        )?.trim() ?? "";
      if (message === "") return;
    }
    await this.runAction(entry, COMMIT_STARTED.label, async (progressed) => {
      const { notifications } = this.services;
      try {
        const latest = await this.stacked(entry, "commit_push", message, progressed);
        if (typed !== "" && commits) {
          entry.message = "";
          // Not transient, so the message joins the box's history.
          entry.registered?.repository.input.setValue("", false);
        }
        if (latest.result !== null) notifications.info(`Pult: ${toast(latest.result)}`);
      } catch (error) {
        entry.revealConflict = true;
        notifications.error(
          `Pult could not commit and land in ${name}. ${error instanceof ActionFailed ? error.message : String(error)}`,
        );
      }
    });
  }

  /** Keeps one side of the conflicted paths `resources` name, `mine` or main's, each checkout's at once. */
  async resolve(resources: ReadonlyArray<ConflictResource>, side: "mine" | "main"): Promise<void> {
    const byKey = new Map<string, ConflictResource[]>();
    for (const resource of resources)
      byKey.set(resource.key, [...(byKey.get(resource.key) ?? []), resource]);
    await Promise.all(
      [...byKey].map(async ([key, rows]) => {
        const entry = this.entries.get(key);
        if (entry === undefined) return;
        const name = this.nameOf(entry);
        await this.runAction(
          entry,
          side === "mine" ? "Keeping mine…" : "Taking latest…",
          async () => {
            try {
              await changesServer(entry.checkout.environmentId).resolveConflict({
                cwd: entry.checkout.root,
                paths: rows.map((row) => row.conflict.path),
                side,
              });
            } catch (error) {
              console.error("[pult-shell] the resolve failed", error);
              this.services.notifications.error(
                `Pult could not ${side === "mine" ? "keep your side" : "take the latest"} in ${name}. ${errorDetail(error)}`,
              );
            }
          },
        );
      }),
    );
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
    const label = entry.sync?.xaxis == null ? "Pulling…" : "Getting latest…";
    await this.runAction(entry, label, async () => {
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
      const verb = entry.sync?.xaxis == null ? "pull" : "get the latest in";
      this.services.notifications.error(
        `Pult could not ${verb} ${name}. ${pullFailure(entry.sync, errorDetail(error))}`,
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
    return entry.registered?.provider.name ?? checkoutName(entry.checkout, isCopy(entry));
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
   * The Source Control view narrowed to `thread`, selected first unless the
   * selection holds it (a Star's thread, under its Star), or to the
   * selection's thread; with `turn` its turn's files, else its
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
    if (thread !== null) {
      // A Star's thread is held by the Star's selection, whose lead tab selecting it again would show.
      if (!holdsThread(thread.environmentId, thread.threadId))
        await selectThread(thread.environmentId, thread.threadId);
      // Selecting a Star's thread selects the Star, whose selection names its current conversation.
      this.selection = thread;
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
    const query = JSON.parse(uri.query) as Side;
    if ("commit" in query) {
      const key = JSON.stringify(["commit", query.commit]);
      let loading = this.contents.get(key);
      if (loading === undefined) {
        loading = commitContents(query.commit);
        this.contents.set(key, loading);
      }
      const contents = await loading;
      return query.side === "old" ? contents.oldContents : contents.newContents;
    }
    const { change, side } = query;
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
        name: checkoutName(entry.checkout, isCopy(entry)),
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

/** The selection's thread: the selected thread, or the selected Star's current conversation; null for a draft, a sleeping Star or the Explorer workspace. */
function selectionThread(): ThreadSelection | null {
  const target = selectionTarget();
  return target !== undefined && "threadId" in target ? target : null;
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
  const [patch, repository] = await Promise.all([
    changesServer(selection.environmentId)
      .turnDiff({
        threadId: ThreadId.make(selection.threadId),
        fromTurnCount: turn.turnCount - 1,
        toTurnCount: turn.turnCount,
        ignoreWhitespace: false,
      })
      .then(
        (result) => result.diff,
        () => "",
      ),
    repositoryRoot(selection.environmentId, root),
  ]);
  const parsed = new Map(patchFiles(patch).map((file) => [file.path, file]));
  const changes = turn.files.map((stat): Change => {
    const file = parsed.get(stat.path);
    return {
      environmentId: selection.environmentId,
      cwd: root,
      repositoryRoot: repository,
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

/**
 * A commit's file's two sides: how it changed read from the server's patch
 * of that file alone, which the commit's file list leaves out, then both
 * sides through the file contents RPC, which reads neither side of a file
 * the commit adds or deletes.
 */
async function commitContents(
  file: CommitFile,
): Promise<{ readonly oldContents: string; readonly newContents: string }> {
  const server = changesServer(file.environmentId);
  const preview = await server.diffPreview({
    cwd: file.cwd,
    commitSha: file.sha,
    file: { path: file.path, previousPath: file.previousPath, sourceKind: "commit" },
  });
  const patch = preview.sources.find((source) => source.kind === "commit")?.diff ?? "";
  const changeType =
    patchFiles(patch)[0]?.changeType ?? (file.previousPath === null ? "change" : "rename-changed");
  return server.diffFileContents({
    cwd: file.cwd,
    sourceKind: "commit",
    changeType,
    baseRef: file.parent,
    headRef: file.sha,
    oldPath: file.previousPath ?? file.path,
    newPath: file.path,
  });
}

/** What the view does not do yet, loud where it is asked for: `grep 'todo('` lists it. */
function todo(reason: string): never {
  throw new Error(`Pult's changes view does not do this yet: ${reason}.`);
}

/** Each checkout's repository root, by `checkoutKey`, read once, since a checkout's repository does not move. */
const repositoryRoots = new Map<string, Promise<string>>();

/**
 * The root of the repository the checkout at `cwd` is in, which the
 * server's paths are relative to (a project in a subdirectory of its
 * repository is below it), from the checkout's status read with nothing
 * fetched; a failed read is tried again on the next ask.
 */
function repositoryRoot(environmentId: string, cwd: string): Promise<string> {
  const key = checkoutKey(environmentId, cwd);
  const known = repositoryRoots.get(key);
  if (known !== undefined) return known;
  const read = limited(() => changesServer(environmentId).localStatus(cwd)).then(
    ({ workingTree }) => checkoutRepositoryRoot(cwd, workingTree.rootPath),
  );
  repositoryRoots.set(key, read);
  read.catch(() => {
    if (repositoryRoots.get(key) === read) repositoryRoots.delete(key);
  });
  return read;
}

/**
 * The repository's root by the checkout's path: the server's is git's, with
 * every symlink resolved (macOS's `/tmp` among them), so for a checkout off
 * it, at its repository's root by its name, the checkout's own path, the
 * one the explorer and the editors name the files by.
 */
function checkoutRepositoryRoot(cwd: string, rootPath: string | undefined): string {
  if (rootPath === undefined) throw new Error(`The server named no repository root for ${cwd}.`);
  if (cwd === rootPath || cwd.startsWith(rootPath.endsWith("/") ? rootPath : `${rootPath}/`))
    return rootPath;
  if (cwd.split("/").at(-1) === rootPath.split("/").at(-1)) return cwd;
  return todo(`a checkout below its repository's root through a symlink, ${cwd} in ${rootPath}`);
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
async function showChanges(
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
 * card's clear mark and, in VS Code mode, the left panel's Source Control tab), "Pult: Refresh
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
  CommandsRegistry.registerCommand(OPEN_CONFLICT_COMMAND, async (_accessor, key: unknown) => {
    const view = await started;
    if (view !== undefined && typeof key === "string") await view.openConflictOf(key);
  });
  // An xaxis conflict's rows, while their server resolves: one side of every selected row, each checkout's at once.
  const resolvable = ContextKeyExpr.and(
    ContextKeyExpr.equals("scmProvider", PROVIDER_ID),
    ContextKeyExpr.equals("scmResourceGroup", CONFLICTS_GROUP),
    ContextKeyExpr.equals("scmResourceState", RESOLVABLE_CONFLICT),
  );
  for (const [id, side, title, icon] of [
    ["pult-shell.keepMine", "mine", "Keep mine", Codicon.check],
    ["pult-shell.takeLatest", "main", "Take latest", Codicon.cloudDownload],
  ] as const) {
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id,
            title: { value: title, original: title },
            icon,
            menu: [
              { id: MenuId.SCMResourceContext, group: "inline", when: resolvable },
              { id: MenuId.SCMResourceContext, group: "1_modification", when: resolvable },
            ],
          });
        }

        async run(_accessor: unknown, ...resources: unknown[]): Promise<void> {
          const rows = resources.filter(
            (resource): resource is ConflictResource => resource instanceof ConflictResource,
          );
          if (rows.length > 0) await (await started)?.resolve(rows, side);
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
