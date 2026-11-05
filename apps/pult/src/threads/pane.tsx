import {
  getService,
  ICommandService,
  type IEditorGroup,
  IInstantiationService,
} from "@codingame/monaco-vscode-api";
import {
  type EditorInput,
  EditorInputCapabilities,
  type IEditorSerializer,
  registerEditorPane,
  registerEditorSerializer,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override/common";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  MountedView,
  MountOptions,
  ThreadViewHost,
  ThreadViewMounts,
} from "../../view/main.tsx";

import { connection } from "../connection/index.ts";
import { allowNativeScroll } from "../nativeScroll.ts";
import { allowNativeTextMenu } from "../nativeTextMenu.ts";
import { isSettingsTab, type SettingsInput } from "../settings/pane.tsx";
import { starMarkUrl } from "../stars/mark.ts";
import { starById, starStore } from "../stars/model.ts";
import { DEFAULT_TINT } from "../stars/record.ts";
import { starName } from "../stars/stars.ts";
import { StarContent } from "../stars/tab.tsx";
import { workbenchColorScheme } from "../theme.ts";
import { ThreadBarEntries } from "./barEntries.tsx";
import { openThreadFile, registerOpenThreadFileCommand } from "./files.ts";
import { projectIconUri, projectIcons, threadProjectIcon } from "./projectIcon.ts";
import { isSubagent, type ShellProject, type ShellThread, threadStore } from "./store.ts";

const PANE_ID = "pult.shell.threadPane";
/** The draft tab's input type, which its serialiser is registered under; its pane is the thread's. */
const DRAFT_TYPE_ID = "pult.shell.draft";
/** The Star's tab's input type, the same way. */
const STAR_TYPE_ID = "pult.shell.star";

let started: Promise<ThreadViewMounts> | undefined;
/** The view once it has started, for what the page asks of it synchronously. */
let loaded: ThreadViewMounts | undefined;

/** What a pane shows, in its environment: a thread, or a project's draft of a new thread. */
export type PaneTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string };

type PromotionListener = (
  draft: { readonly environmentId: string; readonly projectId: string },
  thread: { readonly environmentId: string; readonly threadId: string },
) => void;

const promotionListeners = new Set<PromotionListener>();

/** Called when a project's draft, mounted in a pane, has become a thread on the server; `selection.ts` follows it. */
export function onDidPromoteDraft(listener: PromotionListener): () => void {
  promotionListeners.add(listener);
  return () => promotionListeners.delete(listener);
}

/** Where the view's preview browsers go: the shell's preview tabs (`src/preview/tabs.ts`), which hand them over at boot. */
let previewTabs: Pick<ThreadViewHost, "openPreview" | "closeStalePreviews"> = {
  openPreview: () => {},
  closeStalePreviews: () => {},
};

/** Sets where the view's preview browsers go, before the view starts. */
export function setPreviewTabs(
  tabs: Pick<ThreadViewHost, "openPreview" | "closeStalePreviews">,
): void {
  previewTabs = tabs;
}

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * Upstream's thread view (`view/`, over `apps/web`), loaded with the first pane and
 * started once on the page's connection: its state runtime runs on the
 * connection runtime's services, so the view shares the page's sockets, one
 * per environment, each pane mounting its target's environment.
 * A thread it navigates to is selected in the shell, and so is a draft of a
 * new thread, as its project's draft; a file it would show in its right
 * panel opens as a tab (`files.ts`), and so does a preview browser
 * (`src/preview/`), and its diff is the changes view
 * (`src/changes/`), the Source Control view. A view that fails to load fails with a
 * message the pane shows, and the next pane tries again.
 */
export function threadView() {
  started ??= (async () => {
    const [view, scheme] = await Promise.all([
      import("../../view/main.tsx"),
      workbenchColorScheme(),
    ]);
    loaded = view.startThreadView({
      connection: () => connection.context(),
      openThread: (environmentId, threadId) =>
        run("pult-shell.selectThread", environmentId, threadId),
      // A draft the view went to, which it remembered as the project's.
      openDraft: (environmentId, projectId) =>
        run("pult-shell.newThread", environmentId, projectId),
      openFile: (environmentId, threadId, path, line) =>
        void openThreadFile(environmentId, threadId, path, line),
      // The changes view (`src/changes/`): the Source Control view over the thread's project, with a turn's group when the view named one.
      openChanges: (environmentId, threadId, path, turn) =>
        run("pult-shell.showChanges", environmentId, threadId, path, turn),
      // The preview browsers are the shell's tabs (`src/preview/`).
      openPreview: (environmentId, threadId, tabId, options) =>
        previewTabs.openPreview(environmentId, threadId, tabId, options),
      closeStalePreviews: (environmentId, threadId, liveTabIds) =>
        previewTabs.closeStalePreviews(environmentId, threadId, liveTabIds),
      // A native subagent's work is a runless turn the shell snapshot cannot see; the view's projection can.
      reportActivity: (activity) => threadStore.reportActivity(activity),
      // The view's System theme is the workbench theme's light or dark.
      colorScheme: scheme.current,
      onDidChangeColorScheme: scheme.onDidChange,
      // Pult.app's main keeps a hidden window compositing while an agent's capture of a browser runs.
      keepRendering: window.pultDesktop?.keepRendering,
    });
    return loaded;
  })().catch((error: unknown) => {
    started = undefined;
    throw error;
  });
  return started;
}

