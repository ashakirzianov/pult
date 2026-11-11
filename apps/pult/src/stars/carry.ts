// Unsent text carried into a sleeping Star's draft (xaxis
// `pult/design-durable-agent-sleep`, Unsent text), and out of it into the
// conversation someone else woke (`pult/issues/message-star.md`), apart from
// the workbench so `node --test src/stars/carry.test.ts` can run it. The
// server's plugin puts a Star to sleep whatever its composer holds, and wakes
// it for a message whatever its draft holds, so the page carries text typed
// under one into the composer the Star's tab then shows.

/** A composer as the carry reads it: whether it holds what the composer store's mover moves, text, images or files. */
export interface EndedComposer {
  readonly threadId: string;
  readonly settledAt: string;
  readonly holds: boolean;
}

/** What the carry does: move a conversation's composer into the draft, or tell of one it cannot move. */
export type Carry =
  | { readonly kind: "move"; readonly threadId: string }
  | { readonly kind: "stranded"; readonly threadId: string };

/**
 * What to carry into the draft a sleeping Star's tab shows, from the
 * composers of that home's ended conversations: the one that ended last of
 * those holding something, once the draft is in the composer store
 * (`draft` null until the tab mints it) and holds nothing, since the mover
 * puts the text in place of the draft's; one at a time, so a second waits
 * for the draft to empty. Stranded where the draft holds something already.
 */
export function carryInto(
  draft: { readonly holds: boolean } | null,
  ended: ReadonlyArray<EndedComposer>,
): Carry | undefined {
  if (draft === null) return undefined;
  const latest = ended
    .filter((composer) => composer.holds)
    .toSorted((left, right) => Date.parse(right.settledAt) - Date.parse(left.settledAt))[0];
  if (latest === undefined) return undefined;
  return { kind: draft.holds ? "stranded" : "move", threadId: latest.threadId };
}

/** A Star's draft in one of its homes, as the carry into its current conversation reads it. */
export interface WokenDraft {
  readonly environmentId: string;
  readonly projectId: string;
  readonly holds: boolean;
  /** Whether the draft created the current conversation: the user's own send, its text the conversation's. */
  readonly createsCurrent: boolean;
}

/** What the carry out of a draft does: move it into the current conversation's composer, or tell of one it cannot move. */
export type DraftCarry =
  | { readonly kind: "move"; readonly draft: WokenDraft }
  | { readonly kind: "stranded"; readonly draft: WokenDraft };

/**
 * What to carry out of an awake Star's drafts into its current
 * conversation's composer, a conversation someone else woke: a draft that
 * holds something and did not create it, since an awake Star's draft shows
 * nowhere; into a composer holding nothing, since the mover puts the text in
 * place of its own, one draft at a time. Stranded where the composer holds
 * something already.
 */
export function carryOutOf(
  current: { readonly holds: boolean },
  drafts: ReadonlyArray<WokenDraft>,
): DraftCarry | undefined {
  const draft = drafts.find((candidate) => candidate.holds && !candidate.createsCurrent);
  if (draft === undefined) return undefined;
  return { kind: current.holds ? "stranded" : "move", draft };
}
