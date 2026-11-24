import type * as Context from "effect/Context";

import type { ShellConnectionServices } from "./connectionRuntime.ts";

/**
 * What Pult's shell hands its in-process thread view (`main.tsx`): the
 * services of the page's connection runtime, which the view's state runtime
 * runs on, every environment's, where a thread the view navigates to opens,
 * where a project's new thread does, and where what the view would show in
 * its right panel goes instead (`rightPanel.ts`): a file, as a path relative
 * to the thread's checkout (its worktree, else its project's root) or an
 * absolute host path, with a line to reveal, or a citation's lines to select, which the shell looks up across
 * the environment's checkouts when the thread's lacks it; the thread's changes, with a file's path when one was named and a
 * turn's checkpoints when the view named a turn; and
 * what the view knows of its lineage's activity; and the preview browsers
 * the view would float or show in its panel, as tabs (`preview.ts`). Each names its
 * environment, as a pane mounts the view on one (`ThreadViewMounts`). It
 * also hands the colour scheme the view takes as the system's. The shell's
 * side is its `src/threads/pane.tsx`.
 */
export interface ThreadViewHost {
  readonly connection: () => Promise<Context.Context<ShellConnectionServices>>;
  readonly openThread: (environmentId: string, threadId: string) => void;
  /**
   * A new thread in the project, which the view went to (upstream's New
   * thread on branch, send and new): the shell selects the project's draft,
   * whose view takes up the draft the view remembered for the project.
   */
  readonly openDraft: (environmentId: string, projectId: string) => void;
  readonly openFile: (
    environmentId: string,
    threadId: string,
    path: string,
    line: number | null,
    endLine: number | null,
  ) => void;
  /**
   * Whether a file chip's path opens anything, as `openFile` would resolve it
   * (`src/files/linkable.ts`): the view's file link gate draws a chip known
   * not to as plain text (`fileLinkGate.tsx`).
   */
  readonly fileLinks: FileLinks;
  /** The thread's changes, a turn's when the view named one whose checkpoints it knows. */
  readonly openChanges: (
    environmentId: string,
    threadId: string,
    path: string | null,
    turn: TurnCheckpoints | null,
  ) => void;
  /**
   * A preview session's tab (`pult/decisions`, `preview-tabs`), mounting
   * `ThreadViewMounts.mountPreview`: opened if the thread has none for the
   * session, in the background unless `activate`; an open one activated when
   * `activate`, else left as it is. So an agent's reveal is `activate: false`
   * (a tab appears, focus stays), its forced reveal (the agent's explicit
   * open) and every user's way in `activate: true`, and an unforced reveal of
   * a session whose tab is open does nothing. A null `tabId` is a
   * placeholder for a session not opened yet, a New browser tab: the
   * thread's open placeholder, if any, is shown rather than a second opened.
   * `replacePlaceholder`: the placeholder's own pane opened the session (its
   * URL field or a local server), and the pane shows it already: the
   * thread's placeholder tab, if still open, becomes this session's in place,
   * its group, position and mount kept, rather than a second tab opening;
   * with none, as without it. Every other way in (upstream's `openBrowser`:
   * a link, a popup, a moved tab) opens its own tab. Never called for a device.
   */
  readonly openPreview: (
    environmentId: string,
    threadId: string,
    tabId: string | null,
    options: { readonly activate: boolean; readonly replacePlaceholder?: boolean },
  ) => void;
  /**
   * Every live preview session of the thread, on each change of them once
   * the thread's list has loaded: the thread's tabs for any other session
   * close, without asking, since their sessions ended; a session never gets
   * a tab from this.
   */
  readonly closeStalePreviews: (
    environmentId: string,
    threadId: string,
    liveTabIds: ReadonlyArray<string>,
  ) => void;
  /**
   * Whether threads of the mounted thread's lineage are working, as its
   * projection knows them: its subagents' from its roster, its own when it is
   * a provider's native subagent, whose work has no run the thread list sees;
   * with when the work started, when known.
   */
  readonly reportActivity: (
    activity: ReadonlyArray<{
      readonly threadId: string;
      readonly working: boolean;
      readonly workingSince: string | null;
    }>,
  ) => void;
  /**
   * The details cards over the active thread view (`src/details/`): which
   * view they float over and what they show, null while they are closed or
   * the active editor is no thread's view. The pane's view showing that
   * target renders them (`ThreadDetailsCard.tsx`).
   */
  readonly detailsCards: DetailsCardsValue;
  /**
   * The colour scheme the view's theme follows in its System mode, as the
   * system's: the workbench theme's, light or dark (`main.tsx`).
   */
  readonly colorScheme: () => "light" | "dark";
  /** Calls `listener` when `colorScheme` changes; returns its removal. */
  readonly onDidChangeColorScheme: (listener: () => void) => () => void;
  /**
   * Keeps the window compositing while hidden, or lets it throttle again
   * (`window.pultDesktop.keepRendering`), for the browser host's captures
   * (`browserHost.tsx`); absent outside Pult.app.
   */
  readonly keepRendering: ((keep: boolean) => Promise<void>) | undefined;
}

