import type { ProjectDraft } from "../../view/drafts.ts";
import { isStarRoot } from "../stars/record.ts";
import { threadStore } from "../threads/store.ts";

export type { ProjectDraft };

type Source = typeof import("../../view/drafts.ts");

let source: Promise<Source> | undefined;

/**
 * One of the thread view's composer lists (`view/drafts.ts`) for
 * `useSyncExternalStore`, loaded on the first subscriber without the rest
 * of the view, and `initial` until then.
 */
function lazyList<T>(
  initial: T,
  pick: (module: Source) => { get(): T; subscribe(listener: () => void): () => void },
) {
  let value = initial;
  const listeners = new Set<() => void>();
  let loading: Promise<void> | undefined;
  return {
    get: () => value,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      loading ??= (source ??= import("../../view/drafts.ts")).then((module) => {
        const list = pick(module);
        const update = () => {
          value = list.get();
          for (const each of listeners) each();
        };
        list.subscribe(update);
        update();
      });
      return () => listeners.delete(listener);
    },
  };
}

/** Whether `draft` is of a Star's project, whose draft is the Star's own (`src/stars/`) and has no card. */
export function isStarDraft(draft: Pick<ProjectDraft, "environmentId" | "projectId">): boolean {
  return isStarRoot(threadStore.project(draft.environmentId, draft.projectId)?.root);
}

/** The projects' unsent drafts, for Ready's draft cards. */
export const projectDrafts = lazyList<ReadonlyArray<ProjectDraft>>(
  [],
  (module) => module.projectDrafts,
);

/** The threads whose composer holds an unsent message, by the panel's `keyOf`, for their cards' mark. */
export const threadsWithUnsentMessages = lazyList<ReadonlySet<string>>(
  new Set(),
  (module) => module.threadsWithUnsentMessages,
);
