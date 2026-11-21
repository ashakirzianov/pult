// Run with `node --test desktop/src/freezeLog.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { captureStack, openFreezeLog, type Debuggee, type FreezeLog } from "./freezeLog.ts";

const tempDir = (t: NodeTest.TestContext) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pult-freeze-log-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A debugger on a page that pauses on `Debugger.pause`, its frames' URLs left
 * empty as V8 leaves them. `enable` is when `Debugger.enable` is answered; one
 * that never resolves is a page that never yields. `heldBy` is another session
 * holding the debugger, so `attach` throws as Electron's does.
 */
function fakeDebuggee(options: { readonly enable?: Promise<void>; readonly heldBy?: string } = {}) {
  const calls: string[] = [];
  let listener: ((event: unknown, method: string, params: unknown) => void) | undefined;
  const debuggee: Debuggee = {
    attach() {
      if (options.heldBy) throw new Error("Another debugger is already attached");
      calls.push("attach");
    },
    detach() {
      calls.push("detach");
    },
    async sendCommand(method) {
      calls.push(method);
      if (method === "Debugger.enable") {
        listener?.({}, "Debugger.scriptParsed", {
          scriptId: "7",
          url: "pult://app/assets/index.js",
        });
        await options.enable;
      }
      if (method === "Debugger.pause")
        queueMicrotask(() =>
          listener?.({}, "Debugger.paused", {
            callFrames: [
              {
                functionName: "decodeAll",
                url: "",
                location: { scriptId: "7", lineNumber: 41, columnNumber: 9 },
              },
              { functionName: "", url: "", location: { scriptId: "7", lineNumber: 0 } },
            ],
          }),
        );
      return {};
    },
    on(_event, next) {
      listener = next;
    },
    off() {
      listener = undefined;
    },
  };
  return { debuggee, calls };
}

const recording = () => {
  const lines: Array<{ event: string } & Record<string, unknown>> = [];
  const log: FreezeLog = (event, fields) => lines.push({ event, ...fields });
  return { lines, log };
};

const never = new Promise<void>(() => {});

NodeTest.describe("pult: freeze log", () => {
  NodeTest.it(
    "logs the paused page's frames by their scripts' URLs, then resumes and detaches",
    async () => {
      const { debuggee, calls } = fakeDebuggee();
      const { lines, log } = recording();
      await captureStack(debuggee, log, "pult://app/", never);
      NodeAssert.deepEqual(lines, [
        {
          event: "unresponsive-stack",
          url: "pult://app/",
          callFrames: [
            { functionName: "decodeAll", url: "pult://app/assets/index.js", line: 42, column: 10 },
            { functionName: "", url: "pult://app/assets/index.js", line: 1, column: 1 },
          ],
        },
      ]);
      NodeAssert.deepEqual(calls, [
        "attach",
        "Debugger.enable",
        "Debugger.pause",
        "Debugger.resume",
        "detach",
      ]);
    },
  );

  NodeTest.it(
    "logs a refused attach and leaves the session holding the debugger alone",
    async () => {
      const { debuggee, calls } = fakeDebuggee({ heldBy: "DevTools" });
      const { lines, log } = recording();
      await captureStack(debuggee, log, "pult://app/", never);
      NodeAssert.deepEqual(lines, [
        {
          event: "unresponsive-capture-failed",
          url: "pult://app/",
          error: "Another debugger is already attached",
        },
      ]);
      NodeAssert.deepEqual(calls, []);
    },
  );

  NodeTest.it(
    "gives up without pausing when the window answers before the page yields",
    async () => {
      let yieldNow = () => {};
      const enable = new Promise<void>((resolve) => (yieldNow = resolve));
      const { debuggee, calls } = fakeDebuggee({ enable });
      const { lines, log } = recording();
      let answer = () => {};
      const responsive = new Promise<void>((resolve) => (answer = resolve));
      const capture = captureStack(debuggee, log, "pult://app/", responsive);
      answer();
      yieldNow();
      await capture;
      NodeAssert.deepEqual(lines, [
        {
          event: "unresponsive-capture-failed",
          url: "pult://app/",
          error: "The window answered again before the page paused.",
        },
      ]);
      NodeAssert.deepEqual(calls, ["attach", "Debugger.enable", "detach"]);
    },
  );

  NodeTest.it("writes timestamped lines and keeps at most three files", (t) => {
    const dir = tempDir(t);
    const log = openFreezeLog(dir, () => 1_700_000_000_000, 200);
    for (let index = 0; index < 20; index += 1) log("long-animation-frame", { durationMs: index });
    NodeAssert.deepEqual(NodeFS.readdirSync(dir).sort(), [
      "renderer-freezes.ndjson",
      "renderer-freezes.ndjson.1",
      "renderer-freezes.ndjson.2",
    ]);
    const current = NodeFS.readFileSync(NodePath.join(dir, "renderer-freezes.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    NodeAssert.deepEqual(current.at(-1), {
      timestampUnixMs: 1_700_000_000_000,
      event: "long-animation-frame",
      durationMs: 19,
    });
    for (const name of NodeFS.readdirSync(dir))
      NodeAssert.ok(NodeFS.statSync(NodePath.join(dir, name)).size <= 200);
  });
});
