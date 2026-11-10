// Measures thread switches in headless Chromium, on a page already connected
// (`scripts/drive.ts` connects one; the profile is shared with it by default):
//   node scripts/perf.ts [--url http://localhost:5190/] [--profile dir] <mode> ...
// Modes:
//   threads                      the store's threads, with ids, for picking
//   switch <rounds> <id>...      selects the threads in turn, `rounds` times over, and
//                                prints per switch: the command's time, the time to the
//                                thread's first rows, the time until the main thread is
//                                quiet, and how long it was blocked on the way; then the
//                                heap, DOM node and listener counts after a forced
//                                collection, per round: a leak grows them round over round.
//                                `--cpuprofile <file>` records the last round;
//                                `--heapprofile <file>` samples what the rounds after the
//                                second allocate and keep, and `--heapsnapshot <file>` takes
//                                a snapshot (hundreds of MB), both after selecting the
//                                Explorer workspace, where no thread view is mounted.
//   soak <seconds>               the page left alone, its counts every 30 s.
// An id is `<environmentId>/<threadId>`, as `threads` prints it. Time a production build
// (`vp build`, `vp preview`): a development build's React is several times slower.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args.splice(index, 2)[1]!;
};
const url = option("--url", "http://localhost:5190/");
const profile = option("--profile", NodePath.join(import.meta.dirname, "../.playwright"));
const cpuProfile = option("--cpuprofile", "");
const heapProfile = option("--heapprofile", "");
const heapSnapshot = option("--heapsnapshot", "");
const [mode, ...rest] = args;

const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (error) => console.error(`[page error] ${error.message}`));
await page.goto(url);
await page.waitForFunction(() => "pult" in window, undefined, { timeout: 120_000 });
const cdp = await context.newCDPSession(page);

/** One switch, timed in the page: the command, the first rows of the thread, and the main thread's quiet. */
const SWITCH = `async ({ environmentId, threadId }) => {
  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push([entry.startTime, entry.duration]);
  });
  observer.observe({ entryTypes: ["longtask"] });
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
  const start = performance.now();
  let commandDone;
  const command = pult.exec("pult-shell.selectThread", environmentId, threadId).then(() => {
    commandDone = performance.now();
  });
  // The thread's own rows, or its empty timeline: the view of another thread is gone by then.
  let rows;
  const deadline = start + 30000;
  while (rows === undefined && performance.now() < deadline) {
    const now = await frame();
    const selected = pult.selected();
    const shown = document.querySelector(".pult-thread-pane [data-timeline-root]");
    if (
      commandDone !== undefined &&
      selected?.threadId === threadId &&
      shown !== null &&
      shown.getAttribute("data-timeline-loading") !== "true" &&
      (shown.querySelector("[data-timeline-row-id]") !== null || now - commandDone > 3000)
    )
      rows = now;
  }
  await command;
  // Quiet: half a second with no long task and no frame over 50ms.
  let quietSince = performance.now();
  let last = quietSince;
  while (performance.now() - quietSince < 500 && performance.now() < deadline) {
    const now = await frame();
    if (now - last > 50) quietSince = now;
    last = now;
  }
  observer.disconnect();
  const end = quietSince;
  const blocked = longTasks
    .filter(([at]) => at >= start && at <= end)
    .reduce((sum, [, duration]) => sum + duration, 0);
  return {
    command: Math.round(commandDone - start),
    rows: rows === undefined ? null : Math.round(rows - start),
    quiet: Math.round(end - start),
    blocked: Math.round(blocked),
    longest: Math.round(Math.max(0, ...longTasks.map(([, duration]) => duration))),
    rowCount: document.querySelectorAll(".pult-thread-pane [data-timeline-row-id]").length,
  };
}`;

async function memory() {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const dom = await cdp.send("Memory.getDOMCounters");
  return {
    heapMb: Math.round(heap.usedSize / 1e5) / 10,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    documents: dom.documents,
  };
}

if (mode === "threads") {
  await page.waitForTimeout(4000);
  const threads = await page.evaluate(
    `pult.threads().threads.map((t) => t.environmentId + "/" + t.id + "\\t" + t.shelf + "\\t" + t.projectName + "\\t" + t.title)`,
  );
  console.log((threads as string[]).join("\n"));
} else if (mode === "switch") {
  const rounds = Number(rest[0]);
  const targets = rest.slice(1).map((id) => {
    const slash = id.indexOf("/");
    return { environmentId: id.slice(0, slash), threadId: id.slice(slash + 1) };
  });
  await page.waitForTimeout(6000);
  await cdp.send("HeapProfiler.enable");
  console.log(JSON.stringify({ start: await memory() }));
  for (let round = 0; round < rounds; round += 1) {
    // What survives the later rounds, by where it was allocated: the first two warm the caches.
    if (heapProfile !== "" && round === 2) {
      await memory();
      await cdp.send("HeapProfiler.startSampling", { samplingInterval: 4096 });
    }
    const profiling = cpuProfile !== "" && round === rounds - 1;
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    for (const target of targets) {
      const timing = await page.evaluate(`(${SWITCH})(${JSON.stringify(target)})`);
      console.log(
        JSON.stringify({ round, thread: target.threadId.slice(0, 8), ...(timing as object) }),
      );
    }
    if (profiling) {
      const { profile: recorded } = await cdp.send("Profiler.stop");
      NodeFS.writeFileSync(cpuProfile, JSON.stringify(recorded));
      console.error(`cpu profile: ${cpuProfile}`);
    }
    console.log(JSON.stringify({ round, ...(await memory()) }));
  }
  if (heapProfile !== "" || heapSnapshot !== "") {
    // No thread view is mounted on the Explorer workspace, so what the views allocated and still lives was leaked.
    await page.evaluate(`pult.exec("pult-shell.selectExplorer")`);
    await page.waitForTimeout(3000);
    console.log(JSON.stringify({ explorer: await memory() }));
  }
  if (heapProfile !== "") {
    const { profile: sampled } = await cdp.send("HeapProfiler.getSamplingProfile");
    NodeFS.writeFileSync(heapProfile, JSON.stringify(sampled));
    console.error(`heap profile: ${heapProfile}`);
  }
  if (heapSnapshot !== "") {
    const out = NodeFS.openSync(heapSnapshot, "w");
    cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => NodeFS.writeSync(out, chunk));
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    NodeFS.closeSync(out);
    console.error(`heap snapshot: ${heapSnapshot}`);
  }
} else if (mode === "soak") {
  // The page left alone on its selection: what an hour of nothing costs.
  const seconds = Number(rest[0]);
  await page.waitForTimeout(20_000);
  await cdp.send("HeapProfiler.enable");
  console.log(JSON.stringify({ at: 0, ...(await memory()) }));
  if (heapProfile !== "") await cdp.send("HeapProfiler.startSampling", { samplingInterval: 4096 });
  for (let at = 30; at <= seconds; at += 30) {
    await page.waitForTimeout(30_000);
    console.log(JSON.stringify({ at, ...(await memory()) }));
  }
  if (heapProfile !== "") {
    const { profile: sampled } = await cdp.send("HeapProfiler.getSamplingProfile");
    NodeFS.writeFileSync(heapProfile, JSON.stringify(sampled));
    console.error(`heap profile: ${heapProfile}`);
  }
} else {
  console.error("Modes: threads | switch <rounds> <environmentId/threadId>... | soak <seconds>");
  process.exitCode = 1;
}
await context.close();
