// Upstream's provider presentation for the page's Limits shelf (`src/panel/LimitsShelf.tsx`):
// each usage provider's short name and colour, by its driver, as upstream's usage limits draw them,
// and its icon, as upstream's model picker draws it. Imported statically by the page; it reaches
// nothing of the view but the contracts and the icons' SVG.
import type { ServerProvider } from "@t3tools/contracts";

import { AntigravityIcon, ClaudeAI, type Icon, OpenAI } from "../t3/src/components/Icons.tsx";
import { PROVIDER_PRESENTATION } from "../t3/src/components/usage/usageProviders.ts";

/** A provider's short name and colour, by its driver; undefined for a driver upstream does not present. */
export function usageProvider(
  driver: ServerProvider["driver"],
): { readonly label: string; readonly color: string } | undefined {
  return Object.values(PROVIDER_PRESENTATION).find((entry) => entry.driverKind === driver);
}

// The icons the page has: upstream's own for the providers built into the contracts; the
// provider packages' icons stay out with the packages (`stubs/providerDriverMeta.ts`).
// Each fill inline, since the view's Tailwind classes on them load only with the view.
const ICONS: Partial<Record<string, { readonly icon: Icon; readonly fill?: string }>> = {
  codex: { icon: OpenAI, fill: "currentColor" },
  claudeAgent: { icon: ClaudeAI, fill: "#d97757" },
  antigravity: { icon: AntigravityIcon },
};

/** Whether `UsageProviderIcon` has an icon for the driver. */
export function hasUsageProviderIcon(driver: ServerProvider["driver"]): boolean {
  return ICONS[driver] !== undefined;
}

/** A provider's icon, by its driver; nothing for a driver the page has no icon of. */
export function UsageProviderIcon({
  driver,
  className,
}: {
  driver: ServerProvider["driver"];
  className?: string;
}) {
  const entry = ICONS[driver];
  if (entry === undefined) return null;
  const { icon: ProviderIcon, fill } = entry;
  return (
    <ProviderIcon
      className={className}
      style={fill === undefined ? undefined : { fill }}
      aria-hidden
    />
  );
}
