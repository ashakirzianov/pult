// The checkouts the changes view's status read found no repository, a plain
// folder's project, for a thread's Changes shelf (`src/details/ThreadDetails.tsx`),
// which is left out on them. A checkout unread, or whose last read failed,
// counts as a repository.
import { checkoutKey } from "./checkouts.ts";

const notRepositories = new Set<string>();
const listeners = new Set<() => void>();

/** Records what a checkout's status read says (`view.ts`, `readSync`). */
export function setRepository(key: string, isRepo: boolean): void {
  if (notRepositories.has(key) === !isRepo) return;
  if (isRepo) notRepositories.delete(key);
  else notRepositories.add(key);
  for (const listener of listeners) listener();
}

/** Whether the checkout's last status read said it is no repository. */
export function isNoRepository(environmentId: string, root: string): boolean {
  return notRepositories.has(checkoutKey(environmentId, root));
}

export function subscribeRepositories(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
