// A preview session's workbench tab (`pult/decisions`, `preview-tabs`): the
// input naming the session, or a New browser's placeholder, and the pane
// mounting upstream's preview pane (`view/PreviewMount.tsx`) in it.
import {
  getService,
  ICommandService,
  type IEditorGroup,
  IInstantiationService,
} from "@codingame/monaco-vscode-api";
import type { Dimension } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/dom";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  type EditorInput,
  EditorInputCapabilities,
  type IEditorSerializer,
  registerEditorPane,
  registerEditorSerializer,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override/common";

import type { MountedPreview, PreviewSessionInfo } from "../../view/main.tsx";

import { allowNativeScroll } from "../nativeScroll.ts";
import { allowNativeTextMenu } from "../nativeTextMenu.ts";
import { threadView } from "../threads/pane.tsx";
import { followSessions } from "./sessions.ts";

const PANE_ID = "pult.shell.previewPane";

/** Orders the tabs by when they were last opened or shown, for where the next one goes (`placementGroup`). */
let seenCounter = 0;

/**
 * A preview session's tab, or with a null `tabId` a New browser's
 * placeholder, of a thread on an environment: the page's title, else its
 * host, else "Browser", as its name, its favicon, else a globe, as its icon,
 * "Browser" its description, and its URL in its title. A singleton, so
 * Split Editor leaves it where it is and a drag moves it rather than copies
 * it: two panes over one session would fight over its webview. Its label
 * follows the session as the view knows it, which it follows while it lives.
 */
export class PreviewInput extends SimpleEditorInput {
  /** The session the placeholder's pane opened, which the tab becomes in place (`tabs.ts`); the pane keeps its mount. */
  promotedTo: string | undefined;
  /** When the tab was last opened or shown, for `placementGroup`. */
  seen = ++seenCounter;
  private session: PreviewSessionInfo | undefined;

  constructor(
    readonly environmentId: string,
    readonly threadId: string,
    readonly tabId: string | null,
  ) {
    super(undefined);
    this.addCapability(EditorInputCapabilities.Singleton);
    this.setDescription("Browser");
    this.setName(tabId === null ? "New Browser" : "Browser");
    if (tabId !== null) {
      const stop = followSessions(environmentId, threadId, ({ sessions }) => {
        const session = sessions.find((each) => each.tabId === tabId);
        if (session === undefined) return;
        const changed =
          session.label !== this.session?.label ||
          session.url !== this.session?.url ||
          session.favicon !== this.session?.favicon;
        this.session = session;
        if (changed) this.setName(session.label);
      });
      this._register({ dispose: stop });
    }
  }

  /** Marks the tab as the thread's latest. */
  markSeen(): void {
    this.seen = ++seenCounter;
  }

  override getTitle(): string {
    const url = this.session?.url;
    return url === null || url === undefined ? this.getName() : `${this.getName()} (${url})`;
  }

  override getIcon() {
    const favicon = this.session?.favicon;
    return favicon === null || favicon === undefined ? Codicon.globe : URI.parse(favicon);
  }

  override get typeId(): string {
    return PANE_ID;
  }

  override matches(other: unknown): boolean {
    return (
      other instanceof PreviewInput &&
      other.environmentId === this.environmentId &&
      other.threadId === this.threadId &&
      other.tabId === this.tabId
    );
  }
}

/** Whether `editor` is a preview tab of the thread, any thread when none is named. */
export function isPreviewTab(
  editor: unknown,
  thread?: { readonly environmentId: string; readonly threadId: string },
): editor is PreviewInput {
  return (
    editor instanceof PreviewInput &&
    (thread === undefined ||
      (editor.environmentId === thread.environmentId && editor.threadId === thread.threadId))
  );
}

