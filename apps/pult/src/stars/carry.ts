// Unsent text carried into a sleeping Star's draft (xaxis
// `pult/design-durable-agent-sleep`, Unsent text), apart from the workbench
// so `node --test src/stars/carry.test.ts` can run it. The server's plugin
// puts a Star to sleep whatever its composer holds, so the page carries text
// typed under its conversation into the draft the Star's tab then shows.

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