/** A file chip's path in its thread, as the view hands it to `openFile`. */
export interface FileLinkRef {
  readonly environmentId: string;
  readonly threadId: string;
  readonly path: string;
}

/** Whether file chips open anything: the shell's `src/files/linkable.ts`. */
export interface FileLinks {
  /** True while a click would open the file or offer a pick, false once known not to; undefined while unknown, drawn as a chip. */
  verdict(ref: FileLinkRef): boolean | undefined;
  /** Asks for the verdict, unless it is known or asked already. */
  ask(ref: FileLinkRef): void;
  /** Calls `listener` when the ref's verdict changes; returns its removal. */
  subscribe(ref: FileLinkRef, listener: () => void): () => void;
}

/** A thread view's target, as the details cards name it: a thread, or a project's draft. */
export type DetailsCardsTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | {
      readonly kind: "draft";
      readonly environmentId: string;
      readonly projectId: string;
      readonly tags?: ReadonlyArray<string>;
    };

/** The details cards while they show: the view they float over, and what they show. */
export interface DetailsCards {
  /** The active editor's thread view's target: a thread's, a draft's, a Star's conversation or draft, a Star's channel's or child's. */
  readonly view: DetailsCardsTarget;
  /** Beside a file, the grid cell that hosts the selected thread's rows. */
  readonly fileRows?: HTMLElement;
  /** The selected thread's or draft's details, upstream's rows, or the selected Star's, which the shell renders (`renderStar`). */
  readonly subject: DetailsCardsTarget | { readonly kind: "star"; readonly channel: string | null };
}

/** The details cards live, and the shell's renderer of a Star's. */
export interface DetailsCardsValue {
  get(): DetailsCards | null;
  subscribe(listener: () => void): () => void;
  /** Renders the selected Star's cards into `element`, an element of the view's the shell owns from then on; returns their removal. */
  renderStar(element: HTMLElement): () => void;
  /** Renders the right panel's tray into `element`, on the composer buttons' row; returns its removal. */
  renderTray(element: HTMLElement): () => void;
}

/**
 * A turn's diff, as `turnCheckpoints.ts` reads it from the thread's
 * projection: its number, the checkpoint refs before and after it, and its
 * files with their line counts.
 */
export interface TurnCheckpoints {
  readonly turnCount: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

let current: ThreadViewHost | undefined;
let resolveStarted: (host: ThreadViewHost) => void = () => {};
const started = new Promise<ThreadViewHost>((resolve) => {
  resolveStarted = resolve;
});

/** Set once, by `startThreadView`, before any view mounts. */
export function setThreadViewHost(host: ThreadViewHost): void {
  current = host;
  resolveStarted(host);
}

/**
 * The host once the shell has started the view. The view's modules read
 * state atoms as they load (upstream's theme, applied on import, reads the
 * environment's themes), which builds the connection runtime before the
 * shell can start the view; the runtime waits here rather than failing.
 */
export function threadViewHostStarted(): Promise<ThreadViewHost> {
  return started;
}

export function threadViewHost(): ThreadViewHost {
  if (current === undefined)
    throw new Error("The thread view mounted before the shell started it.");
  return current;
}
