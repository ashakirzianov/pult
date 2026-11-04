import { getService, IStorageService } from "@codingame/monaco-vscode-api";
import {
  StorageScope,
  StorageTarget,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { request } from "@t3tools/client-runtime/rpc";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { environmentServer } from "../files/server.ts";
import { threadsWithUnsentMessages } from "../panel/drafts.ts";
import { settleQuietly } from "../threads/park.ts";
import { scopedKey, type ShellThread, threadStore } from "../threads/store.ts";
import { refreshTranscript } from "./foldState.ts";
import { readWholeProjection } from "./history.ts";
import { forgetTranscriptEnd, rereadStars, starStore } from "./model.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { asleepBy, type Wakefulness, wakefulness } from "./sleep.ts";
import { conversationsOf, type StarHome } from "./stars.ts";
import {
  formatTranscript,
  transcriptHead,
  transcriptName,
  transcriptsFolder,
} from "./transcript.ts";

/** The longest the page waits between looks at a deadline: a timer's clock stops while the machine sleeps, as the thread model's wake timer knows. */
const CLOCK_CHECK_MS = 60_000;
/** How long a failed read, settle or write waits before the page tries it again. */
const RETRY_MS = 5 * 60_000;
/** How many transcripts the page checks or writes at once. */
const TRANSCRIPTS_AT_ONCE = 2;
/** The workbench storage's record of the whole transcripts found or written, by `scopedKey` the settlement each was for. */
const RECORD_STORAGE_KEY = "pult.stars.transcripts";
/** How many conversations the record keeps, the latest kept: one it forgot has its transcript's front matter read once more. */
const RECORD_LIMIT = 1_000;

/**
 * An open conversation as the page last evaluated it: by what of its shell
 * row it read, its wakefulness once its projection is in (undefined while it
 * is read, or after a failed read), and when it was last read.
 */
interface Evaluation {
  readonly stamp: string;
  reading: boolean;
  wakefulness: Wakefulness | undefined;
  readAt: number;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

/** The conversation's projection over the socket: a window of its latest turns, whole in its runs, subagents and pending requests, which the sleep rule reads (`sleep.ts`). */
const readProjection = (thread: Pick<ShellThread, "environmentId" | "id">) =>
  connection.run(
    thread.environmentId,
    request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
      threadId: ThreadId.make(thread.id),
    }),
  );

/**
 * The conversation's whole projection, for its transcript, from its
 * environment's HTTP API (`history.ts`); where that cannot be read, a proxy
 * refusing `/api` while the socket works, the socket's window of its latest
 * turns, partial.
 */
async function readHistory(thread: Pick<ShellThread, "environmentId" | "id">) {
  const credential = connection.credential(thread.environmentId);
  try {
    if (credential === undefined) throw new Error("The page holds no bearer for its environment.");
    return { projection: await readWholeProjection(credential, thread.id), partial: false };
  } catch (error) {
    console.warn(
      `[pult-shell] could not read the whole of the Star's conversation ${thread.id}, its transcript from its latest turns alone: ${errorMessage(error)}`,
    );
    return { projection: await readProjection(thread), partial: true };
  }
}

/** What of a shell row can change a conversation's wakefulness: its projection is read again when it changes. */
const stampOf = (thread: ShellThread) =>
  JSON.stringify([thread.updatedAt, thread.latestRun, thread.canSnooze]);

/** Whether a thread below the conversation works, its subagents' and theirs, as the store has them: a subagent thread's run holds the Star awake as the conversation's own does. */
const lineageWorks = (thread: ShellThread, threads: ReadonlyArray<ShellThread>) =>
  threads.some(
    (each) =>
      each.environmentId === thread.environmentId &&
      each.rootId === thread.id &&
      each.id !== thread.id &&
      each.working,
  );

