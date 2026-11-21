// The secrets threads' agents wait for (`request_secret`) as Inbox draws
// them (`model.ts`), apart from the workbench so `node --test
// src/secrets/secrets.test.ts` can run what makes them: which threads' cards
// are secrets' and who asked.
import type { RoutePoster } from "../stars/plugin.ts";
import { channelOf, findStarOfThread, type Star, type StarThread } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";

/** A secret a thread's agent asked the user for and waits for: its card in Inbox. */
export interface PageSecret {
  readonly environmentId: string;
  readonly threadId: string;
  /** Its card's turn item. */
  readonly id: string;
  /** When the agent asked. */
  readonly since: string;
  /** What the agent asked for, the card's label: never its placeholder, and the page never holds the value. */
  readonly label: string;
  /** Who asked, as an ask's poster (`src/asks/asks.ts`): a Star's conversation in its channel, or any other thread. */
  readonly poster: RoutePoster;
}

/** A waiting card's turn item as the page read it once: its type, a secret's or a link's, and its label. */
export interface CardRead {
  readonly type: string;
  readonly label: string;
}

export const cardKey = (card: Pick<PageSecret, "environmentId" | "threadId" | "id">) =>
  `${card.environmentId}/${card.threadId}/${card.id}`;

/**
 * The secrets awaiting the user, oldest first: each thread's waiting card
 * (`pendingCard`) read as a secret's, whatever the thread's shelf, settled
 * and snoozed ones included, since its agent still waits; a card not yet
 * read, or a link's, none.
 */
export function pageSecrets<Thread extends StarThread & Pick<ShellThread, "tags" | "pendingCard">>(
  threads: ReadonlyArray<Thread>,
  reads: ReadonlyMap<string, CardRead>,
  stars: ReadonlyArray<Star<Thread>>,
): PageSecret[] {
  return threads
    .flatMap((thread): PageSecret[] => {
      if (thread.pendingCard === null) return [];
      const card = {
        environmentId: thread.environmentId,
        threadId: thread.id,
        id: thread.pendingCard.id,
      };
      const read = reads.get(cardKey(card));
      if (read?.type !== "secret_request") return [];
      const star = findStarOfThread(stars, thread);
      return [
        {
          ...card,
          since: thread.pendingCard.since,
          label: read.label,
          poster:
            star === undefined
              ? { thread: thread.id }
              : { star: star.id, channel: channelOf(thread) },
        },
      ];
    })
    .toSorted((left, right) => Date.parse(left.since) - Date.parse(right.since));
}
