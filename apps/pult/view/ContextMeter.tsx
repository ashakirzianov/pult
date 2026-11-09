// The composer bar's context window meter (`ThreadView.tsx`), Pult's own
// since upstream removed its `ContextWindowMeter` (#33131): an arc of the
// share of the window the thread's context takes, orange once it is heavy and
// red once it nears full (`ContextMeter.logic.ts`), with the numbers on hover. It
// reads the thread's context as upstream's thread details do, from the
// projection the view subscribes to anyway.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createPortal } from "react-dom";

import { formatContextWindowCompactionMessage } from "~/components/chat/compaction.logic";
import { composerFloatingLayerProps } from "~/components/chat/composerEventScope";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { useQuietThreadProjection, useQuietThreadVisibleTurnItems } from "~/state/entities";
import { contextLevel, formatCost, formatPercentage } from "./ContextMeter.logic.ts";

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LEVEL_COLOR = {
  heavy: "var(--warning)",
  full: "var(--color-error)",
} as const;

function Meter({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const level = contextLevel(usage);
  const usageColor =
    level === null
      ? "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"
      : LEVEL_COLOR[level];
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={RADIUS}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={RADIUS}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - normalizedPercentage / 100)}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            <div className="text-secondary-label text-2xs tabular-nums">
              {usage.maxTokens !== null && usedPercentage ? (
                <>
                  <span>{usedPercentage}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </>
              ) : (
                formatContextWindowTokens(usage.usedTokens)
              )}
            </div>
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {totalProcessedTokens !== null && totalProcessedTokens > 0 ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(usage.autoCompactThreshold)}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The thread's meter as an entry of its composer bar, `meter` (the bar
 * orders it), while its provider reports its context; nothing before.
 */
export function ContextMeter({
  bar,
  environmentId,
  threadId,
}: {
  readonly bar: HTMLElement;
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const visibleTurnItems = useQuietThreadVisibleTurnItems(ref);
  if (projection === null) return null;
  // As upstream's thread view derives the context its thread details show (`ChatView.tsx`).
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  const usage = deriveLatestContextWindowSnapshot(
    visibleTurnItems,
    latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread),
    providerThread,
  );
  if (usage === null) return null;
  return createPortal(
    <div
      data-chat-composer-slot-item="meter"
      data-chat-composer-resting-controls="true"
      className="flex min-w-0 items-center"
    >
      <Meter usage={usage} />
    </div>,
    bar,
  );
}
