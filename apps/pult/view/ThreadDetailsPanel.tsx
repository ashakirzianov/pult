// Stands in for `apps/web`'s `src/components/chat/ThreadDetailsPanel.tsx` (`./stubs.ts`),
// upstream's thread details: the shell's details (`src/details/`), a thread's, a draft's or a
// Star's shelves, which it renders into an element of ours, float where upstream's inline card
// would, over the chat's top-right corner, from the pane's view alone and while that view is the
// active editor's; in a pane too narrow for their lane they overlay the conversation. The canvas
// clears its lane of them as of upstream's card. Upstream's rows and their "Choose what to show"
// are the fork's web app's alone (`pult/decisions`, `view-right-panel`).
import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  type ComponentProps,
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { EnvMode, EnvironmentOption } from "~/components/BranchToolbar.logic";
import type {
  NewProjectScriptInput,
  ProjectScriptActionResult,
} from "~/components/ProjectScriptsControl";
import { useChatCanvas } from "~/components/chat/ChatCanvasContext";
import type { ThreadDetailsCard } from "~/components/chat/ThreadDetailsCard";
import type * as Upstream from "~/components/chat/ThreadDetailsPanel";
import type { ThreadDetailsUsageInput } from "~/components/chat/ThreadDetailsUsage";
import {
  type ComposerThreadTarget,
  type DraftId,
  type DraftSessionState,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { DetailsModelPickers } from "./DetailsModelPicker.tsx";
import { detailsCardWidth } from "./detailsCardWidth.ts";
import { draftKey, isDraftOf } from "./drafts.ts";
import { type DetailsCards, type DetailsCardsTarget, threadViewHost } from "./host.ts";
import { setThreadPanelInline } from "./rightPanel.ts";
import type { ViewTarget } from "./ThreadView.tsx";

/** The composer strip's view, under a file, whose column the shell draws itself (`src/details/filePanel.tsx`). */
export const DetailsInFile = createContext(false);

export const DetailsTarget = createContext<ViewTarget | null>(null);

/** Upstream's panel's props, which the stub owns. */
interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  /** False when no worktree can come from this folder, so it offers no workspace modes. */
  offersWorkspaceModes: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  usage: ThreadDetailsUsageInput;
}

/** Whether A and B are one type: assignability both ways would miss an optional prop added or dropped. */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// A merge that changes upstream's panel's props fails the typecheck here, so the stub is read again.
true satisfies Exactly<ThreadDetailsPanelProps, ComponentProps<typeof Upstream.ThreadDetailsPanel>>;

/** Whether the view shows this thread or draft, including the channel tag that identifies a draft within a project. */
function isTarget(target: ViewTarget, shown: DetailsCardsTarget): boolean {
  if (shown.kind === "thread")
    return (
      target.kind === "thread" &&
      target.environmentId === shown.environmentId &&
      target.threadId === shown.threadId
    );
  return (
    target.kind === "draft" &&
    JSON.stringify(target.tags) === JSON.stringify(shown.tags) &&
    target.environmentId === shown.environmentId &&
    target.projectId === shown.projectId
  );
}

/**
 * Whether the frame is the cards' view's own: the view's target is that
 * view, and for a thread's or a draft's details the frame is the target's
 * own thread's, a draft's its draft session's, since while the view goes to
 * a new target the router still renders the previous one's.
 */
function showsCards(
  target: ViewTarget,
  threadRef: ScopedThreadRef,
  draft: { readonly id: DraftId; readonly session: DraftSessionState } | null,
  cards: DetailsCards,
): boolean {
  if (!isTarget(target, cards.view)) return false;
  const { subject } = cards;
  if (subject.kind === "star") return true;
  if (subject.kind === "thread")
    return (
      isTarget(target, subject) &&
      threadRef.environmentId === subject.environmentId &&
      threadRef.threadId === subject.threadId
    );
  return (
    isTarget(target, subject) &&
    target.kind === "draft" &&
    draft !== null &&
    // The pane's own draft, though its composer may have moved it to another environment's project (`ThreadView.tsx`).
    (isDraftOf(target, draft.session) ||
      localStorage.getItem(draftKey(target.environmentId, target.projectId, target.tags)) ===
        draft.id)
  );
}

