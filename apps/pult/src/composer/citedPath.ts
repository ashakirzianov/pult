import { joinPath, namesEnvironment, relativeTo } from "../files/paths.ts";

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

/** What a side of a `pult-diff:` diff (`src/changes/view.ts`) names in its query: a change, or a file of a commit the Graph lists. */
type DiffSide =
  | {
      readonly change: {
        readonly environmentId: string;
        readonly cwd: string;
        readonly repositoryRoot: string;
        readonly path: string;
        readonly sourceKind: string;
      };
    }
  | {
      readonly commit: {
        readonly environmentId: string;
        readonly cwd: string;
        readonly repositoryRoot: string;
        readonly path: string;
      };
    };

/**
 * The file a `pult-diff:` side's query names, to cite by `citedPath`: its
 * checkout (the change's, or the Graph's for a commit), its host path, and
 * the diff's source as the composer labels it, a commit's as Changes.
 */
export function diffFile(query: string) {
  const side = JSON.parse(query) as DiffSide;
  const file = "change" in side ? side.change : side.commit;
  return {
    environmentId: file.environmentId,
    root: file.cwd,
    hostPath: joinPath(file.repositoryRoot, file.path),
    source:
      "change" in side && side.change.sourceKind === "working-tree"
        ? ("Uncommitted" as const)
        : ("Changes" as const),
  };
}
