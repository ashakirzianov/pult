import { getService, IContextKeyService, type IEditorGroup, IInstantiationService } from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { IMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions.service";
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

import { allowNativeScroll } from "../nativeScroll.ts";
import { colorSchemeChoice } from "./colorScheme.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import "./settings.css";

const PANE_ID = "pult.shell.settingsPane";

/**
 * The Pult settings page (`SettingsPage.tsx`), an editor pane the shell
 * renders itself, as the thread's is: a React root in the element the
 * editor group hands it. The workbench's menu and context key services, and
 * the colour scheme, are read as the pane shows its input, when the
 * workbench is up.
 */
class SettingsPane extends SimpleEditorPane {
  static readonly ID = PANE_ID;
  private root: Root | undefined;

  constructor(group: IEditorGroup) {
    super(SettingsPane.ID, group);
  }

  initialize(): HTMLElement {
    const element = document.createElement("div");
    element.className = "pult-settings-pane";
    // Focusable, as the group focuses its pane's element when the tab is activated, so Tab moves on into the page.
    element.tabIndex = -1;
    // The page is a native scroller.
    allowNativeScroll(element);
    return element;
  }

  async renderInput() {
    const [menus, contextKeys, colorScheme] = await Promise.all([
      getService(IMenuService),
      getService(IContextKeyService),
      colorSchemeChoice(),
    ]);
    this.root ??= createRoot(this.container);
    this.root.render(<SettingsPage menus={menus} contextKeys={contextKeys} colorScheme={colorScheme} />);
    // Disposed as the group clears the input: the page goes with its menu.
    return { dispose: () => this.release() };
  }

  override dispose(): void {
    this.release();
    super.dispose();
  }

  private release(): void {
    this.root?.unmount();
    this.root = undefined;
  }
}

/**
 * The Settings page's tab, "Settings" with VS Code's gear, a theme icon the
 * tab draws in its own colour, as it draws the stock settings editor's. The
 * Settings selection (`src/threads/selection.ts`) opens it leftmost in the
 * first group and keeps it there; closing it, and the stock editors beside
 * it, goes back to the thread or draft Settings was selected from. A
 * singleton: Split Editor skips it and a drag moves it rather than copies it.
 */
export class SettingsInput extends SimpleEditorInput {
  constructor() {
    super(undefined);
    this.addCapability(EditorInputCapabilities.Singleton);
    this.setName("Settings");
    this.setTitle("Pult Settings");
  }

  override getIcon() {
    return Codicon.settingsGear;
  }

  override get typeId(): string {
    return PANE_ID;
  }

  override matches(other: unknown): boolean {
    return other instanceof SettingsInput;
  }
}

/** Whether `editor` is the Settings page's tab. */
export function isSettingsTab(editor: unknown): editor is SettingsInput {
  return editor instanceof SettingsInput;
}

/**
 * The page's pane and its serialiser, so the Settings working set and the
 * editor part's saved state restore the page with the rest. Registered
 * before the workbench starts.
 */
export function registerSettingsPane(): void {
  registerEditorPane(PANE_ID, "Pult Settings", SettingsPane, [SettingsInput]);
  registerEditorSerializer(
    PANE_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(): string {
        return "{}";
      }
      deserialize(instantiation: IInstantiationService): EditorInput {
        return instantiation.createInstance(SettingsInput);
      }
    },
  );
}
