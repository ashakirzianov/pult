import { request } from "@t3tools/client-runtime/rpc";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { threadStore } from "../threads/store.ts";
import { heldTranscriptOf, lookUpTranscriptOf, type NamedReading } from "./foldState.ts";
import { starById } from "./model.ts";
import { drawnHome, isEarlierConversation } from "./stars.ts";

/**
 * What the Star's tab does with a citation it follows (`MountOptions.consumesCitation`): one of
 * its earlier conversations with the user on the home it is drawn from (`isEarlierConversation`),
 * which no route of the view shows, is kept, with its transcript where the fold has it or the
 * plugin finds it by its thread, else `"unshown"`; undefined for any other, which takes its
 * ordinary path. Known from a transcript of that thread, else from the page's row of it, else
 * from the server's family of it; a thread the server does not know, or a failed read, counts
 * as one, since the tab cannot tell it is not. Its current conversation and any other
 * environment's thread are not. A root thread a fenced link started counts too, as the page's
 * rows do not tell one: no view of the tab shows it either, selecting it selecting the Star.
 */
export async function keptCitation(
  starId: string,
  citation: { readonly environmentId: string; readonly threadId: string },
): Promise<NamedReading | "unshown" | undefined> {
  const star = starById(starId);
  const home = star === undefined ? undefined : drawnHome(star);
  const { environmentId, threadId } = citation;
  if (star === undefined || home === undefined || environmentId !== home.environmentId)
    return undefined;
  if (star.current?.environmentId === environmentId && star.current.id === threadId)
    return undefined;
  const held = heldTranscriptOf(environmentId, starId, threadId);
  if (held !== undefined) return held;
  const row = threadStore
    .get()
    .threads.find((each) => each.environmentId === environmentId && each.id === threadId);
  if (row !== undefined && !isEarlierConversation(star, row)) return undefined;
  const found = await lookUpTranscriptOf(environmentId, starId, threadId);
  if (found !== undefined || row !== undefined) return found ?? "unshown";
  try {
    // A settled thread past the shell's window, which the page holds no row of.
    const family = await connection.run(
      environmentId,
      request(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, { threadId: ThreadId.make(threadId) }),
    );
    const shell = family.threads.find((each) => each.id === threadId);
    if (shell === undefined) return "unshown";
    return isEarlierConversation(starById(starId) ?? star, {
      environmentId,
      projectId: shell.projectId,
      parentId: shell.lineage.parentThreadId,
      settled: shell.settledOverride === "settled",
      tags: shell.tags ?? [],
    })
      ? "unshown"
      : undefined;
  } catch {
    return "unshown";
  }
}
