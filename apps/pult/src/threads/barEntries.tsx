import { lazy, type ReactElement, Suspense } from "react";

// Loaded with the view rather than with the page: upstream's modules read state as they load.
const BarTooltip = lazy(() => import("../../view/BarTooltip.tsx"));

/**
 * `children`, an entry of a composer bar, named in upstream's tooltip on
 * hover and keyboard focus, as the bar's own buttons are; the entry alone
 * until the tooltip loads.
 */
export function BarTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Suspense fallback={children}>
      <BarTooltip label={label}>{children}</BarTooltip>
    </Suspense>
  );
}
