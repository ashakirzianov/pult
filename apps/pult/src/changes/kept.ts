// The checkout each environment's Pult plugin keeps at main's tip, as its
// `monore/kept` answers (`pult/decisions`, `monore-kept-checkouts`), for the
// changes view's state line. Asked once `about` lists `monore-kept` on a
// connect, and again as the Stars' route is: when the environment's projects
// change, when a thread inside the kept folder starts or ends its work, on
// the server's status events for a kept checkout (a move, a failure), on the
// window's return, and every minute while it keeps a checkout, since nothing
// tells of a Get latest that starts and hangs, or of one that goes through
// with nothing to move after a failure. A server without the feature answers
// nothing, and the view adds nothing.
import { subscribe } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { connection } from "../connection/index.ts";
import { onDidChangePluginFeatures, pluginFeatures } from "../stars/about.ts";
import {
  type KeptAnswer,
  type KeptCheckout,
  readMonoreKept,
  MONORE_KEPT_FEATURE,
} from "../stars/plugin.ts";
import { threadStore } from "../threads/store.ts";

/** How long a burst of events settles before the page asks again. */
const REREAD_DELAY_MS = 300;
/** How often the page asks again while the plugin keeps a checkout, or cannot list them. */
const POLL_MS = 60_000;

interface Reading {
  features: ReadonlySet<string>;
  answer: KeptAnswer | undefined;
  /** The projects and the kept folder's threads' work the answer was read over. */
  trigger: string | undefined;
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The status follows of the answer's kept checkouts, by folder. */
  follows: Map<string, () => void>;
}

const readings = new Map<string, Reading>();
const listeners = new Set<() => void>();

const tell = () => {
  for (const listener of listeners) listener();
};

const slashed = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

const inside = (folder: string, path: string) => {
  const [root, each] = [slashed(folder), slashed(path)];
  return each === root || each.startsWith(`${root}/`);
};

function drop(environmentId: string, reading: Reading): void {
  clearTimeout(reading.timer);
  for (const stop of reading.follows.values()) stop();
  readings.delete(environmentId);
}

/** Follows every environment whose plugin's `about` lists `monore-kept` on this connect, and no other. */
function follow(): void {
  let changed = false;
  for (const [environmentId, reading] of readings) {
    const features = pluginFeatures(environmentId);
    if (features === reading.features) continue;
    drop(environmentId, reading);
    changed = true;
  }
  for (const environment of connection.environments) {
    const environmentId = environment.environmentId;
    const features = pluginFeatures(environmentId);
    if (readings.has(environmentId) || features?.has(MONORE_KEPT_FEATURE) !== true) continue;
    readings.set(environmentId, {
      features,
      answer: undefined,
      trigger: undefined,
      generation: 0,
      timer: undefined,
      follows: new Map(),
    });
    void read(environmentId);
  }
  if (changed) tell();
}

/** The environment's projects, and which of its threads inside a kept folder work; undefined before an answer. */
function triggerOf(environmentId: string, answer: KeptAnswer | undefined): string | undefined {
  if (answer === undefined) return undefined;
  const roots = [answer.folder, ...answer.checkouts.map((checkout) => checkout.dir)];
  const { projects, threads } = threadStore.get();
  return JSON.stringify([
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => `${project.id}:${project.root}`)
      .toSorted(),
    threads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.checkoutRoot !== null &&
          roots.some((root) => inside(root, thread.checkoutRoot!)),
      )
      .map((thread) => `${thread.id}:${thread.working}:${thread.latestRun?.startedAt}`)
      .toSorted(),
  ]);
}

function askIn(environmentId: string, ms: number): void {
  const reading = readings.get(environmentId);
  if (reading === undefined) return;
  clearTimeout(reading.timer);
  reading.timer = setTimeout(() => void read(environmentId), ms);
}

const askSoon = (environmentId: string) => askIn(environmentId, REREAD_DELAY_MS);

