// The projects' drafts the shell remembers, for the left panel's cards: the
// composer store's, which the panel reaches through this module alone, so it
// need not load the whole view.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { composerDraftHasUserContent, type DraftId, useComposerDraftStore } from "../t3/src/composerDraftStore";

const DRAFT_KEY_PREFIX = "pult-shell.draft:";

/**
 * A project's draft is the composer store's, minted by upstream's new-thread
 * handler and remembered here per project, in the page's localStorage beside
 * the store's own, so a reload or a later New Thread takes up the same draft.
 */
export const draftKey = (environmentId: string, projectId: string) => `${DRAFT_KEY_PREFIX}${environmentId}/${projectId}`;

/** The project's remembered draft while the composer store still holds it. */
export function heldDraft(environmentId: string, projectId: string): DraftId | null {
  const draftId = localStorage.getItem(draftKey(environmentId, projectId)) as DraftId | null;
  const session = draftId === null ? null : useComposerDraftStore.getState().getDraftSession(draftId);
  return session !== null && session.projectId === projectId ? draftId : null;
}

/** A project's unsent draft, as its card shows it. */
export interface ProjectDraft {
  readonly environmentId: string;
  readonly projectId: string;
  /** The prompt's first line, its context references by their labels; or its attachments' count; or empty. */
  readonly preview: string;
  readonly createdAt: string;
}

type ComposerDraft = ReturnType<typeof useComposerDraftStore.getState>["draftsByThreadKey"][string];

/** Every project's remembered draft that holds something the user wrote or attached, newest first. */
function readDrafts(): ReadonlyArray<ProjectDraft> {
  const store = useComposerDraftStore.getState();
  const drafts: ProjectDraft[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key === null || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
    const [environmentId, projectId] = key.slice(DRAFT_KEY_PREFIX.length).split("/");
    if (environmentId === undefined || projectId === undefined) continue;
    const draftId = heldDraft(environmentId, projectId);
    if (draftId === null) continue;
    const session = store.getDraftSession(draftId);
    const composer = store.draftsByThreadKey[draftId];
    if (session === null || session.promotedTo != null || composer === undefined || !composerDraftHasUserContent(composer)) continue;
    drafts.push({ environmentId, projectId, preview: preview(composer), createdAt: session.createdAt });
  }
  return drafts.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function preview(composer: ComposerDraft): string {
  const line = replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label).trim().split("\n", 1)[0] ?? "";
  if (line.length > 0) return line;
  // `images` mirrors `persistedAttachments` once rehydrated, hence the larger of the two, as upstream counts.
  const attachments =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  return `${attachments} attachment${attachments === 1 ? "" : "s"}`;
}

let drafts: ReadonlyArray<ProjectDraft> = readDrafts();
const listeners = new Set<() => void>();

// One subscription for every card: the list is read again on each change of the store, and told only when it differs.
useComposerDraftStore.subscribe(() => {
  const next = readDrafts();
  if (JSON.stringify(next) === JSON.stringify(drafts)) return;
  drafts = next;
  for (const listener of listeners) listener();
});

/** The drafts for `useSyncExternalStore`: the same array until a card would change. */
export const projectDrafts = {
  get: () => drafts,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** A composer the shell shows: a thread's, or a project's draft's. */
export type ComposerTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string };

/** Whether the composer of a thread or of a project's draft holds anything the user wrote or attached, for the status strip's composer entry. */
export function composerHasContent(target: ComposerTarget): boolean {
  const key =
    target.kind === "thread"
      ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
      : heldDraft(target.environmentId, target.projectId);
  const composer = key === null ? null : useComposerDraftStore.getState().getComposerDraft(key);
  return composer !== null && composerDraftHasUserContent(composer);
}

/** Calls `listener` on every change of the composer store. */
export function onDidChangeComposers(listener: () => void): () => void {
  return useComposerDraftStore.subscribe(listener);
}
