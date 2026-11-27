// The reader: a project's HTML or Markdown file rendered in the file's own
// tab, Show Preview and Show Source switching the tab between it and the text
// editor in place. It reads the file's text model, unsaved edits included,
// and renders it with `render.ts`, which runs no script and loads nothing. Cite
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
  IThemeService,
  StandaloneServices,
  type IEditorGroup,
  type IInstantiationService,
} from "@codingame/monaco-vscode-api";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { isMacintosh } from "@codingame/monaco-vscode-api/vscode/vs/base/common/platform";
import { isCodeEditor } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser";
import { basename, isEqual } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resources";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import type { IEditorOptions } from "@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor";
import type { ServicesAccessor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation";
import {
  DEFAULT_EDITOR_ASSOCIATION,
  type IRevertOptions,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import { FILE_EDITOR_INPUT_ID } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/common/files";
import { ITextEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textEditorService.service";
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

import { COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS } from "@t3tools/contracts";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  resolvePathLinkTarget,
  splitFilePathPosition,
} from "@t3tools/shared/fileLinks";

import type { MountedReaderSelection } from "../../view/ReaderSelection.tsx";
import { keptRoot, onDidChangeKept } from "../changes/kept.ts";
import { stripTarget } from "../composer/index.tsx";
import { toHostPath, toUriPath } from "../files/paths.ts";
import { openDocumentFile } from "../threads/files.ts";
import { selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { threadView } from "../threads/pane.tsx";
import { ReaderFind } from "./find.ts";
import { frontmatterRefPath } from "./frontmatter.ts";
import { readImage } from "./images.ts";
import {
  type Chip,
  type Chips,
  createReaderFrame,
  followImageClicks,
  type ImageShown,
  type ReaderFrame,
} from "./render.ts";
import type { Passage } from "./selection.ts";

const READER_ID = "pult.shell.reader";
/** Cite's command (`src/composer/cite.ts`), which the reader's context menu runs with its capture. */
const CITE_SELECTION = "pult-shell.citeSelection";
const TEXT_FILE_EDITOR_ID = "workbench.editors.files.textFileEditor";

/** A project file the reader renders: a `pult:` file named `.html`, `.htm` or `.md`. */
const READABLE = ContextKeyExpr.and(
  ContextKeyExpr.equals("resourceScheme", "pult"),
  ContextKeyExpr.regex("resourceExtname", /^\.(?:html?|md)$/i),
);
const IN_SOURCE = ContextKeyExpr.and(
  READABLE,
  ContextKeyExpr.equals("activeEditor", TEXT_FILE_EDITOR_ID),
);
const IN_PREVIEW = ContextKeyExpr.equals("activeEditor", READER_ID);

const modelReference = async (file: URI) =>
  (await getService(ITextModelService)).createModelReference(file);

type TextModel = Awaited<ReturnType<ReaderInput["textModel"]>>;

/** The composer Cite would cite `file` into (`stripTarget`), as a capture compares it. */
const targetKey = (file: URI) => JSON.stringify(stripTarget(file.toString()));

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
  /** Whether the file is Markdown, else a page. */
  readonly markdown: boolean;
  /** Whether the scripts notice was closed in this tab. */
  noticeClosed = false;
  /** The images the file's paths name, by `src`, read once for the tab's life; one not shown is read again at the next render. */
  private readonly images = new Map<string, Promise<ImageShown>>();

  /**
   * `sourceIfEmpty`: an ordinary open's, whose pane hands an empty file, one
   * about to be written, to Source the first time it has the file's text.
   */
  constructor(
    readonly file: URI,
    public sourceIfEmpty = false,
  ) {
    super(file);
    this.markdown = /\.md$/i.test(file.path);
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

  /** The image `src` names in the file, as the frame shows it (`images.ts`). */
  readImage(src: string): Promise<ImageShown> {
    const known = this.images.get(src);
    if (known !== undefined) return known;
    const read = readImage(this.file, src);
    this.images.set(src, read);
    const forget = () => {
      if (this.images.get(src) === read) this.images.delete(src);
    };
    read.then((shown) => "refused" in shown && forget(), forget);
    return read;
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
 * the text model, and for Markdown the workbench's theme, while visible and
 * catches up when shown again. One frame per pane, so a switch back to the
 * same file keeps the reader's place.
 */
class ReaderPane extends SimpleEditorPane {
  private readonly frame: ReaderFrame = createReaderFrame({
    onDocument: (doc) => {
      doc.addEventListener("contextmenu", (event) => this.showContextMenu(event));
      doc.addEventListener("click", (event) => this.openChip(event));
      // An image opens in the thread view's lightbox, as a message's does.
      followImageClicks(
        doc,
        (images, index) => void threadView().then((view) => view.showImage(images, index)),
      );
      doc.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !this.find?.opened) return;
        event.preventDefault();
        this.find.hide();
      });
      // Focus inside the frame never reaches the workbench's own tracking, so its group is
      // activated here, and Cite reads this reader rather than another group's editor.
      doc.defaultView?.addEventListener("focus", () =>
        StandaloneServices.get(IEditorGroupsService).activateGroup(this.group),
      );
    },
    onRendered: (doc) => {
      this.followSelection(doc);
      this.find?.refresh();
    },
  });
  /** The find bar, made with the pane's element. */
  private find: ReaderFind | undefined;
  /** The thread's selection action on the frame's document, mounted on its first render. */
  private selectionAction:
    | { readonly doc: Document; readonly mounted: Promise<MountedReaderSelection> }
    | undefined;
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
    this.find = new ReaderFind(this.frame, element, () => this.focus());
    this._register(this.find);
    element.append(this.notice, this.frame.element, this.find.getDomNode());
    // The frame passes its chords to its element (`render.ts`), so they reach here from inside it too.
    element.addEventListener("keydown", (event) => this.findKey(event));
    return element;
  }

  /**
   * The find bar's keys, ahead of the workbench's keybindings, which the
   * reader's page has no editor for: Cmd+F opens it, with the page's
   * selection as its text; while it is open Cmd+G and Cmd+Shift+G, and Enter
   * and Shift+Enter in its input, go to the next and the previous match.
   */
  private findKey(event: KeyboardEvent): void {
    const find = this.find!;
    const chord = isMacintosh
      ? event.metaKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.toLowerCase();
    let act: () => void;
    if (chord && !event.shiftKey && key === "f") {
      const selected = this.frame.selection()?.text.replace(/\s+/g, " ").trim();
      act = () => find.open(selected === "" ? undefined : selected);
    } else if (find.opened && chord && key === "g") act = () => find.find(event.shiftKey);
    else if (
      find.opened &&
      event.key === "Enter" &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      find.getFindInputDomNode().contains(event.target as Node)
    )
      act = () => find.find(event.shiftKey);
    else return;
    event.preventDefault();
    event.stopPropagation();
    act();
  }

  async renderInput(input: EditorInput, options?: IEditorOptions) {
    if (!(input instanceof ReaderInput)) return { dispose: () => {} };
    const model = await input.textModel();
    // A Markdown file is drawn by the thread view's stylesheets, which come with the view.
    const view = input.markdown ? await threadView() : undefined;
    if (this.input !== input) return { dispose: () => {} };
    const sourceIfEmpty = input.sourceIfEmpty;
    input.sourceIfEmpty = false;
    if (sourceIfEmpty && model.getValueLength() === 0) {
      void StandaloneServices.get(IEditorService).replaceEditors(
        [
          {
            editor: input,
            replacement: {
              resource: input.file,
              options: {
                override: DEFAULT_EDITOR_ASSOCIATION.id,
                pinned: this.group.isPinned(input),
                preserveFocus: options?.preserveFocus,
              },
            },
            forceReplaceDirty: input.isDirty(),
          },
        ],
        this.group,
      );
      return { dispose: () => {} };
    }
    this.model = model;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const theme = () =>
      getComputedStyle(document.documentElement).colorScheme.includes("dark") ? "dark" : "light";
    const chips: Chips = (codes, values) => {
      const files = codes.flatMap((code) => {
        const candidate = view!.chipCandidate(code);
        if (candidate === null) return [];
        // A `~/` path from the home the document sits in, as the thread view reads one from its checkout.
        const path = candidate.startsWith("~/")
          ? resolvePathLinkTarget(candidate, toHostPath(input.file.path))
          : candidate;
        return [{ code, position: splitFilePathPosition(path) }];
      });
      // A frontmatter ref joined to the document's folder, its label the name it spells.
      const kept = keptRoot(input.file.authority);
      const refs = values.flatMap((value) => {
        const named = frontmatterRefPath(
          value,
          input.file.path,
          kept === null ? null : toUriPath(kept),
        );
        return named === undefined || view!.chipCandidate(named.file) === null
          ? []
          : [{ value, ...named }];
      });
      const suffixes = buildFileLinkParentSuffixByPath(files.map(({ position }) => position.path));
      const refSuffixes = buildFileLinkParentSuffixByPath(refs.map(({ named }) => named));
      // Drawn from the text alone: the click resolves it, a miss its menu.
      const drawn = { codes: new Map<string, Chip>(), refs: new Map<string, Chip>() };
      for (const { code, position } of files)
        drawn.codes.set(code, {
          markup: view!.readerChip(position.path, fileLinkLabel(position, suffixes), theme()),
          file: code,
        });
      for (const { value, named, file } of refs)
        drawn.refs.set(value, {
          markup: view!.readerChip(file, fileLinkLabel({ path: named }, refSuffixes), theme()),
          file,
        });
      return drawn;
    };
    const render = async () => {
      this.stale = false;
      const fresh = !isEqual(this.shown, input.file);
      this.shown = input.file;
      const version = model.getVersionId();
      const shown = await this.frame.show(model.getValue(), {
        fresh,
        markdown: input.markdown,
        wrapCode: view?.codeWrap() ?? false,
        readImage: (src) => input.readImage(src),
        ...(view === undefined ? {} : { chips }),
      });
      if (shown === undefined || this.input !== input) return;
      this.version = version;
      // A Markdown file's raw HTML is no page a browser tab would run.
      this.showNotice(input, !input.markdown && shown.scripts);
    };
    this.refresh = () => void render();
    const changed = () => {
      clearTimeout(timer);
      if (!this.isVisible()) this.stale = true;
      else timer = setTimeout(() => void render(), 150);
    };
    const changes = model.onDidChangeContent(changed);
    const stopWrap = view?.onDidChangeCodeWrap(changed);
    const themes = input.markdown
      ? StandaloneServices.get(IThemeService).onDidColorThemeChange(changed)
      : undefined;
    // A frontmatter ref is joined from the monore root once the kept checkout is known.
    const stopKept = input.markdown ? onDidChangeKept(changed) : undefined;
    await render();
    return {
      dispose: () => {
        this.find?.dismiss();
        clearTimeout(timer);
        changes.dispose();
        stopWrap?.();
        themes?.dispose();
        stopKept?.();
        this.refresh = undefined;
        this.model = undefined;
        this.version = undefined;
      },
    };
  }

  /** A file chip's click (`render.ts`, `chips`): its file opened as the thread view's chip opens one. */
  private openChip(event: MouseEvent): void {
    const target = event.target as Element | null;
    const code = target?.closest?.("[data-pult-file]")?.getAttribute("data-pult-file");
    const input = this.input;
    if (code === undefined || code === null || !(input instanceof ReaderInput)) return;
    void threadView().then(async (view) => {
      const candidate = view.chipCandidate(code);
      if (candidate === null) return;
      const { path, line, endLine } = splitFilePathPosition(candidate);
      const miss = await openDocumentFile(
        input.file.authority,
        input.file.path,
        path,
        line ?? null,
        endLine ?? null,
      );
      if (miss !== undefined) StandaloneServices.get(INotificationService).warn(miss);
    });
  }

  /** The page's selection now, read against the tab, the version shown and the composer; none before the page renders. */
  capture(): ReaderCapture | undefined {
    const input = this.input;
    if (!(input instanceof ReaderInput) || this.version === undefined) return undefined;
    return new ReaderCapture(
      this,
      input,
      this.version,
      targetKey(input.file),
      this.frame.selection(),
    );
  }

  /** The captured passage while its tab, its text and the composer are as they were, else why not. */
  passageOf(capture: ReaderCapture): ReaderPassage | string {
    if (this.input !== capture.input || !this.isVisible())
      return "The preview shows another file now. Select the passage again.";
    if (this.model?.getVersionId() !== capture.version || this.version !== capture.version)
      return "The page changed since the selection. Select the passage again.";
    if (targetKey(capture.input.file) !== capture.target)
      return "Another composer is in use since the selection. Select the passage again.";
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

  /**
   * The thread's "Type to cite" on the page's selection: it offers what Cite
   * would take, captured as it shows, while a composer is there to take it,
   * and cites through Cite, a typed key starting the comment.
   */
  private followSelection(doc: Document): void {
    if (this.selectionAction?.doc !== doc) {
      void this.selectionAction?.mounted.then((action) => action.dispose());
      const mounted = threadView().then((view) =>
        view.mountReaderSelection(this.frame.element, doc, {
          capture: () => {
            const capture = this.capture();
            const passage = capture?.passage;
            if (capture === undefined || passage?.lines === undefined) return undefined;
            if (stripTarget(capture.input.file.toString()) === null) return undefined;
            const tooLong = passage.text.length > COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS;
            return { capture, tooLong };
          },
          cite: (capture, comment) =>
            void StandaloneServices.get(ICommandService).executeCommand(
              CITE_SELECTION,
              capture,
              comment,
            ),
        }),
      );
      this.selectionAction = { doc, mounted };
    }
    void this.selectionAction.mounted.then((action) => action.update());
  }

  override dispose(): void {
    void this.selectionAction?.mounted.then((action) => action.dispose());
    super.dispose();
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

  /** The source line at the top of the page shown, none before it renders (`ReaderFrame.topLine`). */
  topLine(): number | undefined {
    return this.version === undefined ? undefined : this.frame.topLine();
  }

  /** Brings the page shown to the text of the source's `line` (`ReaderFrame.reveal`). */
  reveal(line: number): void {
    this.frame.reveal(line);
  }

  override focus(): void {
    this.frame.element.contentWindow?.focus();
  }

  override layout(dimension: Parameters<SimpleEditorPane["layout"]>[0]): void {
    super.layout(dimension);
    this.find?.layout(dimension.width);
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

/** The tab `group` holds of `file` in the reader or in Source, the active one first. */
function tabOf(group: IEditorGroup, file: URI) {
  const tabs = group.editors.filter(
    (tab) =>
      isEqual(tab.resource, file) &&
      (tab instanceof ReaderInput || tab.typeId === FILE_EDITOR_INPUT_ID),
  );
  return tabs.find((tab) => tab === group.activeEditor) ?? tabs[0];
}

/**
 * The reader's pane and input, its serialiser, so a working set restores a
 * reader tab as it restores a Source one, and its two places among the
 * editors a `.html`, `.htm` or `.md` project file opens in: an option, what
 * Open With, Show Preview and a reopened tab name by id, and, under the same
 * id so Open With lists one Preview, the default per extension, what an open
 * naming no editor gets. That one sends an open with a selection (a line
 * link, a search result, a jump) to Source, shows a tab the group already
 * holds of the file, so a tab left in Source stays the file's view there, and
 * opens the reader at once otherwise, which hands an empty file to Source
 * (`sourceIfEmpty`). Show Preview and Show Source switch the tab in place,
 * each a title action and in the palette. Registered before the workbench
 * starts.
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
    "*.{html,htm,md}",
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
  // An open naming the id takes the first registration of it, so these stay after the option
  // on globs of their own: `*.md` is the stock preview's, which can register before the reader.
  // One per extension, so Configure Default Editor writes the one file type it was asked for.
  for (const glob of ["**/*.html", "**/*.htm", "**/*.md"])
    registerEditor(
      glob,
      {
        id: READER_ID,
        label: "Preview",
        priority: {
          editor: RegisteredEditorPriority.default,
          diff: RegisteredEditorPriority.option,
          merge: RegisteredEditorPriority.option,
        },
      },
      { canSupportResource: (resource) => resource.scheme === "pult" },
      {
        createEditorInput: ({ resource, options }, group) => ({
          editor:
            options !== undefined && "selection" in options && options.selection !== undefined
              ? StandaloneServices.get(ITextEditorService).createTextEditor({ resource })
              : (tabOf(group, resource) ?? new ReaderInput(resource, true)),
        }),
      },
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
        // The page opens at the text editor's top line.
        const control = group.activeEditorPane?.getControl();
        const top = isCodeEditor(control)
          ? control.getVisibleRanges()[0]?.startLineNumber
          : undefined;
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
        // The group may show another tab by the time the reader has rendered.
        const reader = group.activeEditorPane;
        const shows = reader?.input instanceof ReaderInput && isEqual(reader.input.file, resource);
        if (top !== undefined && reader instanceof ReaderPane && shows) reader.reveal(top);
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
        // The text editor opens at the page's top line.
        const reader = group.activeEditorPane;
        const top = reader instanceof ReaderPane ? reader.topLine() : undefined;
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
        const control = group.activeEditorPane?.getControl();
        const shows = isEqual(group.activeEditor?.resource, editor.file);
        if (top !== undefined && isCodeEditor(control) && shows)
          control.setScrollTop(control.getTopForLineNumber(top));
      }
    },
  );
}
