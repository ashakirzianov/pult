import { getService, ICommandService, type IEditorGroup, IInstantiationService } from "@codingame/monaco-vscode-api";
import {
  type EditorInput,
  EditorInputCapabilities,
  type IEditorSerializer,
  registerEditorPane,
  registerEditorSerializer,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override/common";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import vendoredCommit from "../../vendor/t3code/COMMIT?raw";
import { connection } from "../connection/index.ts";
import { allowNativeScroll } from "../nativeScroll.ts";
import { openThreadFile } from "./files.ts";
import { projectIconUri } from "./projectIcon.ts";
import { type ShellThread, threadStore } from "./store.ts";

const PANE_ID = "pult.shell.threadPane";
const VENDORED_COMMIT = vendoredCommit.trim();

let started: Promise<{ mount(element: HTMLElement, threadId: string): { dispose(): void } }> | undefined;

/**
 * Upstream's thread view, as pult-extension builds it for the shell, loaded
 * with the first pane and started once on the page's connection: its state
 * runtime runs on the connection runtime's services, so the view shares the
 * page's one socket. A thread it navigates to is selected in the shell, and
 * a file it would show in its right panel opens as a tab (`files.ts`). The
 * view imports the shell's vendored packages, so it must be built against the
 * same T3 Code commit; a view that is missing or built against another fails
 * with a message the pane shows, and the next pane tries again.
 */
function threadView() {
  started ??= (async () => {
    const [view] = await Promise.all([
      import("pult-extension/thread-view"),
      import("pult-extension/thread-view.css"),
    ]);
    if (view.VENDORED_COMMIT !== VENDORED_COMMIT) {
      const built = view.VENDORED_COMMIT === undefined ? "an older pult-extension" : `T3 Code ${view.VENDORED_COMMIT.slice(0, 12)}`;
      throw new Error(
        `The extension's thread view is built against ${built}; this shell vendors T3 Code ${VENDORED_COMMIT.slice(0, 12)}. Bring the two to one pin and rebuild the extension, then reload.`,
      );
    }
    const workbench = document.querySelector(".monaco-workbench") ?? document.body;
    return view.startThreadView(
      {
        connection: () => connection.context(),
        environmentId: () => connection.environment?.environmentId ?? null,
        openThread: (threadId) =>
          void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.selectThread", threadId)),
        openFile: (threadId, path, line) => void openThreadFile(threadId, path, line),
      },
      workbench,
    );
  })().catch((error: unknown) => {
    started = undefined;
    throw error;
  });
  return started;
}

/** The thread's turns and composer while the page is connected, mounted again when its environment changes. */
function ThreadContent({ threadId }: { threadId: string }) {
  const environmentId = useSyncExternalStore(
    (listener) => connection.onDidChange(listener),
    () => connection.environment?.environmentId,
  );
  const element = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const target = element.current;
    if (environmentId === undefined || target === null) return;
    let view: { dispose(): void } | undefined;
    let disposed = false;
    threadView().then(
      ({ mount }) => {
        if (!disposed) view = mount(target, threadId);
      },
      (error: unknown) => {
        console.error("[pult-shell] the thread view did not start", error);
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
      // The view is a React root of its own, which cannot unmount while this one renders.
      const mounted = view;
      if (mounted !== undefined) queueMicrotask(() => mounted.dispose());
    };
  }, [environmentId, threadId]);
  if (environmentId === undefined) {
    return <div className="pult-thread-empty">Not connected. Run “Pult: Connect to Environment”.</div>;
  }
  if (failure !== undefined) return <div className="pult-thread-empty">{failure}</div>;
  return <div ref={element} className="pult-thread-content" />;
}

/**
 * An editor pane the shell renders itself, registered below the extension API
 * with the workbench's own `EditorPane` and `EditorInput`. The pane mounts a
 * React root in the element the editor group hands it, and the thread view in
 * it, in-process; the group handles tabs, drag and restore as for any editor. `selection.ts` opens it as the selected
 * thread's leftmost tab.
 */
class ThreadPane extends SimpleEditorPane {
  static readonly ID = PANE_ID;
  private root: Root | undefined;

  constructor(group: IEditorGroup) {
    super(ThreadPane.ID, group);
  }

  initialize(): HTMLElement {
    const element = document.createElement("div");
    element.className = "pult-thread-pane";
    // The view's timeline is a native scroller.
    allowNativeScroll(element);
    return element;
  }

  async renderInput(input: EditorInput) {
    const threadId = input instanceof ThreadInput ? input.threadId : "";
    this.root?.unmount();
    this.root = createRoot(this.container);
    this.root.render(<ThreadContent threadId={threadId} />);
    return {
      dispose: () => {
        this.root?.unmount();
        this.root = undefined;
      },
    };
  }
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
 * startup is created before the extension has pushed the threads.
 */
export class ThreadInput extends SimpleEditorInput {
  private icon: { key: string; uri: URI } | undefined;

  constructor(readonly threadId: string) {
    super(undefined);
    this.addCapability(
      EditorInputCapabilities.CannotClose | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceDescription,
    );
    this.updateLabel();
    const unsubscribe = threadStore.subscribe(() => this.updateLabel());
    this._register({ dispose: unsubscribe });
  }

  private thread(): ShellThread | undefined {
    return threadStore.get().threads.find((thread) => thread.id === this.threadId);
  }

  /** The name is the title; setting it fires the label change that redraws the description and icon too. */
  private updateLabel(): void {
    const thread = this.thread();
    const title = thread?.title ?? "Thread";
    const description = thread?.projectName;
    if (title !== this.getName() || description !== this.getDescription()) {
      this.setDescription(description ?? "");
      this.setName(title);
    }
  }

  override getDescription(): string {
    return this.thread()?.projectName ?? "";
  }

  override getTitle(): string {
    const thread = this.thread();
    return thread === undefined ? "Thread" : `${thread.projectName}: ${thread.title}`;
  }

  override getIcon(): URI | undefined {
    const thread = this.thread();
    if (thread === undefined) return undefined;
    const key = `${thread.projectName}|${JSON.stringify(thread.projectIcon)}`;
    if (this.icon?.key !== key) this.icon = { key, uri: projectIconUri(thread.projectName, thread.projectIcon) };
    return this.icon.uri;
  }

  override getLabelExtraClasses(): string[] {
    return ["pult-thread-tab"];
  }

  override get typeId(): string {
    return PANE_ID;
  }

  override matches(other: unknown): boolean {
    return other instanceof ThreadInput && other.threadId === this.threadId;
  }
}

interface SerializedThreadInput {
  readonly threadId: string;
}

export function registerThreadPane(): void {
  registerEditorPane(PANE_ID, "Pult Thread", ThreadPane, [ThreadInput]);
  // Serialisable, so the editor part's saved state and the per-thread working
  // sets (`selection.ts`) restore the thread's tab with the rest.
  registerEditorSerializer(
    PANE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: ThreadInput): string {
        return JSON.stringify({ threadId: editor.threadId } satisfies SerializedThreadInput);
      }
      deserialize(instantiation: IInstantiationService, serialized: string): EditorInput {
        const { threadId } = JSON.parse(serialized) as SerializedThreadInput;
        return instantiation.createInstance(ThreadInput, threadId);
      }
    },
  );
}