async function read(environmentId: string): Promise<void> {
  const reading = readings.get(environmentId);
  const credential = connection.credential(environmentId);
  if (reading === undefined || credential === undefined) return;
  const generation = ++reading.generation;
  let answer: KeptAnswer | undefined;
  try {
    answer = await readMonoreKept(credential);
  } catch (error) {
    if (readings.get(environmentId) !== reading || reading.generation !== generation) return;
    console.warn(
      `[pult-shell] could not read the kept monore checkout of ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    // The last answer stands until the next occasion asks again.
    if (reading.answer !== undefined && keeps(reading.answer)) askIn(environmentId, POLL_MS);
    return;
  }
  if (readings.get(environmentId) !== reading || reading.generation !== generation) return;
  take(environmentId, reading, answer);
  if (keeps(answer)) askIn(environmentId, POLL_MS);
}

/** Whether the answer has a kept checkout to watch, or the CLI's failure to list one. */
const keeps = (answer: KeptAnswer) => answer.checkouts.length > 0 || answer.unlisted !== null;

function take(environmentId: string, reading: Reading, answer: KeptAnswer): void {
  const before = JSON.stringify(reading.answer);
  reading.answer = answer;
  reading.trigger = triggerOf(environmentId, answer);
  const dirs = new Set(answer.checkouts.map((checkout) => checkout.dir));
  for (const [dir, stop] of reading.follows)
    if (!dirs.has(dir)) {
      stop();
      reading.follows.delete(dir);
    }
  for (const dir of dirs) {
    if (reading.follows.has(dir)) continue;
    // A passive observer: the mover's moves and failures publish there, and the page keeps no fetch loop running.
    let first = true;
    const stream = subscribe(WS_METHODS.subscribeVcsStatus, {
      cwd: dir,
      includeRemote: false,
    }).pipe(Stream.catchCause(() => Stream.empty));
    reading.follows.set(
      dir,
      connection.follow(environmentId, stream, () => {
        // Each subscription opens with the status as it stands, which the answer just read.
        if (first) first = false;
        else askSoon(environmentId);
      }),
    );
  }
  // A Get latest under way reads as stuck by the clock, so the line is drawn again while one runs.
  if (
    JSON.stringify(answer) !== before ||
    answer.checkouts.some((checkout) => checkout.running !== null)
  )
    tell();
}

function askOnChange(): void {
  for (const [environmentId, reading] of readings) {
    if (reading.answer === undefined) continue;
    if (triggerOf(environmentId, reading.answer) !== reading.trigger) askSoon(environmentId);
  }
}

/** Starts following the environments' kept checkouts; `onDidChangeKept` tells each new answer. */
export function startKept(): void {
  connection.onDidChange(follow);
  onDidChangePluginFeatures(follow);
  threadStore.subscribe(askOnChange);
  follow();
}

/** Asks every environment's plugin again, as the window's return does. */
export function rereadKept(): void {
  for (const environmentId of readings.keys()) askSoon(environmentId);
}

/** What the environment's plugin answers for the checkout at `root`: the kept checkout there, or the CLI's failure to list one when `root` is the kept folder; undefined for any other. */
export function keptAt(
  environmentId: string,
  root: string,
): { readonly answer: KeptAnswer; readonly checkout: KeptCheckout | undefined } | undefined {
  const answer = readings.get(environmentId)?.answer;
  if (answer === undefined) return undefined;
  const checkout = answer.checkouts.find((each) => slashed(each.dir) === slashed(root));
  if (checkout !== undefined) return { answer, checkout };
  return answer.unlisted !== null && slashed(answer.folder) === slashed(root)
    ? { answer, checkout: undefined }
    : undefined;
}

/** The folder of the environment's kept checkout, the checkout of `/`, as its plugin last answered; null while it keeps none. */
export function keptRoot(environmentId: string): string | null {
  return readings.get(environmentId)?.answer?.checkouts[0]?.dir ?? null;
}

/** Calls `listener` whenever an answer changes. */
export function onDidChangeKept(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
