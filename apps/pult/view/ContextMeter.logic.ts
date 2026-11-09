// The numbers of the composer bar's context window meter (`ContextMeter.tsx`),
// after upstream's `ContextWindowMeter`, which upstream removed (#33131) and
// Pult keeps (`pult/decisions`, `composer-settings-placement`).
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

/**
 * The meter turns orange from this many tokens in context, and red from this
 * share of the window, ahead of upstream's red past 90%.
 */
const HEAVY_CONTEXT_TOKENS = 250_000;
const FULL_CONTEXT_PERCENTAGE = 75;

export type ContextLevel = "heavy" | "full";

export function contextLevel(
  usage: Pick<ContextWindowSnapshot, "usedTokens" | "usedPercentage">,
): ContextLevel | null {
  if ((usage.usedPercentage ?? 0) >= FULL_CONTEXT_PERCENTAGE) return "full";
  if (usage.usedTokens >= HEAVY_CONTEXT_TOKENS) return "heavy";
  return null;
}

/** The share of the window used, one decimal under 10%. */
export function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export function formatCost(cost: { readonly amount: number; readonly currency: string }): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
