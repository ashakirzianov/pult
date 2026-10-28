import type { ProjectDraft } from "../../thread-view/shell/drafts.ts";

export type { ProjectDraft };

let drafts: ReadonlyArray<ProjectDraft> = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

/**
 * The projects' unsent drafts, for Ready's draft cards: the thread view's
 * (`thread-view/shell/drafts.ts`), loaded on the first subscriber without
 * the rest of the view, and empty until then.
 */
export const projectDrafts = {
  get: () => drafts,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    loading ??= import("../../thread-view/shell/drafts.ts").then(({ projectDrafts: source }) => {
      const update = () => {
        drafts = source.get();
        for (const each of listeners) each();
      };
      source.subscribe(update);
      update();
    });
    return () => listeners.delete(listener);
  },
};
