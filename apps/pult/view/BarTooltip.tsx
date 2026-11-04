// Upstream's tooltip, for the shell's own entries of the composer bar
// (`src/threads/barEntries.tsx`), so they name themselves as upstream's
// attach button does. The shell loads it with the view, never before.
import type { ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** `children`, the trigger, with `label` in a tooltip above it on hover and keyboard focus. */
export default function BarTooltip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
