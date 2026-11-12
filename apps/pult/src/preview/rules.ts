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

/** A thread, in its environment. */
interface PreviewThread {
  readonly environmentId: string;
  readonly threadId: string;
}

/**
 * The tab a thread's preview tabs belong beside, in the selection's tab set:
 * the lead tab for the selection's thread (the selected one, or the selected
 * Star's conversation in `user`); a tab open among a Star's for a channel's
 * conversation or a child of the Star's (`StarThreadInput`), so its browsers
 * open as `user`'s do; undefined for any other thread, whose reveal waits
 * until its thread is one of these, and whose tabs leave the part.
 */
export function previewAnchor<Tab extends PreviewThread>(
  thread: PreviewThread,
  selection: PreviewThread | undefined,
  starTabs: ReadonlyArray<Tab>,
): "lead" | Tab | undefined {
  const same = (other: PreviewThread) =>
    other.environmentId === thread.environmentId && other.threadId === thread.threadId;
  if (selection !== undefined && same(selection)) return "lead";
  return starTabs.find(same);
}

/**
 * The preview tabs that leave the part as foreign to the selection's tab
 * set: each whose thread has no anchor (`previewAnchor`). None while that
 * set is not known (a selected Star whose `user` is asleep or not read
 * yet), but those of `closed`, a Star's thread whose tab just closed, whose
 * browsers go with it whatever `user` does.
 */
export function foreignPreviews<Preview extends PreviewThread>(
  previews: ReadonlyArray<Preview>,
  anchored: (thread: PreviewThread) => boolean,
  { known, closed }: { readonly known: boolean; readonly closed?: PreviewThread },
): Preview[] {
  return previews.filter(
    (preview) =>
      !anchored(preview) &&
      (known ||
        (closed !== undefined &&
          preview.environmentId === closed.environmentId &&
          preview.threadId === closed.threadId)),
  );
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
 * Where in its group a thread's new preview tab opens: after the thread's
 * last browser there (`browsers`, their indexes), so they keep the order
 * they opened in; with none there, right after the Star's tab of a channel
 * or a child it belongs beside (`anchor`, its index, when in that group),
 * whichever tab is active; else undefined, the workbench's place, beside
 * the active tab.
 */
export function placementIndex(
  browsers: ReadonlyArray<number>,
  anchor: number | undefined,
): number | undefined {
  if (browsers.length > 0) return Math.max(...browsers) + 1;
  return anchor === undefined ? undefined : anchor + 1;
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
