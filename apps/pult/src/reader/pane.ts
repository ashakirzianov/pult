// The reader: a project's HTML file rendered in the file's own tab, Show
// Preview and Show Source switching the tab between it and the text editor
// in place. It reads the file's text model, unsaved edits included, and
// renders it with `render.ts`, which runs no script and loads nothing.
import {
  getService,
  IEditorGroupsService,
  IEditorService,
  INotificationService,
  ITextFileService,
  ITextModelService,
  type IEditorGroup,
  type IInstantiationService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { basename, isEqual } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import type { ServicesAccessor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation";
import { DEFAULT_EDITOR_ASSOCIATION } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import {
  type EditorInput,
  type IEditorSerializer,
  registerEditor,
  registerEditorPane,
  registerEditorSerializer,
  RegisteredEditorPriority,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override/common";

import { toHostPath } from "../files/paths.ts";
import { selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { threadView } from "../threads/pane.tsx";
import { createReaderFrame, type ReaderFrame } from "./render.ts";

const READER_ID = "pult.shell.reader";
const TEXT_FILE_EDITOR_ID = "workbench.editors.files.textFileEditor";

/** A project file the reader renders: a `pult:` file named `.html` or `.htm`. */
const READABLE = ContextKeyExpr.and(
  ContextKeyExpr.equals("resourceScheme", "pult"),
  ContextKeyExpr.regex("resourceExtname", /^\.html?$/i),
);
const IN_SOURCE = ContextKeyExpr.and(
  READABLE,
  ContextKeyExpr.equals("activeEditor", TEXT_FILE_EDITOR_ID),
);
const IN_PREVIEW = ContextKeyExpr.equals("activeEditor", READER_ID);

const modelReference = async (file: URI) =>
  (await getService(ITextModelService)).createModelReference(file);

/**
 * A file's reader tab: the file as its resource, so the tab, the explorer and
 * the editor's context keys see the file, and its text model held while the
 * tab lives, so unsaved edits and their undo outlive a switch to Source.
 */
class ReaderInput extends SimpleEditorInput {
  private model: ReturnType<typeof modelReference> | undefined;
  /** Whether the scripts notice was closed in this tab. */
  noticeClosed = false;

  constructor(readonly file: URI) {
    super(file);
    this.setName(basename(file));
    this.setTitle(`${basename(file)} (Preview)`);
    this.setDescription("Preview");
  }

  override get typeId(): string {
    return READER_ID;
  }

  /** The file's text model, unsaved edits included. */
  async textModel() {
    this.model ??= modelReference(this.file);
    return (await this.model).object.textEditorModel;
  }

  override matches(other: unknown): boolean {
    if (other instanceof ReaderInput) return isEqual(other.file, this.file);
    return super.matches(other as EditorInput);
  }

  override toUntyped() {
    return { resource: this.file, options: { override: READER_ID } };
  }

  override dispose(): void {
    void this.model?.then((reference) => reference.dispose());
    super.dispose();
  }
}

/**
 * The reader's pane: the scripts notice over the page's frame, which follows
 * the text model while visible and catches up when shown again. One frame
 * per pane, so a switch back to the same file keeps the reader's place.
 */
class ReaderPane extends SimpleEditorPane {
  private readonly frame: ReaderFrame = createReaderFrame();
  private readonly notice = document.createElement("div");
  private shown: URI | undefined;
  private refresh: (() => void) | undefined;
  private stale = false;

  constructor(group: IEditorGroup) {
    super(READER_ID, group);
  }

  initialize(): HTMLElement {
    const element = document.createElement("div");
    element.className = "pult-reader";
    this.notice.className = "pult-reader-notice";
    this.notice.hidden = true;
    element.append(this.notice, this.frame.element);
    return element;
  }

  async renderInput(input: EditorInput) {
    if (!(input instanceof ReaderInput)) return { dispose: () => {} };
    const model = await input.textModel();
    if (this.input !== input) return { dispose: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = async () => {
      this.stale = false;
      const fresh = !isEqual(this.shown, input.file);
      this.shown = input.file;
      const { scripts } = await this.frame.show(model.getValue(), { fresh });
      if (this.input === input) this.showNotice(input, scripts);
    };
    this.refresh = () => void render();
    const changes = model.onDidChangeContent(() => {
      clearTimeout(timer);
      if (!this.isVisible()) this.stale = true;
      else timer = setTimeout(() => void render(), 150);
    });
    await render();
    return {
      dispose: () => {
        clearTimeout(timer);
        changes.dispose();
        this.refresh = undefined;
      },
    };
  }

  /** Scripts are off here: the notice says so and opens the page in a browser tab, where they run, until closed. */
  private showNotice(input: ReaderInput, scripts: boolean): void {
    this.notice.hidden = !scripts || input.noticeClosed;
    if (this.notice.hidden) return this.notice.replaceChildren();
    const text = document.createElement("span");
    text.textContent = "Scripts don't run in this preview.";
    const open = document.createElement("a");
    open.href = "#";
    open.textContent = "Open in a browser tab";
    open.addEventListener("click", (event) => {
      event.preventDefault();
      void openInBrowser(input.file);
    });
    const close = document.createElement("a");
    close.href = "#";
    close.className = "pult-reader-notice-close codicon codicon-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", (event) => {
      event.preventDefault();
      input.noticeClosed = true;
      this.showNotice(input, false);
    });
    this.notice.replaceChildren(text, open, close);
  }

  override focus(): void {
    this.frame.element.contentWindow?.focus();
  }

  override setVisible(visible: boolean): void {
    super.setVisible(visible);
    if (visible && this.stale) this.refresh?.();
  }
}

/** Opens the file in a new browser tab of the selected thread, through the view's preview sessions, where its scripts run. */
async function openInBrowser(file: URI): Promise<void> {
  const notifications = await getService(INotificationService);
  const target = selectionTarget();
  if (target === undefined || !("threadId" in target))
    return void notifications.info("A browser tab opens beside a thread: select one first.");
  if (target.environmentId !== file.authority)
    return void notifications.info("This file is on another environment than the selected thread.");
  const thread = threadStore.thread(target.environmentId, target.threadId);
  const failure = await (
    await threadView()
  ).openFileInPreview(
    target.environmentId,
    target.threadId,
    toHostPath(file.path),
    thread?.checkoutRoot ?? undefined,
  );
  if (failure !== undefined)
    notifications.error(`The page did not open in a browser tab: ${failure}`);
}

/** The editor `context`'s group (a title action's), else the active group, and its active editor. */
async function activeEditor(context: unknown) {
  const groups = await getService(IEditorGroupsService);
  const groupId =
    typeof context === "object" && context !== null && "groupId" in context
      ? (context as { groupId: unknown }).groupId
      : undefined;
  const group =
    (typeof groupId === "number" ? groups.getGroup(groupId) : undefined) ?? groups.activeGroup;
  return { group, editor: group.activeEditor };
}

/**
 * The reader's pane and input, its serialiser, so a working set restores a
 * reader tab, and its place among the editors a `.html` or `.htm` project
 * file opens in, an option under Open With, never the default; and Show
 * Preview and Show Source, which switch the tab in place, each a title
 * action and in the palette. Registered before the workbench starts.
 */
export function registerReader(): void {
  registerEditorPane(READER_ID, "Pult Preview", ReaderPane, [ReaderInput]);
  registerEditorSerializer(
    READER_ID,
    class implements IEditorSerializer {
      canSerialize(): boolean {
        return true;
      }
      serialize(editor: ReaderInput): string {
        return editor.file.toString();
      }
      deserialize(_: IInstantiationService, serialized: string): EditorInput {
        return new ReaderInput(URI.parse(serialized));
      }
    },
  );
  registerEditor(
    "*.{html,htm}",
    {
      id: READER_ID,
      label: "Preview",
      priority: {
        editor: RegisteredEditorPriority.option,
        diff: RegisteredEditorPriority.option,
        merge: RegisteredEditorPriority.option,
      },
    },
    { singlePerResource: true, canSupportResource: (resource) => resource.scheme === "pult" },
    { createEditorInput: ({ resource }) => ({ editor: new ReaderInput(resource) }) },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.showPreview",
          title: { value: "Show Preview", original: "Show Preview" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.openPreview,
          f1: true,
          precondition: IN_SOURCE,
          menu: { id: MenuId.EditorTitle, when: IN_SOURCE, group: "navigation", order: 1 },
        });
      }

      async run(accessor: ServicesAccessor, _resource?: unknown, context?: unknown): Promise<void> {
        const editors = accessor.get(IEditorService);
        const files = accessor.get(ITextFileService);
        const { group, editor } = await activeEditor(context);
        const resource = editor?.resource;
        if (editor === null || resource === undefined) return;
        await editors.replaceEditors(
          [
            {
              editor,
              replacement: { resource, options: { override: READER_ID } },
              // The reader holds the model, so its unsaved edits stay without a prompt.
              forceReplaceDirty: files.isDirty(resource),
            },
          ],
          group,
        );
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.showSource",
          title: { value: "Show Source", original: "Show Source" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.goToFile,
          f1: true,
          precondition: IN_PREVIEW,
          menu: { id: MenuId.EditorTitle, when: IN_PREVIEW, group: "navigation", order: 1 },
        });
      }

      async run(accessor: ServicesAccessor, _resource?: unknown, context?: unknown): Promise<void> {
        const editors = accessor.get(IEditorService);
        const { group, editor } = await activeEditor(context);
        if (!(editor instanceof ReaderInput)) return;
        await editors.replaceEditors(
          [
            {
              editor,
              replacement: {
                resource: editor.file,
                options: { override: DEFAULT_EDITOR_ASSOCIATION.id },
              },
            },
          ],
          group,
        );
      }
    },
  );
}
