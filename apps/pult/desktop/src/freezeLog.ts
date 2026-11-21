// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Plain Electron handlers, outside upstream's Effect runtime.
/**
 * Pult.app's freeze log, `renderer-freezes.ndjson` beside upstream's logs
 * (`~/.t3/userdata/logs`): the page's long animation frames, which it hands
 * over through `window.pultDesktop.longFrame` (`src/desktop/longFrames.ts`),
 * and the page's JS stack when its window turns unresponsive, paused for it
 * through the debugger (`captureStack`). One JSON object a line, each with
 * `timestampUnixMs` and `event`; rotated as upstream's `renderer-history`
 * is, to at most three files of 1 MiB.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 2;
/** How long a capture may stay attached, its window unresponsive all along, before it gives up. */
const CAPTURE_TIMEOUT_MS = 5 * 60_000;

export type FreezeLog = (event: string, fields: Record<string, unknown>) => void;

/** A log at `<logDir>/renderer-freezes.ndjson`, its old files `.1` and `.2`. */
export function openFreezeLog(
  logDir: string,
  now: () => number = Date.now,
  maxBytes = MAX_BYTES,
): FreezeLog {
  const filePath = NodePath.join(logDir, "renderer-freezes.ndjson");
  NodeFS.mkdirSync(logDir, { recursive: true });
  let size = NodeFS.existsSync(filePath) ? NodeFS.statSync(filePath).size : 0;
  return (event, fields) => {
    const line = `${JSON.stringify({ timestampUnixMs: now(), event, ...fields })}\n`;
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
        if (NodeFS.existsSync(`${filePath}.${index}`))
          NodeFS.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      }
      NodeFS.renameSync(filePath, `${filePath}.1`);
      size = 0;
    }
    NodeFS.appendFileSync(filePath, line);
    size += Buffer.byteLength(line);
  };
}

/** The part of Electron's `webContents.debugger` a capture uses. */
export interface Debuggee {
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on(
    event: "message",
    listener: (event: unknown, method: string, params: unknown) => void,
  ): unknown;
  off(
    event: "message",
    listener: (event: unknown, method: string, params: unknown) => void,
  ): unknown;
}

interface CallFrame {
  readonly functionName: string;
  readonly location: {
    readonly scriptId: string;
    readonly lineNumber: number;
    readonly columnNumber?: number;
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Pauses the page behind `debuggee`, resumes and detaches it, then logs where
 * its JS stood (`unresponsive-stack`: each frame's function, its script's URL
 * from `Debugger.scriptParsed`, since V8 leaves the frame's own empty, and
 * 1-based line and column). Chromium answers `Debugger.enable` only between
 * tasks, and `Debugger.pause` interrupts running JS only once enabled, so the
 * pause lands in the first task after the freeze's work yields once; a freeze
 * that is one task never pauses, its long animation frame naming it instead.
 * So a capture waits until `responsive` settles, the window answering again,
 * or `timeoutMs` passes, and then gives up rather than pause whatever the page
 * runs next. Never leaves the page paused: a failure, an attach refused
 * included, is logged as `unresponsive-capture-failed`, and a debugger it
 * attached detaches, which resumes the page, whatever happened. Rejects only
 * when the log cannot be written.
 */
export async function captureStack(
  debuggee: Debuggee,
  log: FreezeLog,
  url: string,
  responsive: Promise<void>,
  timeoutMs = CAPTURE_TIMEOUT_MS,
): Promise<void> {
  const scriptUrls = new Map<string, string>();
  const failures: string[] = [];
  let callFrames: ReadonlyArray<CallFrame> | undefined;
  let attached = false;
  let gaveUp = false;
  let onMessage: ((event: unknown, method: string, params: unknown) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    debuggee.attach("1.3");
    attached = true;
    const paused = new Promise<ReadonlyArray<CallFrame>>((resolve) => {
      onMessage = (_event, method, params) => {
        if (method === "Debugger.scriptParsed") {
          const script = params as { scriptId: string; url: string };
          scriptUrls.set(script.scriptId, script.url);
        }
        if (method === "Debugger.paused")
          resolve((params as { callFrames: ReadonlyArray<CallFrame> }).callFrames);
      };
      debuggee.on("message", onMessage);
    });
    const givenUp = Promise.race([
      responsive.then(() => {
        gaveUp = true;
        throw new Error("The window answered again before the page paused.");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          gaveUp = true;
          reject(new Error(`The page did not pause within ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
    // Settled after the capture too, once the window answers again.
    givenUp.catch(() => {});
    callFrames = await Promise.race([
      debuggee
        .sendCommand("Debugger.enable")
        .then(() => {
          if (gaveUp) throw new Error("The capture gave up before the page paused.");
          return debuggee.sendCommand("Debugger.pause");
        })
        .then(() => paused),
      givenUp,
    ]);
    // Not awaited: the detach below resumes the page whether or not this is answered.
    debuggee.sendCommand("Debugger.resume").catch(() => {});
  } catch (error) {
    failures.push(message(error));
  } finally {
    clearTimeout(timer);
    if (onMessage) debuggee.off("message", onMessage);
    if (attached) {
      try {
        debuggee.detach();
      } catch (error) {
        failures.push(`Detach: ${message(error)}`);
      }
    }
  }
  if (callFrames)
    log("unresponsive-stack", {
      url,
      callFrames: callFrames.map((frame) => ({
        functionName: frame.functionName,
        url: scriptUrls.get(frame.location.scriptId) ?? "",
        line: frame.location.lineNumber + 1,
        column: (frame.location.columnNumber ?? 0) + 1,
      })),
    });
  for (const error of failures) log("unresponsive-capture-failed", { url, error });
}
