// The projects' drafts the shell remembers, and the threads whose composer
// holds an unsent message, for the left panel's cards and the Stars' carry of
// unsent text: the composer store's, which the panel reaches through this
// module alone, so it need not load the whole view.
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import {
  composerDraftHasUserContent,
  type DraftId,
  type DraftSessionState,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { newDraftId, newThreadId } from "~/lib/utils";

const DRAFT_KEY_PREFIX = "pult-shell.draft:";

/**
 * A project's draft is the composer store's, minted by upstream's new-thread
 * handler and remembered here per project, in the page's localStorage beside
 * the store's own, so a reload or a later New Thread takes up the same draft.
 * A tagged draft, whose thread is created with its tags (a Star channel's,
 * `pult:channel:<slug>`), is another draft of the project, one per tags,
 * minted here (`startTaggedDraft`) under its key as its logical project, so
 * upstream's handler never takes it for the project's.
 */
export const draftKey = (environmentId: string, projectId: string, tags?: ReadonlyArray<string>) =>
  `${DRAFT_KEY_PREFIX}${environmentId}/${projectId}${tags === undefined ? "" : `#${JSON.stringify(tags)}`}`;

/** Whether the draft is the one the target names: a tagged one by its key, the project's by its project and no tags. */
export function isDraftOf(
  target: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly tags?: ReadonlyArray<string>;
  },
  session: DraftSessionState,
): boolean {
  const key = draftKey(target.environmentId, target.projectId, target.tags);
  return target.tags === undefined
    ? !isTaggedDraft(session) &&
        session.projectId === target.projectId &&
        session.environmentId === target.environmentId
    : session.logicalProjectKey === key;
}

/** Whether the draft is a tagged one, minted by `startTaggedDraft`. */
export const isTaggedDraft = (session: DraftSessionState) =>
  session.logicalProjectKey.startsWith(DRAFT_KEY_PREFIX);

/** Mints the project's draft created with `tags`, remembered under its key; the composer store sets its model and modes as for any draft. */
export function startTaggedDraft(
  environmentId: string,
  projectId: string,
  tags: ReadonlyArray<string>,
): DraftId {
  const key = draftKey(environmentId, projectId, tags);
  const draftId = newDraftId();
  useComposerDraftStore.getState().setLogicalProjectDraftThreadId(
    key,
    scopeProjectRef(EnvironmentId.make(environmentId), ProjectId.make(projectId)),
    draftId,
    // Its thread is the channel's on this environment: load balancing never moves it.
    { threadId: newThreadId(), environmentSelection: "manual" },
  );
  localStorage.setItem(key, draftId);
  return draftId;
}

/** The project's remembered draft while the composer store still holds it, unsent: a sent one is its thread's, as upstream's new-thread handler reads it. */
export function heldDraft(
  environmentId: string,
  projectId: string,
  tags?: ReadonlyArray<string>,
): DraftId | null {
  const draftId = localStorage.getItem(draftKey(environmentId, projectId, tags)) as DraftId | null;
  const session =
    draftId === null ? null : useComposerDraftStore.getState().getDraftSession(draftId);
  return session !== null && session.projectId === projectId && session.promotedTo == null
    ? draftId
    : null;
}

/** Whether the project's remembered draft is being sent: its thread asked for, not yet created, its send not yet failed. */
export function draftSending(
  environmentId: string,
  projectId: string,
  tags?: ReadonlyArray<string>,
): boolean {
  const draftId = localStorage.getItem(draftKey(environmentId, projectId, tags)) as DraftId | null;
  return (
    draftId !== null &&
    useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo != null
  );
}

/** Whether the server thread the view went to is the one the project's draft created, on the draft's environment or another. */
export function isPromotion(
  draft: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly tags?: ReadonlyArray<string>;
  },
  environmentId: string,
  threadId: string,
): boolean {
  const draftId = localStorage.getItem(
    draftKey(draft.environmentId, draft.projectId, draft.tags),
  ) as DraftId | null;
  if (draftId === null) return false;
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  const redirect = store.getPromotedDraftRedirect(draftId);
  return (
    // Finalized, the draft is gone from the store but for the redirect its route follows.
    (redirect?.environmentId === environmentId && redirect.threadId === threadId) ||
    session?.threadId === threadId ||
    session?.promotedTo?.threadId === threadId ||
    store.getDraftIdByRef(
      scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
    ) === draftId
  );
}

/** A project's unsent draft, as its card shows it; a tagged one, which has no card, with its tags. */
export interface ProjectDraft {
  readonly environmentId: string;
  readonly projectId: string;
  readonly tags?: ReadonlyArray<string>;
  /** The prompt's first line, its context references by their labels; or its attachments' count; or empty. */
  readonly preview: string;
  readonly createdAt: string;
}

type ComposerDraft = ReturnType<typeof useComposerDraftStore.getState>["draftsByThreadKey"][string];

