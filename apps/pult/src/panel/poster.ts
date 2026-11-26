// A row's poster as the panel names it, apart from the workbench so `node --test` suites can read it:
// a secret's or an extension row's, a Star's conversation or any other thread.
import type { RoutePoster } from "../stars/plugin.ts";
import { type Star, starName } from "../stars/stars.ts";

/** The rows the panel shows: a Star's only while Show Star is on, since opening one selects its Star. */
export const shownPosted = <Row extends { readonly poster: RoutePoster }>(
  rows: ReadonlyArray<Row>,
  starsShown: boolean,
): Row[] => rows.filter((row) => starsShown || !("star" in row.poster));

/**
 * How a row names its poster, from the page's own data: a Star by its name,
 * with its channel but its default one, "Star" for one the page does not
 * hold; a thread by its title, "A thread" for one it does not.
 */
export function posterName(
  row: { readonly environmentId: string; readonly poster: RoutePoster },
  starOf: (starId: string) => Pick<Star, "name" | "defaultChannel"> | undefined,
  threadTitle: (environmentId: string, threadId: string) => string | undefined,
): string {
  if ("thread" in row.poster)
    return threadTitle(row.environmentId, row.poster.thread) ?? "A thread";
  const star = starOf(row.poster.star);
  const name = star === undefined ? "Star" : starName(star);
  return row.poster.channel === star?.defaultChannel ? name : `${name} · ${row.poster.channel}`;
}
