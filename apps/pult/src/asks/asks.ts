// The asks as the page draws them (`model.ts`), apart from the workbench so
// `node --test src/panel/order.test.ts` and `src/stars/notices.test.ts` can
// run what reads them: their shelves and their posters' names.
import type { AskStatus, RouteAsk } from "../stars/plugin.ts";

/** An ask of an environment's plugin, with the line its reply opens with. */
export interface PageAsk extends RouteAsk {
  readonly environmentId: string;
  readonly prefix: string;
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
 * with its channel but `user`'s, "Star" for one the page does not hold; a
 * thread by its title, "A thread" for one it does not.
 */
export function posterName(
  ask: Pick<PageAsk, "environmentId" | "poster">,
  starName: (starId: string) => string | undefined,
  threadTitle: (environmentId: string, threadId: string) => string | undefined,
): string {
  if ("thread" in ask.poster)
    return threadTitle(ask.environmentId, ask.poster.thread) ?? "A thread";
  const name = starName(ask.poster.star) ?? "Star";
  return ask.poster.channel === "user" ? name : `${name} · ${ask.poster.channel}`;
}

/** An ask's row as the panel's order reads it (`src/panel/order.ts`). */
export const askRef = (ask: Pick<PageAsk, "environmentId" | "id" | "status">) => ({
  environmentId: ask.environmentId,
  id: ask.id,
  shelf: ASK_SHELVES[ask.status],
});