/** The cards' left edge, an invisible handle dragging the panel's width, the same for every view. */
function DetailsCardResizer({
  width,
  right,
}: {
  readonly width: number;
  /** From the canvas's right edge, centred on the panel's left edge. */
  readonly right: number;
}) {
  const drag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly width: number;
    /** The last width the panel showed at. */
    readonly fits: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (drag.current !== null) drag.current = { ...drag.current, fits: width };
  }, [width]);
  // A move the canvas has no place for unmounts this handle and its capture: the drag ends at the last width that showed.
  useLayoutEffect(
    () => () => {
      if (drag.current === null) return;
      detailsCardWidth.set(drag.current.fits);
      detailsCardWidth.keep();
    },
    [],
  );
  return (
    <div
      aria-hidden
      className="pult-details-resizer"
      style={{ right }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, fits: width };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        detailsCardWidth.set(current.width + current.x - event.clientX);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        detailsCardWidth.keep();
      }}
    />
  );
}

/** The element the shell renders the right panel's tray into, on the composer buttons' row, as wide as the panel. */
function DetailsTrayHost({ width }: { readonly width: number | string }) {
  const { detailsCards } = threadViewHost();
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    return detailsCards.renderTray(element);
  }, [element, detailsCards]);
  return (
    <div ref={setElement} className="pult-details-island pult-details-tray" style={{ width }} />
  );
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const { environmentId, threadId } = props;
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const target = use(DetailsTarget);
  const inFile = use(DetailsInFile);
  const { detailsCards } = threadViewHost();
  const cards = useSyncExternalStore(detailsCards.subscribe, detailsCards.get);
  const canvas = useChatCanvas();
  const draftId = useComposerDraftStore((state) => state.getDraftIdByRef(threadRef));
  const session = useComposerDraftStore((state) =>
    draftId === null ? null : state.getDraftSession(draftId),
  );
  const draft = draftId === null || session === null ? null : { id: draftId, session };
  const shown =
    target !== null &&
    cards !== null &&
    inFile === (cards.file === true) &&
    showsCards(target, threadRef, draft, cards)
      ? cards
      : null;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const open = shown !== null && !inFile;
  // The canvas reads the card as open from the panel store, whose own toggles do nothing in the
  // shell (`rightPanel.ts`), so the pane's view writes it as the cards show; the composer strip's,
  // of the same thread, leaves it to the pane's.
  useLayoutEffect(() => {
    if (!inFile && target !== null && inlineOpen !== open) setThreadPanelInline(threadRef, open);
  }, [inFile, target, inlineOpen, open, threadRef]);
  const [island, setIsland] = useState<HTMLElement | null>(null);
  const star = shown?.subject.kind === "star";
  const measureDetailsCard = canvas?.measureDetailsCard;
  const width = canvas?.preferredDetailsCard?.width;
  // The panel occupies its column even when all of its shelves are in the tray.
  const height = canvas?.preferredDetailsCard?.height;
  useLayoutEffect(() => {
    if (!open || width === undefined || height === undefined) return;
    measureDetailsCard?.({
      threadRef: { environmentId, threadId },
      width,
      fullContentHeight: height,
    });
  }, [open, width, height, measureDetailsCard, environmentId, threadId]);
  useLayoutEffect(() => {
    if (island === null) return;
    return detailsCards.renderShelves(island);
  }, [island, detailsCards]);
  // Beside a file the shell draws the column itself.
  if (inFile) return null;
  const placement = canvas?.detailsCardPlacement ?? null;
  if (shown === null || canvas === null) return null;
  const overlay = placement === null;
  const panelWidth = placement?.width ?? `min(calc(100% - 24px), ${detailsCardWidth.get()}px)`;
  const panelHeight =
    placement === null ? undefined : `calc(${placement.height}px - var(--pult-bar-height))`;
  return (
    <>
      <aside
        className="absolute z-22 flex flex-col"
        style={{
          right: placement?.right ?? 12,
          top: placement?.y ?? 12,
          width: panelWidth,
          bottom: overlay ? "var(--pult-bar-height)" : undefined,
          maxHeight: panelHeight,
          height: panelHeight,
        }}
        data-thread-details-panel={overlay ? "overlay" : "inline"}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The shell's own: the view's stylesheet stops at it (`vite.config.ts`). */}
          <div ref={setIsland} className="pult-details-island pult-details-panel" />
        </div>
      </aside>
      {placement === null ? null : (
        <DetailsCardResizer width={placement.width} right={placement.right + placement.width - 3} />
      )}
      <DetailsTrayHost width={panelWidth} />
      {/* A Star's cards' model pickers, drawn from the view's tree into the shell's elements. */}
      {star ? <DetailsModelPickers /> : null}
    </>
  );
}
