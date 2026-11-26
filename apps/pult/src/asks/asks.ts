// The asks as the page draws them (`model.ts`), apart from the workbench so
// `node --test src/panel/order.test.ts` and `src/stars/notices.test.ts` can
// run what reads them: their shelves and their posters' names.
import type { MessageHeader } from "@t3tools/contracts";

import type { AskStatus, RouteAsk } from "../stars/plugin.ts";
import { type Star, starName } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";

/** An ask of an environment's plugin, with the header its reply carries (`messageHeader.ts`). */
export interface PageAsk extends RouteAsk {
  readonly environmentId: string;
  readonly header: MessageHeader;
}

/** The shelf an ask's row sits on, by its status. */
export const ASK_SHELVES = {
  posted: "inbox",
  replied: "working",
  snoozed: "snoozed",
  settled: "settled",
} as const satisfies Record<AskStatus, string>;

/** The asks the panel shows: a Star's only while Show Star is on, since opening one selects its Star. */
export const shownAsks = <Ask extends Pick<PageAsk, "poster">>(
  asks: ReadonlyArray<Ask>,
  starsShown: boolean,
): Ask[] => asks.filter((ask) => starsShown || !("star" in ask.poster));

/** The asks on a shelf, in the order the model holds them. */
export const asksOn = <Ask extends Pick<PageAsk, "status">>(
  asks: ReadonlyArray<Ask>,
  shelf: (typeof ASK_SHELVES)[AskStatus],
): Ask[] => asks.filter((ask) => ASK_SHELVES[ask.status] === shelf);

/**
 * How a row names its poster, from the page's own data: a Star by its name,
 * with its channel but its default one, "Star" for one the page does not
 * hold; a thread by its title, "A thread" for one it does not.
 */
export function posterName(
  ask: Pick<PageAsk, "environmentId" | "poster">,
  starOf: (starId: string) => Pick<Star, "name" | "defaultChannel"> | undefined,
  threadTitle: (environmentId: string, threadId: string) => string | undefined,
): string {
  if ("thread" in ask.poster)
    return threadTitle(ask.environmentId, ask.poster.thread) ?? "A thread";
  const star = starOf(ask.poster.star);
  const name = star === undefined ? "Star" : starName(star);
  return ask.poster.channel === star?.defaultChannel ? name : `${name} · ${ask.poster.channel}`;
}

/**
 * Where a reply to the ask arrives, as its composer's line names it: the
 * poster as its row names it, and what the page tells of it. `open` is
 * whether a Star's channel has its conversation open on the ask's
 * environment, null for a thread's ask; `thread`, whether the reply goes into
 * a thread already there, which the name opens, rather than a sleeping
 * channel's draft.
 */
export function replyDestination(
  ask: Pick<PageAsk, "environmentId" | "poster">,
  starOf: (starId: string) => Pick<Star, "name" | "defaultChannel"> | undefined,
  threadOf: (
    environmentId: string,
    threadId: string,
  ) => Pick<ShellThread, "title" | "settled"> | undefined,
  open: boolean | null,
): { readonly name: string; readonly note: string | null; readonly thread: boolean } {
  const name = posterName(
    ask,
    starOf,
    (environmentId, threadId) => threadOf(environmentId, threadId)?.title,
  );
  if ("thread" in ask.poster) {
    if (open !== null) throw new Error("A thread's ask has no channel to be open or asleep.");
    const settled = threadOf(ask.environmentId, ask.poster.thread)?.settled === true;
    return { name, note: settled ? "settled, comes back with your reply" : null, thread: true };
  }
  if (open === null) throw new Error("A Star's ask needs whether its channel is open.");
  return open
    ? { name, note: "into its open conversation", thread: true }
    : { name, note: "asleep, wakes in a new conversation", thread: false };
}

/** An ask's row as the panel's order reads it (`src/panel/order.ts`). */
export const askRef = (ask: Pick<PageAsk, "environmentId" | "id" | "status">) => ({
  environmentId: ask.environmentId,
  id: ask.id,
  shelf: ASK_SHELVES[ask.status],
});