/**
 * The tab's pane: upstream's preview pane mounted in the element the group
 * hands it, the slot a natively hosted session's webview is placed over
 * (`view/browserHost.tsx`), or the server's stream, or a placeholder's empty
 * state. Hidden (its tab inactive, its group or the editor part hidden), the
 * mount parks its webview offscreen; a tab of another type in the group
 * clears the input, which unmounts it. A placeholder promoted to its session
 * keeps its mount, which already shows the session.
 */
class PreviewPane extends SimpleEditorPane {
  static readonly ID = PANE_ID;
  private mounted: { input: PreviewInput; readonly view: MountedPreview } | undefined;

  constructor(group: IEditorGroup) {
    super(PreviewPane.ID, group);
  }

  initialize(): HTMLElement {
    const element = document.createElement("div");
    element.className = "pult-preview-pane";
    // The stream and the empty state scroll natively.
    allowNativeScroll(element);
    // The URL field has the browser's menu, with its spelling suggestions.
    allowNativeTextMenu(element);
    return element;
  }

  async renderInput(input: EditorInput) {
    if (!(input instanceof PreviewInput)) return { dispose: () => {} };
    input.markSeen();
    const current = this.mounted;
    if (
      current !== undefined &&
      input.tabId !== null &&
      current.input.promotedTo === input.tabId &&
      current.input.environmentId === input.environmentId &&
      current.input.threadId === input.threadId
    ) {
      current.input = input;
    } else {
      this.release();
      try {
        const mounts = await threadView();
        if (this.input !== input) return { dispose: () => {} };
        const view = mounts.mountPreview(
          this.container,
          input.environmentId,
          input.threadId,
          input.tabId,
          {
            onEndSession: (tabId) =>
              void getService(ICommandService).then((commands) =>
                commands.executeCommand(
                  "pult-shell.closePreviewSession",
                  input.environmentId,
                  input.threadId,
                  tabId,
                ),
              ),
          },
        );
        view.setVisible(this.isVisible());
        this.mounted = { input, view };
      } catch (error) {
        console.error("[pult-shell] the thread view did not start", error);
        const message = document.createElement("div");
        message.className = "pult-thread-empty";
        message.textContent = error instanceof Error ? error.message : String(error);
        this.container.replaceChildren(message);
        return { dispose: () => message.remove() };
      }
    }
    const shown = this.mounted;
    return {
      // Disposed after the next input renders, or as the group clears this one.
      dispose: () => {
        if (this.mounted === shown && shown?.input === input) this.release();
      },
    };
  }

  override layout(dimension: Dimension): void {
    super.layout(dimension);
    // A group moved without resizing: the webview follows its slot.
    this.mounted?.view.layout();
  }

  override setVisible(visible: boolean): void {
    super.setVisible(visible);
    this.mounted?.view.setVisible(visible);
  }

  override dispose(): void {
    this.release();
    super.dispose();
  }

  private release(): void {
    const mounted = this.mounted;
    this.mounted = undefined;
    // The mount is a React root of its own, which cannot unmount while another renders.
    if (mounted !== undefined) queueMicrotask(() => mounted.view.dispose());
  }
}

interface SerializedPreviewInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId: string | null;
}

/**
 * The preview tab's pane and its serialiser, so the thread's working set
 * restores its preview tabs, which close at once if their session ended
 * (`tabs.ts`). Registered before the workbench starts.
 */
export function registerPreviewPane(): void {
  registerEditorPane(PANE_ID, "Pult Browser", PreviewPane, [PreviewInput]);
  registerEditorSerializer(
    PANE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: PreviewInput): string {
        return JSON.stringify({
          environmentId: editor.environmentId,
          threadId: editor.threadId,
          tabId: editor.tabId,
        } satisfies SerializedPreviewInput);
      }
      deserialize(
        instantiation: IInstantiationService,
        serialized: string,
      ): EditorInput | undefined {
        const { environmentId, threadId, tabId } = JSON.parse(serialized) as SerializedPreviewInput;
        return instantiation.createInstance(PreviewInput, environmentId, threadId, tabId);
      }
    },
  );
}
