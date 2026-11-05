import { getService, ILifecycleService } from "@codingame/monaco-vscode-api";
import { isMacintosh } from "@codingame/monaco-vscode-api/vscode/vs/base/common/platform";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { LifecyclePhase } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/lifecycle/common/lifecycle";

import { starStore } from "../stars/model.ts";
import { starEnabled } from "../stars/settings.ts";
import {
  explorerSelected,
  onDidSelectThread,
  openExplorerFiles,
  selectDraft,
  selectedDraft,
  selectedStar,
  selectedThread,
  selectStar,
  selectThread,
  showExplorerFile,
} from "../threads/selection.ts";
import { isSubagent, scopedKey, threadStore } from "../threads/store.ts";
import { storedExpanded } from "./collapsible.tsx";
import { isStarDraft, projectDrafts } from "./drafts.ts";
import { exploredEnvironment } from "./explorer.ts";
import {
  draftCards,
  draftKey,
  environmentKey,
  jumpTargets,
  type JumpTarget,
  SETTLED_TAIL_INITIAL_COUNT,
  starKey,
} from "./order.ts";

/** What the editor part shows, as a stable snapshot: a thread's key, a project's draft's (`draftKey`), a Star's (`starKey`), `explorer` for the Explorer workspace, or nothing. */
export function selectionSnapshot(): string | undefined {
  if (explorerSelected()) return "explorer";
  const star = selectedStar();
  if (star !== undefined) return starKey(star);
  const draft = selectedDraft();
  if (draft !== undefined) return draftKey(draft);
  const thread = selectedThread();
  return thread && scopedKey(thread.environmentId, thread.threadId);
}

/** The key of the card the selection expands: the selected thread's own, or for a subagent its root's; a draft's. */
function selectedCardKey(): string | undefined {
  const selection = selectedThread();
  const thread = selection && threadStore.thread(selection.environmentId, selection.threadId);
  if (thread !== undefined && isSubagent(thread))
    return scopedKey(thread.environmentId, thread.rootId);
  return selectionSnapshot();
}

/** The key of the Explorer shelf's highlighted row: while the workspace is selected, its active file's, or with none listed the environment's explored. */
export function explorerHighlight(): string | undefined {
  if (!explorerSelected()) return undefined;
  const { files, active } = openExplorerFiles.get();
  const activeFile =
    active !== undefined ? files.find((file) => file.toString() === active.toString()) : undefined;
  const explored = exploredEnvironment.get();
  return activeFile?.toString() ?? (explored !== undefined ? environmentKey(explored) : undefined);
}

/** Where each shelf keeps whether it is expanded (`useExpanded`). */
export const EXPANDED_KEYS = {
  explorer: "pult-shell.panel.explorer-expanded",
  ready: "pult-shell.panel.ready-expanded",
  working: "pult-shell.panel.working-expanded",
  snoozed: "pult-shell.panel.snoozed-expanded",
  settled: "pult-shell.panel.settled-expanded",
} as const;

let settledCount = SETTLED_TAIL_INITIAL_COUNT;

/** Tells the jumps how many settled threads the settled shelf's tail shows, back to its first page when it unmounts. */
export function showingSettled(count: number): void {
  settledCount = count;
}

/** The panel's rows Cmd+1 to Cmd+9 reach, read from the stores the panel renders, whether or not it shows. */
function currentTargets(): JumpTarget<URI>[] {
  const { environments, threads } = threadStore.get();
  const environmentIds = environments.map((environment) => environment.id);
  return jumpTargets({
    stars: starEnabled.get() ? starStore.get().map((star) => star.id) : [],
    environmentIds,
    explorer: {
      files: openExplorerFiles.get().files,
      highlighted: explorerHighlight(),
      expanded: storedExpanded(EXPANDED_KEYS.explorer, true),
    },
    drafts: draftCards(projectDrafts.get(), selectedDraft(), new Set(environmentIds), isStarDraft),
    threads,
    selection: selectedCardKey(),
    expanded: {
      ready: storedExpanded(EXPANDED_KEYS.ready, true),
      working: storedExpanded(EXPANDED_KEYS.working),
      snoozed: storedExpanded(EXPANDED_KEYS.snoozed),
      settled: storedExpanded(EXPANDED_KEYS.settled),
    },
    settledCount,
  });
}

