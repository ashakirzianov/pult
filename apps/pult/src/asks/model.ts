// The asks (Beta's `designs/ask-model.md`) as the page holds them: on each held
// environment, what its Pult plugin's `asks` route serves, where `about` lists
// `asks`, read on each connect and again a moment after the environment's
// threads start or end a run, settle, un-settle or go (a poster's ask is made
// in its run, and a plain thread's asks follow it), when the window comes
// back, at the next snooze's end, and after each of the page's own actions.
// Nothing polls.
import { getService, INotificationService } from "@codingame/monaco-vscode-api";

import { connection } from "../connection/index.ts";
import { onDidChangePluginFeatures, pluginFeatures } from "../stars/about.ts";
import {
  type AskAction,
  ASKS_FEATURE,
  type AsksAnswer,
  actOnAsk,
  type Credential,
  readAsks,
} from "../stars/plugin.ts";
import { threadStore } from "../threads/store.ts";
import type { PageAsk } from "./asks.ts";

const REREAD_DELAY_MS = 300;
const RETRY_DELAY_MS = 30_000;
/** The longest a timer waits, as browsers count it. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

interface Reading {
  features: ReadonlySet<string> | undefined;
  answer: AsksAnswer | undefined;
  /** Whether `answer` was taken since the environment last became ready, so it is this connect's (`notify.ts`). */
  answeredSinceReady: boolean;
  wasReady: boolean;
  /** The environment's threads' runs and settles, which, changing, make the page ask again. */
  trigger: string | undefined;
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** At the next snooze's end, when an ask comes back to Inbox. */
  wake: ReturnType<typeof setTimeout> | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AsksModel {
  private readonly readings = new Map<string, Reading>();
  private asks: ReadonlyArray<PageAsk> = [];
  private readonly listeners = new Set<() => void>();

  start(): void {
    connection.onDidChange(() => this.follow());
    onDidChangePluginFeatures(() => this.follow());
    threadStore.subscribe(() => this.askOnChange());
    window.addEventListener("focus", () => {
      for (const environmentId of this.readings.keys()) void this.read(environmentId);
    });
    this.follow();
  }

  get(): ReadonlyArray<PageAsk> {
    return this.asks;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  answeredOn(environmentId: string): boolean {
    return this.readings.get(environmentId)?.answeredSinceReady === true;
  }

  private follow(): void {
    for (const [environmentId, reading] of this.readings) {
      if (connection.environment(environmentId) !== undefined) continue;
      clearTimeout(reading.timer);
      clearTimeout(reading.wake);
      this.readings.delete(environmentId);
    }
    for (const environment of connection.environments) {
      const environmentId = environment.environmentId;
      let reading = this.readings.get(environmentId);
      if (reading === undefined) {
        reading = {
          features: undefined,
          answer: undefined,
          answeredSinceReady: false,
          wasReady: false,
          trigger: undefined,
          generation: 0,
          timer: undefined,
          wake: undefined,
        };
        this.readings.set(environmentId, reading);
      }
      const ready = environment.phase === "ready";
      if (!ready || !reading.wasReady) reading.answeredSinceReady = false;
      reading.wasReady = ready;
      const features = pluginFeatures(environmentId);
      if (features === undefined || features === reading.features) continue;
      reading.features = features;
      if (features.has(ASKS_FEATURE)) void this.read(environmentId);
      else {
        reading.generation++;
        reading.answer = undefined;
      }
    }
    this.update();
  }

  private credential(environmentId: string): Credential {
    const credential = connection.credential(environmentId);
    if (credential === undefined) throw new Error(`the page holds no bearer for ${environmentId}`);
    return credential;
  }

  /** Asks the environment's plugin for its asks again, where its `about` lists them; a failure keeps the last answer and tries again. */
  async read(environmentId: string): Promise<void> {
    const reading = this.readings.get(environmentId);
    if (reading?.features?.has(ASKS_FEATURE) !== true) return;
    const generation = ++reading.generation;
    const current = () =>
      reading.generation === generation && this.readings.get(environmentId) === reading;
    try {
      const answer = await readAsks(this.credential(environmentId));
      if (!current()) return;
      reading.answer = answer;
      reading.answeredSinceReady = connection.environment(environmentId)?.phase === "ready";
      reading.trigger = this.triggerOf(environmentId);
      this.wakeAtNextSnoozeEnd(environmentId, reading);
      this.update();
    } catch (error) {
      if (!current()) return;
      console.warn(
        `[pult-shell] could not read the asks of ${environmentId}: ${errorMessage(error)}`,
      );
      clearTimeout(reading.timer);
      reading.timer = setTimeout(() => void this.read(environmentId), RETRY_DELAY_MS);
    }
  }

  private askSoon(environmentId: string, reading: Reading): void {
    clearTimeout(reading.timer);
    reading.timer = setTimeout(() => void this.read(environmentId), REREAD_DELAY_MS);
  }

  private wakeAtNextSnoozeEnd(environmentId: string, reading: Reading): void {
    clearTimeout(reading.wake);
    const ends = (reading.answer?.asks ?? []).flatMap((ask) =>
      ask.status === "snoozed" && ask.snoozedUntil !== null ? [Date.parse(ask.snoozedUntil)] : [],
    );
    if (ends.length === 0) return;
    const wait = Math.min(Math.max(0, Math.min(...ends) - Date.now()) + 1_000, LONGEST_TIMER_MS);
    reading.wake = setTimeout(() => void this.read(environmentId), wait);
  }

  /** The environment's threads, each with whether it is settled and how its run stands; undefined until they are in. */
  private triggerOf(environmentId: string): string | undefined {
    if (threadStore.environment(environmentId)?.loaded !== true) return undefined;
    return JSON.stringify(
      threadStore
        .get()
        .threads.filter((thread) => thread.environmentId === environmentId)
        .map(
          (thread) =>
            `${thread.id}:${thread.settled}:${thread.working}:${thread.latestRun?.status ?? ""}`,
        )
        .toSorted(),
    );
  }

  private askOnChange(): void {
    for (const [environmentId, reading] of this.readings) {
      if (reading.answer === undefined) continue;
      const trigger = this.triggerOf(environmentId);
      if (trigger === reading.trigger) continue;
      const known = reading.trigger !== undefined;
      reading.trigger = trigger;
      if (known && trigger !== undefined) this.askSoon(environmentId, reading);
    }
  }

  /** The page's own action on an ask, its answer drawn at once, then the asks read again; a refusal told by a notification with the plugin's words. */
  async act(ask: PageAsk, action: AskAction): Promise<boolean> {
    const reading = this.readings.get(ask.environmentId);
    try {
      const acted = await actOnAsk(this.credential(ask.environmentId), ask.id, action);
      if (reading?.answer !== undefined)
        reading.answer = {
          ...reading.answer,
          asks: reading.answer.asks.map((each) =>
            each.id === ask.id ? { ...acted, prefix: each.prefix } : each,
          ),
        };
      this.update();
      return true;
    } catch (error) {
      (await getService(INotificationService)).error(
        `Pult could not ${action.kind === "snooze" ? (action.until === null ? "wake" : "snooze") : action.kind === "unsettle" ? "un-settle" : action.kind === "replied" ? "mark as replied" : "settle"} the ask “${ask.title}”: ${errorMessage(error)}`,
      );
      return false;
    } finally {
      void this.read(ask.environmentId);
    }
  }

  private update(): void {
    const next = connection.environments.flatMap((environment) => {
      const answer = this.readings.get(environment.environmentId)?.answer;
      return (answer?.asks ?? []).map((ask): PageAsk => ({
        ...ask,
        environmentId: environment.environmentId,
      }));
    });
    if (JSON.stringify(next) === JSON.stringify(this.asks)) return;
    this.asks = next;
    for (const listener of this.listeners) listener();
  }
}

const model = new AsksModel();

/** Starts following the asks, after the plugin's `about` and the thread model. */
export function startAsks(): void {
  model.start();
}

/** Every held environment's asks, in the environments' order, each one's by `posted`, settled included. */
export const askStore = {
  get: () => model.get(),
  subscribe: (listener: () => void) => model.subscribe(listener),
};

export const asksAnsweredOn = (environmentId: string) => model.answeredOn(environmentId);
export const actOnPageAsk = (ask: PageAsk, action: AskAction) => model.act(ask, action);
export const askById = (environmentId: string, id: string) =>
  model.get().find((ask) => ask.environmentId === environmentId && ask.id === id);
