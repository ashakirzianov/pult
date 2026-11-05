// The preview tabs' decisions (`pult/decisions`, `preview-tabs`), apart from
// the workbench so `node --test` runs them: which group a new tab goes to,
// whether closing a tab ends its session, and which tabs are stale.

/** Who controls a session's browser, as the view reads it (`view/preview.ts`). */
export type PreviewOwner = "agent" | "human" | "unclaimed";

/**
 * Whether closing a session's tab ends the session: a tab the user opened
 * and controls, or no one does, has no other keeper; an agent's is only
 * dismissed, its session living on, parked, until the agent closes it, the
 * user ends it (Close Browser Session) or the thread settles. A session the
 * view no longer knows has nothing to end.
 */
export function closingEndsSession(owner: PreviewOwner | undefined): boolean {
  return owner === "human" || owner === "unclaimed";
}

/**
 * The group a thread's new preview tab opens in: the one holding the thread's
 * preview tab shown or opened most recently, so later browsers land where the
 * user put the last one (Split Editor, a drag); else the thread tab's group;
 * else the active one. `seen` orders the tabs, larger later.
 */
export function placementGroup<Group>(
  previews: ReadonlyArray<{ readonly group: Group; readonly seen: number }>,
  leadGroup: Group | undefined,
  activeGroup: Group,
): Group {
  let latest: { readonly group: Group; readonly seen: number } | undefined;
  for (const preview of previews)
    if (latest === undefined || preview.seen > latest.seen) latest = preview;
  return latest?.group ?? leadGroup ?? activeGroup;
}

/**
 * How long a tab the page itself opened is kept against a list that lacks its
 * session: a list the server answered before the open can arrive after it,
 * and closing the tab then would lose it for good.
 */
export const JUST_OPENED_MS = 10_000;

/**
 * The open tabs, by session, to close for the thread's live sessions `live`:
 * every one whose session is not live, but a tab the page opened less than
 * `JUST_OPENED_MS` before `now`, which waits, and one whose session's close
 * the page has asked for and not heard back of (`closing`): the view drops
 * the session at once, and the tab closes with it once the server ends it,
 * or stays if the server refuses. A list not `loaded` yet (its thread's
 * first list not in, or its server's config, which says whether it has a
 * browser at all) lacks sessions that live, and closes nothing. `recheckAt`
 * is when the first waiting one stops waiting, for the caller to look again
 * then.
 */
export function staleTabs(input: {
  readonly open: ReadonlyArray<string>;
  readonly live: ReadonlyArray<string>;
  readonly openedAt: (tabId: string) => number | undefined;
  readonly closing?: (tabId: string) => boolean;
  readonly loaded?: boolean;
  readonly now: number;
}): { readonly close: ReadonlyArray<string>; readonly recheckAt: number | undefined } {
  if (input.loaded === false) return { close: [], recheckAt: undefined };
  const live = new Set(input.live);
  const close: string[] = [];
  let recheckAt: number | undefined;
  for (const tabId of input.open) {
    if (live.has(tabId) || input.closing?.(tabId) === true) continue;
    const openedAt = input.openedAt(tabId);
    const until = openedAt === undefined ? undefined : openedAt + JUST_OPENED_MS;
    if (until !== undefined && until > input.now) {
      recheckAt = recheckAt === undefined ? until : Math.min(recheckAt, until);
      continue;
    }
    close.push(tabId);
  }
  return { close, recheckAt };
}

/**
 * The sessions revealed while their thread was not the selection's, still to
 * open when it is next, less those no longer live: a list of the thread's
 * live sessions `live`, loaded, drops the rest.
 */
export function liveReveals(
  remembered: ReadonlySet<string>,
  live: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(live.filter((tabId) => remembered.has(tabId)));
}
