// The reader: a project's HTML file rendered in the file's own tab, Show
// Preview and Show Source switching the tab between it and the text editor
// in place. It reads the file's text model, unsaved edits included, and
// renders it with `render.ts`, which runs no script and loads nothing. Cite
// (`src/composer/cite.ts`) takes a passage of it (`readerPassage`).
import {
  getService,
  IClipboardService,
  ICommandService,
  IEditorGroupsService,
  IEditorService,
  INotificationService,
  ITextFileService,
  ITextModelService,
  StandaloneServices,
  type IEditorGroup,
  type IInstantiationService,
} from "@codingame/monaco-vscode-api";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { basename, isEqual } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import type { ServicesAccessor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation";
import {
  DEFAULT_EDITOR_ASSOCIATION,
  type IRevertOptions,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import type { ITextFileSaveOptions } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textfiles";
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
import type { Passage } from "./selection.ts";

const READER_ID = "pult.shell.reader";
/** Cite's command (`src/composer/cite.ts`), which the reader's context menu runs with its capture. */
const CITE_SELECTION = "pult-shell.citeSelection";
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

type TextModel = Awaited<ReturnType<ReaderInput["textModel"]>>;

/** The selection's composer as a capture compares it. */
const targetKey = () => JSON.stringify(selectionTarget() ?? null);

/**
 * A reader's selection as Cite takes it, read against the tab it was made
 * in, the version of the file's text the page showed and the selection's
 * composer, so a change of any refuses it rather than cite stale lines.
 */
class ReaderCapture {
  constructor(
    readonly pane: ReaderPane,
    readonly input: ReaderInput,
    readonly version: number,
    readonly target: string,
    readonly passage: Passage | undefined,
  ) {}
}

/** A passage of a reader's page to cite: its file, the text as the page shows it, and the one-based, inclusive source lines it came from. */
export interface ReaderPassage {
  readonly file: URI;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * What Cite takes from a reader: the passage its context menu captured
 * (`captured`), else, when the active editor is a reader, its selection now;
 * a refusal in words when that no longer holds or holds nothing to cite.
 * Undefined when neither is a reader's, so Cite takes a text editor's lines:
 * a reader never falls back on another editor's selection.
 */
export function readerPassage(
  editors: IEditorService,
  captured: unknown,
): ReaderPassage | string | undefined {
  const pane = editors.activeEditorPane;
  const capture =
    captured instanceof ReaderCapture
      ? captured
      : pane instanceof ReaderPane
        ? pane.capture()
        : undefined;
  if (capture !== undefined) return capture.pane.passageOf(capture);
  return pane instanceof ReaderPane ? "The preview has not rendered yet." : undefined;
}

/**
 * A file's reader tab: the file as its resource, so the tab, the explorer and
 * the editor's context keys see the file, and its text model held while the
 * tab lives, so unsaved edits and their undo outlive a switch to Source. The
 * tab is dirty while the file is, and saves and reverts it, so closing it
 * asks as the file's own tab would. Made once the workbench is up.
 */
class ReaderInput extends SimpleEditorInput {
  private model: ReturnType<typeof modelReference> | undefined;
  private readonly files = StandaloneServices.get(ITextFileService);
  /** Whether the scripts notice was closed in this tab. */
  noticeClosed = false;

  constructor(readonly file: URI) {
    super(file);
    this.setName(basename(file));
    this.setTitle(`${basename(file)} (Preview)`);
    this.setDescription("Preview");
    this._register(
      this.files.files.onDidChangeDirty((model) => {
        if (isEqual(model.resource, this.file)) this._onDidChangeDirty.fire();
      }),
    );
  }

  override isDirty(): boolean {
    return this.files.isDirty(this.file);
  }

  override async save(_group: number, options?: ITextFileSaveOptions) {
    return (await this.files.save(this.file, options)) === undefined ? undefined : this;
  }

  override async revert(_group: number, options?: IRevertOptions): Promise<void> {
    await this.files.revert(this.file, options);
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
  private readonly frame: ReaderFrame = createReaderFrame({
    onDocument: (doc) => {
      doc.addEventListener("contextmenu", (event) => this.showContextMenu(event));
      // Focus inside the frame never reaches the workbench's own tracking, so its group is
      // activated here, and Cite reads this reader rather than another group's editor.
      doc.defaultView?.addEventListener("focus", () =>
        StandaloneServices.get(IEditorGroupsService).activateGroup(this.group),
      );
    },
  });
  private readonly notice = document.createElement("div");
  private shown: URI | undefined;
  private model: TextModel | undefined;
  /** The version of the model's text the frame shows. */
  private version: number | undefined;
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
    this.model = model;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = async () => {
      this.stale = false;
      const fresh = !isEqual(this.shown, input.file);
      this.shown = input.file;
      const version = model.getVersionId();
      const shown = await this.frame.show(model.getValue(), { fresh });
      if (shown === undefined || this.input !== input) return;
      this.version = version;
      this.showNotice(input, shown.scripts);
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
        this.model = undefined;
        this.version = undefined;
      },
    };
  }

  /** The page's selection now, read against the tab, the version shown and the composer; none before the page renders. */
  capture(): ReaderCapture | undefined {
    const input = this.input;
    if (!(input instanceof ReaderInput) || this.version === undefined) return undefined;
    return new ReaderCapture(this, input, this.version, targetKey(), this.frame.selection());
  }

  /** The captured passage while its tab, its text and the composer are as they were, else why not. */
  passageOf(capture: ReaderCapture): ReaderPassage | string {
    if (this.input !== capture.input || !this.isVisible())
      return "The preview shows another file now. Select the passage again.";
    if (this.model?.getVersionId() !== capture.version || this.version !== capture.version)
      return "The page changed since the selection. Select the passage again.";
    if (targetKey() !== capture.target)
      return "Another thread is selected since the selection. Select the passage again.";
    const { passage } = capture;
    if (passage === undefined) return "Select text in the preview to cite it.";
    if (passage.lines === undefined) return "The selection holds no text of the file.";
    const { start, end } = passage.lines;
    return { file: capture.input.file, text: passage.text, startLine: start, endLine: end };
  }

  /**
   * The page's selection's context menu, the workbench's: Cite, while a
   * thread or draft is selected, with the selection as it was when the menu
   * opened, and Copy. With nothing selected the browser's own, none in the
   * desktop.
   */
  private showContextMenu(event: MouseEvent): void {
    const capture = this.capture();
    if (capture?.passage === undefined) return;
    event.preventDefault();
    const { text } = capture.passage;
    const frame = this.frame.element.getBoundingClientRect();
    const anchor = { x: frame.left + event.clientX, y: frame.top + event.clientY };
    const cite = toAction({
      id: CITE_SELECTION,
      label: "Cite",
      run: () => StandaloneServices.get(ICommandService).executeCommand(CITE_SELECTION, capture),
    });
    const copy = toAction({
      id: "pult-shell.reader.copy",
      label: "Copy",
      run: () => StandaloneServices.get(IClipboardService).writeText(text),
    });
    StandaloneServices.get(IContextMenuService).showContextMenu({
      getAnchor: () => anchor,
      getActions: () => (selectionTarget() === undefined ? [copy] : [cite, copy]),
    });
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
              // The text editor takes the same model, so its unsaved edits stay without a prompt.
              forceReplaceDirty: editor.isDirty(),
            },
          ],
          group,
        );
      }
    },
  );
}
