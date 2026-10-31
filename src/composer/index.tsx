import { getService, IContextKeyService, INotificationService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Emitter } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import type { MountedView, ViewTarget } from "../../thread-view/shell/main.tsx";
import { connection } from "../connection/connection.ts";
import { isShellTab, threadView } from "../threads/pane.tsx";
import { isSwitchingThread, onDidSelectThread, selectedDraft, selectedThread } from "../threads/selection.ts";
import "./composer.css";

const SHOW_COMPOSER = "pult-shell.showComposer";
const HIDE_COMPOSER = "pult-shell.hideComposer";

/** `pult.composerOpen`: whether the composer strip is open, shown under a file or not. */
const ComposerOpenContext = new RawContextKey<boolean>("pult.composerOpen", false);

/** The layout's grid and its editor part's view, as `src/status/` reaches them. */
interface LayoutGrid {
  readonly workbenchGrid: Grid<IView>;
  readonly editorPartView: IView;
}

/**
 * The composer strip's state: one switch for the page, open or closed, while
 * open shown under any file of the selected thread or draft; and whether that
 * composer holds anything, which the status strip's entry marks while the
 * strip is closed.
 */
interface ComposerState {
  readonly open: boolean;
  readonly filled: boolean;
}

let state: ComposerState = { open: false, filled: false };
const onDidChangeState = new Emitter<void>();
const setState = (next: Partial<ComposerState>) => {
  if (Object.entries(next).every(([key, value]) => state[key as keyof ComposerState] === value)) return;
  state = { ...state, ...next };
  onDidChangeState.fire();
};

/** The strip's state for `useSyncExternalStore`, and its switch. */
export const composerStrip = {
  get: () => state,
  subscribe: (listener: () => void) => {
    const subscription = onDidChangeState.event(listener);
    return () => subscription.dispose();
  },
  setOpen: (open: boolean) => setState({ open }),
};

/**
 * Keeps `filled` to the selected composer: the thread view's composer store
 * (`thread-view/shell/drafts.ts`), loaded without the rest of the view.
 */
function followFilled(): void {
  void import("../../thread-view/shell/drafts.ts").then(({ composerHasContent, onDidChangeComposers }) => {
    const update = () => {
      const target = selectedTarget();
      setState({ filled: target !== null && composerHasContent(target) });
    };
    onDidChangeComposers(update);
    onDidSelectThread(update);
    connection.onDidChange(update);
    update();
  });
}

/** The selected thread or draft, on the environment the page holds it by, which the strip's composer is. */
function selectedTarget(): ViewTarget | null {
  const thread = selectedThread();
  const draft = selectedDraft();
  const environmentId = connection.environment((thread ?? draft)?.environmentId ?? "")?.environmentId;
  if (environmentId === undefined) return null;
  if (thread !== undefined) return { kind: "thread", environmentId, threadId: thread.threadId };
  if (draft !== undefined) return { kind: "draft", environmentId, projectId: draft.projectId };
  return null;
}

const sameTarget = (left: ViewTarget | null, right: ViewTarget | null) => JSON.stringify(left) === JSON.stringify(right);

/** The strip's height before its composer has rendered. */
const INITIAL_HEIGHT = 120;

/**
 * The strip as a view of the workbench's grid, as tall as the composer it
 * holds: upstream's composer is an overlay pinned to the bottom of the
 * view's canvas, its turns hidden behind it here (`composer.css`), so the
 * strip takes the overlay's height, followed as the message grows.
 */
function stripView() {
  const element = document.createElement("div");
  element.className = "pult-composer-strip";
  const content = document.createElement("div");
  content.className = "pult-composer-strip-content";
  element.append(content);
  const onDidChange = new Emitter<undefined>();
  let height = INITIAL_HEIGHT;
  const view: IView = {
    element,
    minimumWidth: 0,
    maximumWidth: Number.POSITIVE_INFINITY,
    get minimumHeight() {
      return height;
    },
    get maximumHeight() {
      return height;
    },
    onDidChange: onDidChange.event,
    layout: () => {},
  };
  const resize = (next: number) => {
    if (next <= 0 || next === height) return;
    height = next;
    onDidChange.fire(undefined);
  };
  // The overlay comes and goes with the view's routes, so the strip watches for it.
  let observed: Element | null = null;
  const sizes = new ResizeObserver(([entry]) => resize(Math.ceil(entry?.borderBoxSize[0]?.blockSize ?? 0)));
  new MutationObserver(() => {
    const overlay = content.querySelector("[data-chat-composer-overlay]");
    if (overlay === observed) return;
    if (observed !== null) sizes.unobserve(observed);
    observed = overlay;
    if (overlay !== null) sizes.observe(overlay);
  }).observe(content, { childList: true, subtree: true });
  return { view, content };
}