/** Whether the conversation's composer holds anything the user wrote or attached, by the composer store. */
async function hasUnsentMessage(
  thread: Pick<ShellThread, "environmentId" | "id">,
): Promise<boolean> {
  const { composerHasContent } = await import("../../thread-view/shell/drafts.ts");
  return composerHasContent({
    kind: "thread",
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
}

const sameInstant = (left: string | undefined, right: string) =>
  left !== undefined && Date.parse(left) === Date.parse(right);

/**
 * The Stars' conversations, kept by the page (xaxis `pult/issues/star-sleep`):
 * it puts a Star to sleep when its conversation's deadline passes
 * (`sleep.ts`), and writes the transcript of every conversation it sees
 * asleep (`transcript.ts`), whoever settled it. Lazily, whenever it looks:
 * on every change of the threads or the Stars, and while a deadline is
 * pending on a timer to it, checking the clock at least once a minute. An
 * open conversation at rest has its projection read once per change of its
 * shell row; at its deadline the projection is read again and, the rule
 * still holding, the thread is settled, the server refusing it if a run
 * started meanwhile. A settled conversation's transcript is written where it
 * is missing, or its `ended` is not the thread's settlement (un-settled and
 * settled again) or partial, and only when its text differs, so pages racing
 * write one file; each one checked once per settlement per page session,
 * and not at all while the workbench's storage records its transcript whole
 * for its settlement and its folder lists it. A server without thread
 * settlement keeps its Star awake. Held awake too while a thread below the
 * conversation works, or its composer holds an unsent message. Nothing runs
 * while Show Star is off.
 */
class StarConversations {
  private readonly evaluations = new Map<string, Evaluation>();
  private readonly settling = new Set<string>();
  /** The settlement each conversation's transcript was found or written for in this page session, by `scopedKey`. */
  private readonly kept = new Map<string, string>();
  /** Across sessions, from the workbench's storage: the settlement each whole transcript was found or written for; undefined until read. */
  private record: Map<string, string> | undefined;
  private readonly keeping = new Set<string>();
  private readonly keepFailedAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    void this.readRecord();
    threadStore.subscribe(() => this.update());
    starStore.subscribe(() => this.update());
    starEnabled.subscribe(() => this.update());
    // Loads the composer store, without the rest of the view, and looks again as a composer fills or empties.
    threadsWithUnsentMessages.subscribe(() => this.update());
    this.update();
  }

  private update(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!starSettingKnown() || !starEnabled.get()) return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    const open = new Set<string>();
    const threads = threadStore.get().threads;
    const unsent = threadsWithUnsentMessages.get();
    for (const star of starStore.get()) {
      for (const thread of conversationsOf(star.homes, threads)) {
        const key = scopedKey(thread.environmentId, thread.id);
        if (thread.settled) {
          const retry = this.keep(star.homes, thread, now);
          if (retry !== undefined) next = Math.min(next, retry);
          continue;
        }
        if (
          threadStore.environment(thread.environmentId)?.features.settlement !== true ||
          thread.working ||
          lineageWorks(thread, threads)
        )
          continue;
        // What the user wrote and has not sent would drop out of view with the conversation.
        if (unsent.has(key)) continue;
        open.add(key);
        const stamp = stampOf(thread);
        let evaluation = this.evaluations.get(key);
        if (evaluation?.stamp !== stamp) {
          evaluation = { stamp, reading: false, wakefulness: undefined, readAt: now };
          this.evaluations.set(key, evaluation);
          void this.evaluate(thread, evaluation);
          continue;
        }
        if (evaluation.reading) continue;
        const state = evaluation.wakefulness;
        if (state?.kind === "deadline") {
          if (asleepBy(state, now)) void this.sleep(thread, evaluation);
          else next = Math.min(next, state.at);
          continue;
        }
        // Held, or not read: looked at again a while later, since what holds it, a held queue's message, may go without a change of its shell row.
        if (now - evaluation.readAt >= RETRY_MS) void this.evaluate(thread, evaluation);
        else next = Math.min(next, evaluation.readAt + RETRY_MS);
      }
    }
    for (const key of this.evaluations.keys()) if (!open.has(key)) this.evaluations.delete(key);
    if (next !== Number.POSITIVE_INFINITY)
      this.timer = setTimeout(
        () => this.update(),
        Math.min(Math.max(next - now, 0) + 1, CLOCK_CHECK_MS),
      );
  }

  /** Reads the conversation's projection and its wakefulness by it, then looks again. */
  private async evaluate(thread: ShellThread, evaluation: Evaluation): Promise<void> {
    evaluation.reading = true;
    try {
      evaluation.wakefulness = wakefulness(await readProjection(thread));
    } catch (error) {
      console.warn(
        `[pult-shell] could not read the Star's conversation ${thread.id}: ${errorMessage(error)}`,
      );
      evaluation.wakefulness = undefined;
    }
    evaluation.reading = false;
    evaluation.readAt = Date.now();
    if (this.evaluations.get(scopedKey(thread.environmentId, thread.id)) === evaluation)
      this.update();
  }

  /** Puts the conversation to sleep once its fresh projection says so: settles it, its transcript following as the page sees it settled. */
  private async sleep(thread: ShellThread, evaluation: Evaluation): Promise<void> {
    const key = scopedKey(thread.environmentId, thread.id);
    if (this.settling.has(key)) return;
    this.settling.add(key);
    try {
      const projection = await readProjection(thread);
      const state = wakefulness(projection);
      evaluation.wakefulness = state;
      evaluation.readAt = Date.now();
      const settled = projection.thread.settledOverride === "settled";
      // Asked at the last moment of the store itself, loaded by now if it was not yet.
      const unsent = await hasUnsentMessage(thread);
      if (!settled && !unsent && asleepBy(state, Date.now())) await settleQuietly(thread);
      // Asleep, by this page or another: the store brings the settlement, and with it the transcript.
      if (settled || (!unsent && asleepBy(state, Date.now()))) evaluation.wakefulness = undefined;
    } catch (error) {
      console.warn(
        `[pult-shell] could not put the Star's conversation ${thread.id} to sleep: ${errorMessage(error)}`,
      );
      // Read again a while later, as one held awake is.
      evaluation.wakefulness = undefined;
      evaluation.readAt = Date.now();
    } finally {
      this.settling.delete(key);
    }
    this.update();
  }

  /**
   * Sees to a settled conversation's transcript in its environment's home,
   * once per settlement, a few at a time; when it next may try again after a
   * failure, if it is waiting on one.
   */
  private keep(
    homes: ReadonlyArray<StarHome>,
    thread: ShellThread,
    now: number,
  ): number | undefined {
    const key = scopedKey(thread.environmentId, thread.id);
    const settledAt = thread.settledAt;
    if (
      settledAt === null ||
      this.record === undefined ||
      this.kept.get(key) === settledAt ||
      this.keeping.has(key)
    )
      return undefined;
    const home = homes.find((each) => each.environmentId === thread.environmentId);
    // Recorded whole for this settlement and listed still: trusted, its file not read.
    if (
      this.record.get(key) === settledAt &&
      home?.transcripts.includes(transcriptName(thread.createdAt, thread.id))
    ) {
      this.kept.set(key, settledAt);
      return undefined;
    }
    const failedAt = this.keepFailedAt.get(key);
    if (failedAt !== undefined && now - failedAt < RETRY_MS) return failedAt + RETRY_MS;
    if (
      home === undefined ||
      connection.environment(home.environmentId)?.phase !== "ready" ||
      this.keeping.size >= TRANSCRIPTS_AT_ONCE
    )
      return undefined;
    this.keeping.add(key);
    void this.write(home, thread, settledAt)
      .then(
        (whole) => {
          this.kept.set(key, settledAt);
          this.keepFailedAt.delete(key);
          if (whole) void this.remember(key, settledAt);
        },
        (error: unknown) => {
          console.warn(
            `[pult-shell] could not write the transcript of the Star's conversation ${thread.id}: ${errorMessage(error)}`,
          );
          this.keepFailedAt.set(key, Date.now());
        },
      )
      .finally(() => {
        this.keeping.delete(key);
        this.update();
      });
    return undefined;
  }

  /**
   * Writes the transcript where it is missing, ended otherwise or partial,
   * and only when its text differs from the file's; whether the file then
   * holds the whole conversation as of `settledAt`.
   */
  private async write(home: StarHome, thread: ShellThread, settledAt: string): Promise<boolean> {
    const name = transcriptName(thread.createdAt, thread.id);
    const relativePath = `${transcriptsFolder(home.environmentId)}/${name}`;
    const server = environmentServer(home.environmentId);
    const existing = home.transcripts.includes(name)
      ? await server.readFile({ cwd: home.root, relativePath, allowMissing: true })
      : undefined;
    const present = existing !== undefined && existing.exists !== false;
    const head = present ? transcriptHead(existing.contents) : undefined;
    if (head !== undefined && sameInstant(head.ended, settledAt) && !head.partial) return true;
    const { projection, partial } = await readHistory(thread);
    const contents = formatTranscript(
      projection,
      threadStore.environment(home.environmentId)?.name ?? home.environmentId,
      { partial },
    );
    // Un-settled since: its next settlement writes it.
    if (contents === undefined) return false;
    const whole = !partial && sameInstant(transcriptHead(contents)?.ended, settledAt);
    if (present && !existing.truncated && existing.contents === contents) return whole;
    await server.writeFile({ cwd: home.root, relativePath, contents });
    refreshTranscript(home.environmentId, home.root, name);
    forgetTranscriptEnd(home.environmentId, home.root, name);
    await rereadStars(home.environmentId);
    return whole;
  }

  /** Reads the record of whole transcripts from the workbench's storage, then looks again. */
  private async readRecord(): Promise<void> {
    let entries: Array<[string, string]> = [];
    try {
      const stored = (await getService(IStorageService)).get(
        RECORD_STORAGE_KEY,
        StorageScope.APPLICATION,
      );
      const parsed: unknown = stored === undefined ? {} : JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) {
        entries = Object.entries(parsed).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value] as [string, string]] : [],
        );
      }
    } catch (error) {
      console.warn(
        `[pult-shell] could not read the record of the Stars' transcripts: ${errorMessage(error)}`,
      );
    }
    this.record = new Map(entries);
    this.update();
  }

  /** Records a whole transcript for its settlement, the latest last, the oldest let go of past the limit. */
  private async remember(key: string, settledAt: string): Promise<void> {
    if (this.record === undefined || this.record.get(key) === settledAt) return;
    this.record.delete(key);
    this.record.set(key, settledAt);
    for (const oldest of this.record.keys()) {
      if (this.record.size <= RECORD_LIMIT) break;
      this.record.delete(oldest);
    }
    (await getService(IStorageService)).store(
      RECORD_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(this.record)),
      StorageScope.APPLICATION,
      StorageTarget.MACHINE,
    );
  }
}

const conversations = new StarConversations();

/** Starts keeping the Stars' conversations, after the Stars' model, on the page's thread model. */
export function startStarConversations(): void {
  conversations.start();
}
