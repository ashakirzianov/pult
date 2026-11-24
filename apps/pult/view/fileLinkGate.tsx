// The thread view's file link gate (`apps/web/src/components/chat/fileLinkGate.ts`), provided on
// the view's root (`ThreadView.tsx`): a chip until the shell knows its path opens nothing
// (`src/files/linkable.ts`, through the host's `fileLinks`), then its fallback. It asks once its
// message stops streaming.
import { useEffect, useSyncExternalStore } from "react";

import type { FileLinkGateProps } from "~/components/chat/fileLinkGate";
import { threadViewHost } from "./host.ts";

export function FileLinkGate({ threadRef, path, isStreaming, chip, fallback }: FileLinkGateProps) {
  const links = threadViewHost().fileLinks;
  const { environmentId, threadId } = threadRef;
  const verdict = useSyncExternalStore(
    (listener) => links.subscribe({ environmentId, threadId, path }, listener),
    () => links.verdict({ environmentId, threadId, path }),
  );
  // A verdict dropped (its run ended, the checkouts changed) is asked again.
  useEffect(() => {
    if (!isStreaming && verdict === undefined) links.ask({ environmentId, threadId, path });
  }, [links, environmentId, threadId, path, isStreaming, verdict]);
  return verdict === false ? fallback : chip;
}