/** Every project's remembered draft that holds something the user wrote or attached, its tagged ones too, newest first. */
function readDrafts(): ReadonlyArray<ProjectDraft> {
  const store = useComposerDraftStore.getState();
  const drafts: ProjectDraft[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key === null || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
    // A tagged draft's tags follow its project after a `#` (`draftKey`).
    const [project = "", tagged] = key.slice(DRAFT_KEY_PREFIX.length).split(/#(.*)/s);
    const [environmentId, projectId] = project.split("/");
    if (environmentId === undefined || projectId === undefined) continue;
    const tags = tagged === undefined ? undefined : (JSON.parse(tagged) as ReadonlyArray<string>);
    const draftId = heldDraft(environmentId, projectId, tags);
    if (draftId === null) continue;
    const session = store.getDraftSession(draftId);
    const composer = store.draftsByThreadKey[draftId];
    if (
      session === null ||
      session.promotedTo != null ||
      composer === undefined ||
      !composerDraftHasUserContent(composer)
    )
      continue;
    drafts.push({
      environmentId,
      projectId,
      ...(tags === undefined ? {} : { tags }),
      preview: preview(composer),
      createdAt: session.createdAt,
    });
  }
  return drafts.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function preview(composer: ComposerDraft): string {
  const line =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
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

/** The threads whose composer holds something the user wrote or attached, keyed `<environmentId>/<threadId>` as the shell's store keys them. */
function readUnsentThreads(): ReadonlyArray<string> {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  const keys: string[] = [];
  for (const [key, composer] of Object.entries(draftsByThreadKey)) {
    // A thread's composer is under its scoped key, `<environmentId>:<threadId>`; a draft's under its draft id, which parses as none or, a queued run's edit, as no thread a card shows.
    const thread = parseScopedThreadKey(key);
    if (thread !== null && composerDraftHasUserContent(composer))
      keys.push(`${thread.environmentId}/${thread.threadId}`);
  }
  return keys.toSorted();
}

let drafts: ReadonlyArray<ProjectDraft> = readDrafts();
let unsentThreads: ReadonlySet<string> = new Set(readUnsentThreads());
const listeners = new Set<() => void>();
const unsentListeners = new Set<() => void>();

// One subscription for every card: the lists are read again on each change of the store, and told only when they differ.
useComposerDraftStore.subscribe(() => {
  const next = readDrafts();
  if (JSON.stringify(next) !== JSON.stringify(drafts)) {
    drafts = next;
    for (const listener of listeners) listener();
  }
  const unsent = readUnsentThreads();
  if (unsent.length !== unsentThreads.size || unsent.some((key) => !unsentThreads.has(key))) {
    unsentThreads = new Set(unsent);
    for (const listener of unsentListeners) listener();
  }
});

/** The threads with an unsent message for `useSyncExternalStore`: the same set until one is added or gone. */
export const threadsWithUnsentMessages = {
  get: () => unsentThreads,
  subscribe(listener: () => void): () => void {
    unsentListeners.add(listener);
    return () => {
      unsentListeners.delete(listener);
    };
  },
};

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

/** A composer the shell shows: a thread's, or a project's draft's, its own or a tagged one (`draftKey`). */
export type ComposerTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | {
      readonly kind: "draft";
      readonly environmentId: string;
      readonly projectId: string;
      readonly tags?: ReadonlyArray<string>;
    };

/** The composer store's key for a thread's composer, or a project's draft's while the store holds it. */
export function composerKey(target: ComposerTarget) {
  return target.kind === "thread"
    ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
    : heldDraft(target.environmentId, target.projectId, target.tags);
}

/** Whether the composer of a thread or of a project's draft holds anything the user wrote or attached, for the status strip's composer entry. */
export function composerHasContent(target: ComposerTarget): boolean {
  const key = composerKey(target);
  const composer = key === null ? null : useComposerDraftStore.getState().getComposerDraft(key);
  return composer !== null && composerDraftHasUserContent(composer);
}

/**
 * Whether the composer holds what a Star's carry moves it for, text (its
 * context references aside), images or files; null for a project's draft
 * the store does not hold.
 */
export function composerHoldsText(target: ComposerTarget): boolean | null {
  const key = composerKey(target);
  if (key === null) return null;
  const composer = useComposerDraftStore.getState().getComposerDraft(key);
  return (
    composer !== null &&
    (replaceComposerContextReferences(composer.prompt, () => "").trim().length > 0 ||
      composer.images.length > 0 ||
      composer.files.length > 0)
  );
}

/** Moves all a composer holds, text, attachments, contexts, annotations and review comments, into another's that holds nothing, by the store's mover; into one holding anything, it moves nothing. */
export function moveComposerText(from: ComposerTarget, to: ComposerTarget): void {
  const fromKey = composerKey(from);
  const toKey = composerKey(to);
  if (fromKey === null || toKey === null)
    throw new Error("A project's draft the composer store does not hold has nothing to move.");
  useComposerDraftStore.getState().moveComposerContent(fromKey, toKey);
}

/** Calls `listener` on every change of the composer store. */
export function onDidChangeComposers(listener: () => void): () => void {
  return useComposerDraftStore.subscribe(listener);
}
