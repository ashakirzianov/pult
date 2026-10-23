import { type IEditorGroup, IInstantiationService } from "@codingame/monaco-vscode-api";
import {
  type EditorInput,
  EditorInputCapabilities,
  type IEditorSerializer,
  registerEditorPane,
  registerEditorSerializer,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot, type Root } from "react-dom/client";

import { threadStore } from "./store.ts";
import { ThreadView } from "./ThreadView.tsx";

const PANE_ID = "pult.shell.threadPane";

/**
 * An editor pane the shell renders itself, registered below the extension API
 * with the workbench's own `EditorPane` and `EditorInput`. The pane mounts a
 * React root in the element the editor group hands it; the group handles tabs,
 * drag and restore as for any editor. `selection.ts` opens it as the selected
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
    return element;
  }

  async renderInput(input: EditorInput) {
    const threadId = input instanceof ThreadInput ? input.threadId : "";
    this.root?.unmount();
    this.root = createRoot(this.container);
    this.root.render(<ThreadView threadId={threadId} />);
    return {
      dispose: () => {
        this.root?.unmount();
        this.root = undefined;
      },
    };
  }
}

/**
 * The selected thread's tab. It cannot be closed: it leaves the editor part
 * only when another thread is selected, which swaps the whole part with
 * `force`. It is a singleton: Split Editor skips it and a drag moves it rather
 * than copies it, so a second copy never appears that could not be closed.
 * Its name follows the thread's title, since a tab restored at startup is
 * created before the extension has pushed the threads.
 */
export class ThreadInput extends SimpleEditorInput {
  constructor(readonly threadId: string) {
    super(undefined);
    this.addCapability(EditorInputCapabilities.CannotClose | EditorInputCapabilities.Singleton);
    this.setDescription("Pult");
    this.updateName();
    const unsubscribe = threadStore.subscribe(() => this.updateName());
    this._register({ dispose: unsubscribe });
  }

  private updateName(): void {
    const title = threadStore.get().threads.find((thread) => thread.id === this.threadId)?.title ?? "Thread";
    if (title !== this.getName()) this.setName(title);
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
