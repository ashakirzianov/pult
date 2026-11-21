// The secrets threads' agents wait for (`request_secret`), as Inbox shows
// them: upstream's shell says a thread's run waits on a card only the user can
// answer (`pendingCard`), live on every held environment, and the page reads
// that card's turn item once, by upstream's `orchestration.getTurnItem`, for
// whether it is a secret's and its label. A card leaves as the shell drops it:
// the secret given or declined, its wait timed out or its run ended. Nothing
// polls; a failed read is tried again a while later.
import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import { request } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  SecretRequestError,
  ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { starStore } from "../stars/model.ts";
import { threadStore } from "../threads/store.ts";
import { type CardRead, cardKey, type PageSecret, pageSecrets } from "./secrets.ts";

const RETRY_DELAY_MS = 30_000;

/** A waiting card as the shell names it. */
type Card = Pick<PageSecret, "environmentId" | "threadId" | "id">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cards the store's threads say wait on the user, by `cardKey`. */
function waitingCards(): Map<string, Card> {
  return new Map(
    threadStore.get().threads.flatMap((thread) => {
      if (thread.pendingCard === null) return [];
      const card = {
        environmentId: thread.environmentId,
        threadId: thread.id,
        id: thread.pendingCard.id,
      };
      return [[cardKey(card), card] as const];
    }),
  );
}

class SecretsModel {
  private readonly reads = new Map<string, CardRead>();
  private readonly reading = new Set<string>();
  private secrets: ReadonlyArray<PageSecret> = [];
  private readonly listeners = new Set<() => void>();
  private retry: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    threadStore.subscribe(() => this.follow());
    starStore.subscribe(() => this.update());
    this.follow();
  }

  get(): ReadonlyArray<PageSecret> {
    return this.secrets;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private follow(): void {
    const waiting = waitingCards();
    for (const key of this.reads.keys()) if (!waiting.has(key)) this.reads.delete(key);
    for (const [key, card] of waiting)
      if (!this.reads.has(key) && !this.reading.has(key)) void this.read(key, card);
    this.update();
  }

  private async read(key: string, card: Card): Promise<void> {
    this.reading.add(key);
    try {
      const { item } = await connection.run(
        card.environmentId,
        request(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
          threadId: ThreadId.make(card.threadId),
          itemId: TurnItemId.make(card.id),
        }),
      );
      // A card the shell dropped meanwhile stays unread, as no thread waits on it.
      if (!waitingCards().has(key)) return;
      this.reads.set(
        key,
        item?.type === "secret_request"
          ? { type: item.type, label: item.label }
          : { type: item?.type ?? "none", label: "" },
      );
      this.update();
    } catch (error) {
      console.warn(
        `[pult-shell] could not read the card ${card.id} of ${card.threadId}: ${errorMessage(error)}`,
      );
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.follow(), RETRY_DELAY_MS);
    } finally {
      this.reading.delete(key);
    }
  }

  /**
   * Declines the secret, as the card's Decline in its thread does: its agent
   * is told the user declined. A card already answered, or whose agent
   * stopped, is done with; any other refusal is told by a notification with
   * the server's words.
   */
  async decline(secret: PageSecret): Promise<void> {
    try {
      await connection.run(
        secret.environmentId,
        request(WS_METHODS.secretsAnswerRequest, {
          threadId: ThreadId.make(secret.threadId),
          turnItemId: TurnItemId.make(secret.id),
          answer: { type: "decline" },
        }),
      );
    } catch (error) {
      if (
        error instanceof SecretRequestError &&
        (error.reason === "already_answered" || error.reason === "agent_stopped")
      )
        return;
      (await getService(INotificationService)).error(
        `Pult could not decline the secret “${secret.label}”: ${errorMessage(error)}`,
      );
    }
  }

  private update(): void {
    const next = pageSecrets(threadStore.get().threads, this.reads, starStore.get());
    if (JSON.stringify(next) === JSON.stringify(this.secrets)) return;
    this.secrets = next;
    for (const listener of this.listeners) listener();
  }
}

const model = new SecretsModel();

/** Starts following the secrets, after the thread model and the Stars'. */
export function startSecrets(): void {
  model.start();
}

/** Every held environment's secrets awaiting the user, oldest first. */
export const secretStore = {
  get: () => model.get(),
  subscribe: (listener: () => void) => model.subscribe(listener),
};

export const declineSecret = (secret: PageSecret) => model.decline(secret);
export const secretOf = (environmentId: string, threadId: string) =>
  model
    .get()
    .find((secret) => secret.environmentId === environmentId && secret.threadId === threadId);