const JUMPS = 9;
const jumpCommand = (index: number) => `pult-shell.jump.${index + 1}`;
/** The jump modifier: Cmd on the Mac, Ctrl elsewhere, as upstream's `mod`. */
const isJumpModifier = (event: KeyboardEvent) =>
  (isMacintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey;
const jumpLabel = (index: number) => `${isMacintosh ? "⌘" : "Ctrl+"}${index + 1}`;

/** How long the jump modifier is held alone before the hints show, as upstream's. */
const HINT_DELAY_MS = 200;

let labels: ReadonlyMap<string, string> = new Map();
const hintListeners = new Set<() => void>();
let hintsShown = false;

/** The jump hints, each reachable row's shortcut by its key, while the jump modifier is held alone; empty otherwise. */
export const jumpHints = {
  get: () => labels,
  subscribe(listener: () => void): () => void {
    hintListeners.add(listener);
    return () => hintListeners.delete(listener);
  },
};

function refreshHints(): void {
  if (!hintsShown && labels.size === 0) return;
  labels = hintsShown
    ? new Map(
        currentTargets()
          .slice(0, JUMPS)
          .map((target, index) => [target.key, jumpLabel(index)] as const),
      )
    : new Map();
  for (const listener of hintListeners) listener();
}

/**
 * The keys themselves, on the page's own listener rather than the
 * workbench's keybindings: the workbench drops every Cmd+digit binding
 * outside full screen as a browser's (`_assertBrowserConflicts`), the
 * desktop wrapper's page included. And upstream's hints: holding the
 * modifier alone for a moment labels the rows it reaches; another modifier,
 * letting go, or the window losing focus takes them away. The hints show in
 * the desktop wrapper only, as upstream's jumps are desktop-only: a browser
 * tab keeps Cmd+1 to Cmd+9 for its own tabs, so they would promise what the
 * keys cannot do there.
 */
function followJumpKeys(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hold = (held: boolean) => {
    if (held === (hintsShown || timer !== undefined)) return;
    clearTimeout(timer);
    timer = undefined;
    if (held) {
      timer = setTimeout(() => {
        timer = undefined;
        hintsShown = true;
        refreshHints();
      }, HINT_DELAY_MS);
    } else {
      hintsShown = false;
      refreshHints();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    hold(window.pultDesktop !== undefined && isJumpModifier(event));
    const digit =
      event.type === "keydown" && isJumpModifier(event)
        ? /^Digit([1-9])$/.exec(event.code)?.[1]
        : undefined;
    if (digit === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void jump(currentTargets()[Number(digit) - 1]);
  };
  // Capturing on the window, ahead of the workbench and the thread view, which stop some keys.
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", () => hold(false));
  // The rows move under the hints as a jump selects, a shelf changes or a draft fills.
  threadStore.subscribe(refreshHints);
  onDidSelectThread(refreshHints);
  openExplorerFiles.subscribe(refreshHints);
  starStore.subscribe(refreshHints);
  starEnabled.subscribe(refreshHints);
}

function jump(target: JumpTarget<URI> | undefined): Promise<void> {
  switch (target?.kind) {
    case undefined:
      return Promise.resolve();
    case "star":
      return selectStar(target.starId);
    case "file":
      return showExplorerFile(target.file);
    case "draft":
      return selectDraft(target.draft.environmentId, target.draft.projectId);
    case "thread":
      return selectThread(target.thread.environmentId, target.thread.id);
  }
}

/**
 * Cmd+1 to Cmd+9 (Ctrl off the Mac), upstream's thread jumps: the left
 * panel's Nth row (`jumpTargets`), a Star, an Explorer file, a draft or a thread,
 * whether or not the panel shows (`followJumpKeys`). Each is a command too,
 * `pult-shell.jump.1` to `.9`, for another binding; not in the palette,
 * where Pult: Open Thread… is. Registered before the workbench starts.
 */
export function registerJumps(): void {
  for (let index = 0; index < JUMPS; index++) {
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: jumpCommand(index),
            title: {
              value: `Jump to Panel Row ${index + 1}`,
              original: `Jump to Panel Row ${index + 1}`,
            },
            category: { value: "Pult", original: "Pult" },
          });
        }

        run(): Promise<void> {
          return jump(currentTargets()[index]);
        }
      },
    );
  }
  followJumpKeys();
  void (async () => {
    // The drafts load with the thread view's stores, which break the workbench's start when they load before it; the panel's cards load them too.
    await (await getService(ILifecycleService)).when(LifecyclePhase.Restored);
    projectDrafts.subscribe(refreshHints);
  })();
}
