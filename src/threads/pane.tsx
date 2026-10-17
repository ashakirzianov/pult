import { createInstance, type IEditorGroup, type IInstantiationService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import {
  type EditorInput,
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
 * Question 1 of the spike: an editor pane the shell renders itself, registered
 * below the extension API with the workbench's own `EditorPane` and
 * `EditorInput`. The pane mounts a React root in the element the editor group
 * hands it; the group handles tabs, splitting, drag and restore as for any
 * editor.
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

export class ThreadInput extends SimpleEditorInput {
  constructor(readonly threadId: string) {
    super(undefined);
    this.setName(threadStore.get().threads.find((thread) => thread.id === threadId)?.title ?? "Thread");
    this.setDescription("Pult");
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
  // Opens a thread in the shell's pane; the extension's menus could call it too.
  CommandsRegistry.registerCommand(
    "pult-shell.openThreadPane",
    async (accessor, threadId: string, column?: number) => {
      const input = await createInstance(ThreadInput, threadId);
      await accessor.get(IEditorService).openEditor(input, { pinned: true }, column);
    },
  );
}
