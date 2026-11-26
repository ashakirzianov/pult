import type { LongFrame, PultDesktop } from "./api.ts";

/** The shortest frame the freeze log keeps. */
const MIN_DURATION_MS = 250;

/** The fields of Chromium's `PerformanceLongAnimationFrameTiming` the log keeps, which the DOM's types lack. */
interface LongAnimationFrameEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration: number;
  /** Each 0 where the frame had no such phase. */
  readonly renderStart: number;
  readonly styleAndLayoutStart: number;
  readonly firstUIEventTimestamp: number;
  readonly scripts: ReadonlyArray<{
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
    readonly invoker: string;
    readonly invokerType: string;
    readonly duration: number;
  }>;
}

/** Chromium's `performance.memory`, which the DOM's types lack. */
interface ChromiumPerformance {
  readonly memory?: { readonly usedJSHeapSize: number };
}

/** The JS heap as the page reads it at an observer callback; undefined where the runtime gives none. */
type Heap = Pick<LongFrame, "usedJSHeapSize" | "previousUsedJSHeapSize">;

/** `phase`'s time after the frame's start, or nothing where the frame had no such phase. */
function sinceStart(entry: LongAnimationFrameEntry, phase: number): number | undefined {
  return phase > 0 ? Math.round(phase - entry.startTime) : undefined;
}

/**
 * `entry` as the freeze log keeps it, its start on the wall clock and its
 * phases after its start, or nothing for a frame shorter than 250 ms.
 */
function longFrame(
  entry: LongAnimationFrameEntry,
  timeOrigin: number,
  heap: Heap,
): LongFrame | undefined {
  if (entry.duration < MIN_DURATION_MS) return undefined;
  return {
    startedAtUnixMs: Math.round(timeOrigin + entry.startTime),
    durationMs: Math.round(entry.duration),
    blockingDurationMs: Math.round(entry.blockingDuration),
    renderStartMs: sinceStart(entry, entry.renderStart),
    styleAndLayoutStartMs: sinceStart(entry, entry.styleAndLayoutStart),
    firstUIEventMs: sinceStart(entry, entry.firstUIEventTimestamp),
    ...heap,
    scripts: entry.scripts.map((script) => ({
      sourceURL: script.sourceURL,
      sourceFunctionName: script.sourceFunctionName,
      invoker: script.invoker,
      invokerType: script.invokerType,
      durationMs: Math.round(script.duration),
    })),
  };
}

/**
 * Hands every animation frame of 250 ms or longer, those since the page
 * loaded included, to Pult.app's freeze log (`desktop/src/freezeLog.ts`),
 * so a freeze names the scripts that held the main thread, or else says
 * whether its time went to rendering, and how the heap moved around it.
 */
export function recordLongFrames(desktop: PultDesktop): void {
  let previousUsedJSHeapSize: number | undefined;
  new PerformanceObserver((list) => {
    const usedJSHeapSize = (performance as ChromiumPerformance).memory?.usedJSHeapSize;
    const heap = { usedJSHeapSize, previousUsedJSHeapSize };
    previousUsedJSHeapSize = usedJSHeapSize;
    for (const entry of list.getEntries()) {
      const frame = longFrame(
        entry as unknown as LongAnimationFrameEntry,
        performance.timeOrigin,
        heap,
      );
      if (frame)
        desktop.longFrame(frame).catch((error: unknown) => {
          console.error("[pult-shell] the freeze log refused a long frame", error);
        });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}
