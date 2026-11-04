import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import type { TurnCheckpoints } from "./host.ts";

/**
 * A run's turn as the thread's projection records it, for the shell's
 * changes view: the turn's number, the two checkpoints its diff lies
 * between, and its files as the changed files card shows them. The
 * earlier checkpoint is the one before the turn's in its scope, as the
 * server's turn diff takes it; null while the projection has neither, or
 * when the turn has no ready checkpoint.
 */
export function turnCheckpoints(ref: ScopedThreadRef, runId: string): TurnCheckpoints | null {
  const projection = Option.getOrNull(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)).data,
  );
  if (projection === null) return null;
  const to = projection.checkpoints.find(
    (checkpoint) =>
      checkpoint.runId === runId &&
      checkpoint.appRunOrdinal !== null &&
      checkpoint.status === "ready",
  );
  if (to === undefined || to.appRunOrdinal === null) return null;
  const from = projection.checkpoints.find(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      checkpoint.scopeId === to.scopeId &&
      checkpoint.ordinalWithinScope === to.ordinalWithinScope - 1,
  );
  if (from === undefined) return null;
  return {
    turnCount: to.appRunOrdinal,
    fromRef: from.ref,
    toRef: to.ref,
    files: to.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
  };
}
