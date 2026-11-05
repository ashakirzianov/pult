// A thread's live preview sessions as the view knows them (`view/preview.ts`),
// followed once per thread however many of the shell's parts read them: its
// tabs' labels and icons, the stale tabs' closing, and the selected thread's
// pending reveals (`tabs.ts`).
import type { ThreadPreviewSessions } from "../../view/main.tsx";

import { threadView } from "../threads/pane.tsx";

interface Followed {
  readonly listeners: Set<(sessions: ThreadPreviewSessions) => void>;
  latest: ThreadPreviewSessions | undefined;
  stop: (() => void) | undefined;
}

const followed = new Map<string, Followed>();

/** A thread's key among the environments, as the preview tabs name it. */
export const threadKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

/**
 * Calls `listener` with the thread's sessions as they change, at once when
 * they are known already, until the returned stop; while anyone follows a
 * thread, the view keeps its list in step with its server.
 */
export function followSessions(
  environmentId: string,
  threadId: string,
  listener: (sessions: ThreadPreviewSessions) => void,
): () => void {
  const key = threadKey(environmentId, threadId);
  let entry = followed.get(key);
  if (entry === undefined) {
    const created: Followed = { listeners: new Set(), latest: undefined, stop: undefined };
    entry = created;
    followed.set(key, created);
    void threadView().then(
      (mounts) => {
        if (followed.get(key) !== created) return;
        created.stop = mounts.followPreviewSessions(environmentId, threadId, (sessions) => {
          created.latest = sessions;
          for (const each of created.listeners) each(sessions);
        });
      },
      (error: unknown) => console.error("[pult-shell] the preview sessions did not load", error),
    );
  }
  const own = entry;
  own.listeners.add(listener);
  if (own.latest !== undefined) listener(own.latest);
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size > 0 || followed.get(key) !== own) return;
    followed.delete(key);
    own.stop?.();
  };
}

/** The thread's sessions as last followed, or as the view knows them now once it has started. */
export async function currentSessions(
  environmentId: string,
  threadId: string,
): Promise<ThreadPreviewSessions> {
  const latest = followed.get(threadKey(environmentId, threadId))?.latest;
  if (latest !== undefined) return latest;
  return (await threadView()).previewSessions(environmentId, threadId);
}

/**
 * The thread's sessions once its list has loaded, followed meanwhile, or as
 * they are after `timeoutMs` if it has not (an environment not connected).
 */
export function loadedSessions(
  environmentId: string,
  threadId: string,
  timeoutMs = 5_000,
): Promise<ThreadPreviewSessions> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let done = false;
    const finish = (sessions: ThreadPreviewSessions) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => stop?.());
      resolve(sessions);
    };
    const timer = setTimeout(
      () => void currentSessions(environmentId, threadId).then(finish),
      timeoutMs,
    );
    stop = followSessions(environmentId, threadId, (sessions) => {
      if (sessions.loaded) finish(sessions);
    });
  });
}
