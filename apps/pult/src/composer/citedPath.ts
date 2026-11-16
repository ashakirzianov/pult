import { namesEnvironment, relativeTo } from "../files/paths.ts";

/** A checkout on an environment's host: a thread's worktree or a project's root. */
export interface CitedCheckout {
  readonly environmentId: string;
  readonly root: string;
}

/**
 * A cited file's path as the selected thread's agent should read it: relative
 * to the file's own checkout when that is the selected one's, absolute
 * otherwise (`pult/issues/cite-from-other-checkout`). A diff's file names its
 * checkout; a `pult:` file is the selected one's when it lies under its root.
 */
export function citedPath(
  selected: CitedCheckout | undefined,
  file: { readonly environmentId: string; readonly hostPath: string; readonly root?: string },
): string {
  if (selected === undefined || !namesEnvironment(file.environmentId, selected.environmentId))
    return file.hostPath;
  if (file.root !== undefined && file.root !== selected.root) return file.hostPath;
  return relativeTo(selected.root, file.hostPath) || file.hostPath;
}