/**
 * The composer under a file (xaxis `pult/issues/file-citations`): while the
 * strip is open and the active editor is a file of the selected thread's or
 * draft's tab set, that thread's or draft's composer, a composer-only mount
 * of the thread view (`thread-view/shell/ThreadView.tsx`), in a view of the
 * layout's grid between the editor part and the status strip. Mounted when
 * first shown, and again when the selection changes while it is open.
 * Started after the status strip, so it lands above it.
 */
export async function startComposerStrip(): Promise<void> {
  const [editors, contextKeys] = await Promise.all([getService(IEditorService), getService(IContextKeyService)]);
  const layout = (await getService(IWorkbenchLayoutService)) as unknown as Partial<LayoutGrid>;
  const { workbenchGrid, editorPartView } = layout;
  if (workbenchGrid === undefined || editorPartView === undefined) return;

  const openKey = ComposerOpenContext.bindTo(contextKeys);
  const strip = stripView();
  workbenchGrid.addView(strip.view, strip.view.minimumHeight, editorPartView, Direction.Down);
  workbenchGrid.setViewVisible(strip.view, false);

  let mounted: { target: ViewTarget; view: MountedView | undefined; disposed: boolean } | undefined;
  const unmount = () => {
    if (mounted === undefined) return;
    mounted.disposed = true;
    const view = mounted.view;
    mounted = undefined;
    if (view !== undefined) queueMicrotask(() => view.dispose());
  };
  const mount = (target: ViewTarget) => {
    unmount();
    const host = document.createElement("div");
    host.className = "pult-composer-strip-view";
    strip.content.replaceChildren(host);
    const current: NonNullable<typeof mounted> = { target, view: undefined, disposed: false };
    mounted = current;
    void threadView().then(
      (mounts) => {
        if (current.disposed) return;
        current.view = mounts.mountComposer(host, target);
      },
      (error: unknown) => console.error("[pult-shell] the composer strip did not start", error),
    );
  };

  const update = () => {
    if (isSwitchingThread()) return;
    const { open } = state;
    openKey.set(open);
    const active = editors.activeEditor;
    const target = selectedTarget();
    const visible = open && target !== null && active !== undefined && !isShellTab(active);
    if (visible && !sameTarget(mounted?.target ?? null, target)) mount(target);
    // A selection the strip no longer shows lets its composer go; the next one mounts when shown.
    if (!sameTarget(mounted?.target ?? null, target)) unmount();
    workbenchGrid.setViewVisible(strip.view, visible);
  };
  editors.onDidActiveEditorChange(update);
  editors.onDidEditorsChange(update);
  onDidSelectThread(update);
  onDidChangeState.event(update);
  connection.onDidChange(update);
  update();
  followFilled();
}

/** The palette's Show Composer and Hide Composer, each offered while it would change something. Registered before the workbench starts. */
export function registerComposerCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: SHOW_COMPOSER,
          title: { value: "Show Composer", original: "Show Composer" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          precondition: ContextKeyExpr.not(ComposerOpenContext.key),
        });
      }

      async run(): Promise<void> {
        if (selectedTarget() === null) {
          return void (await getService(INotificationService)).info("The composer shows under a file of a thread or a new thread.");
        }
        composerStrip.setOpen(true);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: HIDE_COMPOSER,
          title: { value: "Hide Composer", original: "Hide Composer" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          precondition: ComposerOpenContext,
        });
      }

      run(): void {
        composerStrip.setOpen(false);
      }
    },
  );
}
