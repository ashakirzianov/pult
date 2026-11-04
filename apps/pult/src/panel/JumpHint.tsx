import { useSyncExternalStore } from "react";

import { jumpHints } from "./jump.ts";

/** A row's jump shortcut, upstream's hint badge at the row's right while the jump modifier is held (`jumpHints`); nothing otherwise. */
export function JumpHint({ rowKey }: { rowKey: string }) {
  const label = useSyncExternalStore(jumpHints.subscribe, () => jumpHints.get().get(rowKey));
  if (label === undefined) return null;
  return (
    <span className="pult-jump-hint" aria-hidden>
      {label}
    </span>
  );
}
