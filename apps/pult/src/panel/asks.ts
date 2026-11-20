// Which of Inbox's ask rows is expanded (`AskRows.tsx`): page UI state,
// one ask at a time, kept nowhere, no working set or conversation of its own.
import { starStore } from "../stars/model.ts";
import { openAsks } from "../stars/stars.ts";
import { askKey, type AskRef } from "./order.ts";
import { openShelf } from "./shelves.tsx";

/** The expanded ask, by its key (`askKey`), and how many times a row was revealed, so the row scrolls into view once for each. */
interface Expansion {
  readonly key: string | undefined;
  readonly revealed: number;
}

let expansion: Expansion = { key: undefined, revealed: 0 };
const listeners = new Set<() => void>();

function update(next: Expansion): void {
  if (next.key === expansion.key && next.revealed === expansion.revealed) return;
  expansion = next;
  for (const listener of listeners) listener();
}

export const askExpansion = {
  get: () => expansion,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The ask's row expanded, or closed while it was. */
export function toggleAsk(ask: AskRef): void {
  update({ ...expansion, key: expansion.key === askKey(ask) ? undefined : askKey(ask) });
}

/** The expanded row closed. */
export function closeAsk(): void {
  update({ ...expansion, key: undefined });
}

/**
 * The ask's row expanded and brought into view, Inbox opened first if it
 * was closed, the other rows left as they are: the card's badge's, Open
 * Star Ask's and a notification's.
 */
export function revealAsk(ask: AskRef): void {
  openShelf("inbox");
  update({ key: askKey(ask), revealed: expansion.revealed + 1 });
}

// An ask gone, its Star deleting its file, takes its expansion with it, so one written again under its name comes back closed.
starStore.subscribe(() => {
  if (expansion.key === undefined) return;
  const live = openAsks(starStore.get()).some(
    ({ star, ask }) => askKey({ starId: star.id, name: ask.name }) === expansion.key,
  );
  if (!live) closeAsk();
});
