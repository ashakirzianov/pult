import type { LongFrame, PultDesktop } from "./api.ts";

/** The shortest frame the freeze log keeps. */
const MIN_DURATION_MS = 250;

/** The fields of Chromium's `PerformanceLongAnimationFrameTiming` the log keeps, which the DOM's types lack. */
interface LongAnimationFrameEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration: number;
  readonly scripts: ReadonlyArray<{
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
    readonly invoker: string;
    readonly invokerType: string;
    readonly duration: number;
  }>;
}

/**
 * `entry` as the freeze log keeps it, its start on the wall clock, or
 * nothing for a frame shorter than 250 ms.
 */
function longFrame(entry: LongAnimationFrameEntry, timeOrigin: number): LongFrame | undefined {
  if (entry.duration < MIN_DURATION_MS) return undefined;
  return {
    startedAtUnixMs: Math.round(timeOrigin + entry.startTime),
    durationMs: Math.round(entry.duration),
    blockingDurationMs: Math.round(entry.blockingDuration),
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
 * so a freeze names the scripts that held the main thread.
 */
export function recordLongFrames(desktop: PultDesktop): void {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const frame = longFrame(entry as unknown as LongAnimationFrameEntry, performance.timeOrigin);
      if (frame)
        desktop.longFrame(frame).catch((error: unknown) => {
          console.error("[pult-shell] the freeze log refused a long frame", error);
        });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}