/**
 * Whether the thread is the one the project's draft creates, as the view
 * knows it before it names the thread to the draft's `onPromoted`; false
 * while no view has started, when no draft is mounted either.
 */
export function draftCreates(
  draft: { readonly environmentId: string; readonly projectId: string },
  environmentId: string,
  threadId: string,
): boolean {
  return (
    loaded?.draftCreates(draft.environmentId, draft.projectId, environmentId, threadId) ?? false
  );
}

/**
 * The thread's turns and composer, or the project's draft, while the page
 * holds its environment. Mounted again when the page takes up or lets go of
 * that environment, or `generation` changes, and not when only `target`
 * does, which is a draft's promotion: the view mounted for the draft becomes
 * the new thread's, at once if it has not gone there itself yet
 * (`MountedView.follow`). A thread's place (`ThreadBarEntries`) joins the
 * view's composer bar, or what `barEntries` renders there; `options` are the
 * caller's additions to the view, read as it mounts (a Star's fold, its
 * placeholder, its draft without upstream's hero, `src/stars/tab.tsx`).
 */
export function ThreadContent({
  target,
  generation,
  onPromoted,
  options,
  barEntries,
}: {
  target: PaneTarget;
  generation: number;
  onPromoted: (environmentId: string, threadId: string) => void;
  options?: MountOptions;
  barEntries?: (bar: HTMLElement) => ReactNode;
}) {
  const environmentId = useSyncExternalStore(
    (listener) => connection.onDidChange(listener),
    () => connection.environment(target.environmentId)?.environmentId,
  );
  const element = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string>();
  const [bar, setBar] = useState<HTMLElement>();
  const latest = useRef({ target, onPromoted, options });
  // oxlint-disable-next-line react/refs -- the view's callbacks read the latest props without remounting it.
  latest.current = { target, onPromoted, options };
  const mounted = useRef<MountedView>(undefined);
  useEffect(() => {
    const host = element.current;
    if (environmentId === undefined || host === null) return;
    let view: MountedView | undefined;
    let disposed = false;
    threadView().then(
      (mounts) => {
        if (disposed) return;
        const shown = latest.current.target;
        const options = latest.current.options ?? {};
        view =
          shown.kind === "thread"
            ? mounts.mount(host, environmentId, shown.threadId, options)
            : mounts.mountDraft(
                host,
                environmentId,
                shown.projectId,
                (promotedIn, threadId) => latest.current.onPromoted(promotedIn, threadId),
                options,
              );
        mounted.current = view;
        setBar(view.bar);
      },
      (error: unknown) => {
        console.error("[pult-shell] the thread view did not start", error);
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
      setBar(undefined);
      // The view is a React root of its own, which cannot unmount while this one renders.
      const shown = view;
      if (mounted.current === shown) mounted.current = undefined;
      if (shown !== undefined) queueMicrotask(() => shown.dispose());
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new generation remounts the view.
  }, [environmentId, generation]);
  // The thread a draft's view became, which the caller may learn of before the view goes there.
  const promotedTo = target.kind === "thread" ? target.threadId : undefined;
  useEffect(() => {
    if (environmentId !== undefined && promotedTo !== undefined)
      mounted.current?.follow(environmentId, promotedTo);
  }, [environmentId, promotedTo]);
  if (environmentId === undefined) {
    return (
      <div className="pult-thread-empty">
        Not connected to this thread's environment. Run “Pult: Connect to Environment”.
      </div>
    );
  }
  if (failure !== undefined) return <div className="pult-thread-empty">{failure}</div>;
  return (
    <>
      <div ref={element} className="pult-thread-content" />
      {bar === undefined ? null : barEntries !== undefined ? (
        barEntries(bar)
      ) : target.kind === "thread" ? (
        <ThreadBarEntries
          bar={bar}
          environmentId={target.environmentId}
          threadId={target.threadId}
        />
      ) : null}
    </>
  );
}

/**
 * An editor pane the shell renders itself, registered below VS Code's extension API
 * with the workbench's own `EditorPane` and `EditorInput`. The pane mounts a
 * React root in the element the editor group hands it, and the thread view in
 * it, in-process; the group handles tabs, drag and restore as for any editor. `selection.ts` opens it as the selected
 * thread's or draft's leftmost tab.
 */
class ThreadPane extends SimpleEditorPane {
  static readonly ID = PANE_ID;
  private root: Root | undefined;
  /** The input the view is mounted for, and the thread its draft became, which the pane then shows without mounting again. */
  private shown:
    | { readonly input: EditorInput; promotedTo?: { environmentId: string; threadId: string } }
    | undefined;
  private generation = 0;

  constructor(group: IEditorGroup) {
    super(ThreadPane.ID, group);
  }

  initialize(): HTMLElement {
    const element = document.createElement("div");
    element.className = "pult-thread-pane";
    // The view's timeline is a native scroller.
    allowNativeScroll(element);
    // The composer's message has the browser's menu, with its spelling suggestions.
    allowNativeTextMenu(element);
    return element;
  }

  /**
   * Mounts the input's thread or draft. The tab of the thread a draft
   * became, which replaces the draft's (`selection.ts`), keeps the view
   * mounted as it is. A Star's tab mounts what the Star shows, which
   * follows its conversation itself (`StarContent`).
   */
  async renderInput(input: EditorInput) {
    if (input instanceof StarInput) {
      this.root?.unmount();
      this.root = createRoot(this.container);
      const shown = { input };
      this.shown = shown;
      this.root.render(<StarContent starId={input.starId} />);
      return {
        dispose: () => {
          if (this.shown === shown) this.release();
        },
      };
    }
    const target: PaneTarget =
      input instanceof DraftInput
        ? { kind: "draft", environmentId: input.environmentId, projectId: input.projectId }
        : input instanceof ThreadInput
          ? { kind: "thread", environmentId: input.environmentId, threadId: input.threadId }
          : { kind: "thread", environmentId: "", threadId: "" };
    const promotedTo = this.shown?.promotedTo;
    const adopted =
      target.kind === "thread" &&
      promotedTo?.threadId === target.threadId &&
      promotedTo.environmentId === target.environmentId;
    if (!adopted || this.root === undefined) {
      this.root?.unmount();
      this.root = createRoot(this.container);
      this.generation += 1;
    }
    const shown: {
      readonly input: EditorInput;
      promotedTo?: { environmentId: string; threadId: string };
    } = { input };
    this.shown = shown;
    const promoted = (environmentId: string, threadId: string) => {
      if (this.shown !== shown || target.kind !== "draft") return;
      shown.promotedTo = { environmentId, threadId };
      for (const listener of promotionListeners) listener(target, shown.promotedTo);
    };
    this.root.render(
      <ThreadContent target={target} generation={this.generation} onPromoted={promoted} />,
    );
    return {
      // Disposed as the group clears the input, before the next one renders. A
      // draft become a thread keeps its view for that thread's tab, which
      // replaces it next; it goes if the pane is hidden or shows another input instead.
      dispose: () => {
        if (this.shown === shown && shown.promotedTo === undefined) this.release();
      },
    };
  }

  override setVisible(visible: boolean): void {
    super.setVisible(visible);
    // Hidden with its input cleared: a view kept for a promotion has no tab coming.
    if (!visible && this.input === undefined) this.release();
  }

  override dispose(): void {
    this.release();
    super.dispose();
  }

  private release(): void {
    this.root?.unmount();
    this.root = undefined;
    this.shown = undefined;
  }
}

/** A selection's own leftmost tab: a thread's, a draft's or a Star's. */
export type LeadTab = ThreadInput | DraftInput | StarInput;

/** Whether `editor` is a selection's own leftmost tab. */
export function isLeadTab(editor: unknown): editor is LeadTab {
  return (
    editor instanceof ThreadInput || editor instanceof DraftInput || editor instanceof StarInput
  );
}

/**
 * Whether `editor` is a tab the shell renders and keeps leftmost: a lead
 * tab, or the Settings page (`src/settings/`), which unlike a lead tab
 * closes. None has a status bar.
 */
export function isShellTab(editor: unknown): editor is LeadTab | SettingsInput {
  return isLeadTab(editor) || isSettingsTab(editor);
}

/**
 * The selected thread's tab, which carries the thread view's header: the
 * project's icon, the thread's title as its name and the project as its
 * description, shown always (`ForceDescription`), the `pult-thread-tab`
 * class for its look (`src/style.css`). It cannot be closed: it leaves the
 * editor part only when another thread is selected, which swaps the whole
 * part with `force`. It is a singleton: Split Editor skips it and a drag
 * moves it rather than copies it, so a second copy never appears that could
 * not be closed. Its label follows the store, since a tab restored at
 * startup is created before the thread model has loaded the threads.
 */
export class ThreadInput extends SimpleEditorInput {
  private labelKey: string | undefined;
  private labelIcon: URI | undefined;

  constructor(
    readonly environmentId: string,
    readonly threadId: string,
  ) {
    super(undefined);
    this.addCapability(
      EditorInputCapabilities.CannotClose |
        EditorInputCapabilities.Singleton |
        EditorInputCapabilities.ForceDescription,
    );
    this.updateLabel();
    const unsubscribe = threadStore.subscribe(() => this.updateLabel());
    this._register({ dispose: unsubscribe });
    this._register({ dispose: projectIcons.onDidChange(() => this.updateLabel()) });
  }

  private thread(): ShellThread | undefined {
    return threadStore.thread(this.environmentId, this.threadId);
  }

  /** The name is the title; setting it fires the label change that redraws the description, title and icon too. */
  private updateLabel(): void {
    const key = JSON.stringify([this.thread()?.title, this.getDescription(), this.getTitle()]);
    const icon = this.getIcon();
    if (key === this.labelKey && icon === this.labelIcon) return;
    this.labelKey = key;
    this.labelIcon = icon;
    this.setName(this.thread()?.title ?? "Thread");
  }

  /** The project, and for a subagent's thread that it is one. */
  override getDescription(): string {
    const thread = this.thread();
    if (thread === undefined) return "";
    return isSubagent(thread) ? `${thread.projectName} · subagent` : thread.projectName;
  }

  override getTitle(): string {
    const thread = this.thread();
    if (thread === undefined) return "Thread";
    const parent =
      thread.parentId === null
        ? undefined
        : threadStore.thread(thread.environmentId, thread.parentId);
    const lineage =
      isSubagent(thread) && parent !== undefined ? ` (a subagent of ${parent.title})` : "";
    return `${thread.projectName}: ${thread.title}${lineage}`;
  }

  override getIcon(): URI | undefined {
    const thread = this.thread();
    if (thread === undefined) return undefined;
    return projectIconUri(threadProjectIcon(thread));
  }

  override getLabelExtraClasses(): string[] {
    return ["pult-thread-tab"];
  }

  override get typeId(): string {
    return PANE_ID;
  }

  override matches(other: unknown): boolean {
    return (
      other instanceof ThreadInput &&
      other.threadId === this.threadId &&
      other.environmentId === this.environmentId
    );
  }
}

/**
 * The selected draft's tab, a project's new thread: "New Thread" with the
 * project's icon and name, as the thread tab shows a thread's, in the same
 * pane, which mounts upstream's composer for the draft. Like the thread tab
 * it cannot be closed and is a singleton; when the draft becomes a thread,
 * `selection.ts` replaces it with that thread's tab.
 */
export class DraftInput extends SimpleEditorInput {
  private labelKey: string | undefined;
  private labelIcon: URI | undefined;

  constructor(
    readonly environmentId: string,
    readonly projectId: string,
  ) {
    super(undefined);
    this.addCapability(
      EditorInputCapabilities.CannotClose |
        EditorInputCapabilities.Singleton |
        EditorInputCapabilities.ForceDescription,
    );
    this.updateLabel();
    const unsubscribe = threadStore.subscribe(() => this.updateLabel());
    this._register({ dispose: unsubscribe });
    this._register({ dispose: projectIcons.onDidChange(() => this.updateLabel()) });
  }

  private project(): ShellProject | undefined {
    return threadStore.project(this.environmentId, this.projectId);
  }

  /** Setting the name fires the label change that redraws the description, title and icon. */
  private updateLabel(): void {
    const key = this.project()?.name;
    const icon = this.getIcon();
    if (key === this.labelKey && icon === this.labelIcon) return;
    this.labelKey = key;
    this.labelIcon = icon;
    this.setName("New Thread");
  }

  override getDescription(): string {
    return this.project()?.name ?? "";
  }

  override getTitle(): string {
    const project = this.project();
    return project === undefined ? "New Thread" : `${project.name}: New Thread`;
  }

  override getIcon(): URI | undefined {
    const project = this.project();
    if (project === undefined) return undefined;
    return projectIconUri(project);
  }

  override getLabelExtraClasses(): string[] {
    return ["pult-thread-tab"];
  }

  override get typeId(): string {
    return DRAFT_TYPE_ID;
  }

  override matches(other: unknown): boolean {
    return (
      other instanceof DraftInput &&
      other.projectId === this.projectId &&
      other.environmentId === this.environmentId
    );
  }
}

/**
 * The selected Star's tab (`src/stars/`), one for the Star whatever thread
 * holds its conversation: its name, "Star" while it has none, with its mark
 * as the icon, in the same pane, which mounts what the Star shows
 * (`StarContent`). Like the thread tab it cannot be closed and is a
 * singleton; its label follows the Star's store, since a tab restored at
 * startup is created before the Stars are read.
 */
export class StarInput extends SimpleEditorInput {
  private labelKey: string | undefined;

  constructor(readonly starId: string) {
    super(undefined);
    this.addCapability(EditorInputCapabilities.CannotClose | EditorInputCapabilities.Singleton);
    this.updateLabel();
    this._register({ dispose: starStore.subscribe(() => this.updateLabel()) });
  }

  private star() {
    return starById(this.starId);
  }

  /** Setting the name fires the label change that redraws the title and icon. */
  private updateLabel(): void {
    const star = this.star();
    const key = JSON.stringify([star?.name, star?.tint]);
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.setName(star === undefined ? "Star" : starName(star));
  }

  override getTitle(): string {
    const star = this.star();
    return star === undefined || starName(star) === "Star"
      ? "Star"
      : `${starName(star)}, your Star`;
  }

  override getIcon(): URI {
    return URI.parse(starMarkUrl(this.star()?.tint ?? DEFAULT_TINT));
  }

  override getLabelExtraClasses(): string[] {
    return ["pult-thread-tab"];
  }

  override get typeId(): string {
    return STAR_TYPE_ID;
  }

  override matches(other: unknown): boolean {
    return other instanceof StarInput && other.starId === this.starId;
  }
}

/** A saved tab's identity; one saved before tabs named their environment has none, and is dropped. */
interface SerializedThreadInput {
  readonly environmentId?: string;
  readonly threadId: string;
}

interface SerializedDraftInput {
  readonly environmentId?: string;
  readonly projectId: string;
}

interface SerializedStarInput {
  readonly starId: string;
}

/** The thread's editor pane and its serialisers, and `pult-shell.openThreadFile`, what the view's file links run (`files.ts`). */
export function registerThreadPane(): void {
  registerEditorPane(PANE_ID, "Pult Thread", ThreadPane, [ThreadInput, DraftInput, StarInput]);
  registerOpenThreadFileCommand();
  // Serialisable, so the editor part's saved state and the per-selection working
  // sets (`selection.ts`) restore the thread's, draft's or Star's tab with the rest.
  registerEditorSerializer(
    PANE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: ThreadInput): string {
        return JSON.stringify({
          environmentId: editor.environmentId,
          threadId: editor.threadId,
        } satisfies SerializedThreadInput);
      }
      deserialize(
        instantiation: IInstantiationService,
        serialized: string,
      ): EditorInput | undefined {
        const { environmentId, threadId } = JSON.parse(serialized) as SerializedThreadInput;
        return environmentId === undefined
          ? undefined
          : instantiation.createInstance(ThreadInput, environmentId, threadId);
      }
    },
  );
  registerEditorSerializer(
    DRAFT_TYPE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: DraftInput): string {
        return JSON.stringify({
          environmentId: editor.environmentId,
          projectId: editor.projectId,
        } satisfies SerializedDraftInput);
      }
      deserialize(
        instantiation: IInstantiationService,
        serialized: string,
      ): EditorInput | undefined {
        const { environmentId, projectId } = JSON.parse(serialized) as SerializedDraftInput;
        return environmentId === undefined
          ? undefined
          : instantiation.createInstance(DraftInput, environmentId, projectId);
      }
    },
  );
  registerEditorSerializer(
    STAR_TYPE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: StarInput): string {
        return JSON.stringify({ starId: editor.starId } satisfies SerializedStarInput);
      }
      deserialize(
        instantiation: IInstantiationService,
        serialized: string,
      ): EditorInput | undefined {
        const { starId } = JSON.parse(serialized) as SerializedStarInput;
        return instantiation.createInstance(StarInput, starId);
      }
    },
  );
}
