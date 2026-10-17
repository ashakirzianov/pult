import { threadStore } from "../threads/store.ts";

const KEY = "pult.shell.selectedThread";
type Listener = () => void;

/** The thread in the centre column: the user's last choice, else the most recently updated. */
class Selection {
  private chosen: string | null = localStorage.getItem(KEY);
  private readonly listeners = new Set<Listener>();

  constructor() {
    threadStore.subscribe(() => this.notify());
  }

  get(): string | null {
    const { threads } = threadStore.get();
    if (this.chosen !== null && threads.some((thread) => thread.id === this.chosen)) return this.chosen;
    return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  }

  set(threadId: string): void {
    this.chosen = threadId;
    localStorage.setItem(KEY, threadId);
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const selection = new Selection();
