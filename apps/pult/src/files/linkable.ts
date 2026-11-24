// Whether a file chip the thread view draws opens anything (`pult/decisions`, `thread-file-links`):
// the click's own rule, `resolveThreadPath`, run on the click's own path, its inputs batched and
// shared, apart from the workbench so `node --test src/files/linkable.test.ts` can run it. The
// view's gate (`view/fileLinkGate.tsx`) reads it through the host's `fileLinks`; the page's
// instance, on the store and the servers, is `threadFileLinks` in `src/threads/files.ts`.
import { FILESYSTEM_METADATA_BATCH_LIMIT } from "@t3tools/contracts";

import type { FileLinkRef, FileLinks } from "../../view/host.ts";
import type { Checkout } from "../changes/checkouts.ts";
import { toHostPath } from "./paths.ts";
import { type ResolveInput, resolveThreadPath } from "./resolve.ts";

export interface FileLinkSources {
  /** Waits for the store to list the environment's projects, as the click does (`whenListed`). */
  readonly whenListed: (environmentId: string) => Promise<void>;
  /** What the click resolves the thread's paths with but the path and `exists`; undefined for a thread the store does not hold. */
  readonly input: (
    environmentId: string,
    threadId: string,
  ) => Omit<ResolveInput, "path" | "exists"> | undefined;
  /** The server's `filesystem.getMetadata` of host paths: an entry per path, null where nothing is. */
  readonly getMetadata: (
    environmentId: string,
    paths: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<unknown>>;
  /** The thread's latest run's end: a change checks its `no` verdicts again, since an agent names a file before it writes it. */
  readonly runEnd: (environmentId: string, threadId: string) => string | null;
  /** The environment's checkouts and kept xaxis root, as one value: a change drops every verdict of the environment. */
  readonly roots: (environmentId: string) => string;
  /** How long changed verdicts wait to reach their gates together: each publish restyles the thread view once, whatever it swaps. */
  readonly publishMs: number;
  /** Calls `listener` whenever `runEnd` or `roots` may have changed. */
  readonly onDidChange: (listener: () => void) => void;
}

/** Searches in flight per environment, at most. */
const SEARCHES = 4;

type State = "pending" | "yes" | "no" | "failed";

interface Thread {
  runEnd: string | null;
  /** Moves on as its verdicts are dropped, so a check started before publishes nothing. */
  revision: number;
  readonly states: Map<string, State>;
}

interface Environment {
  roots: string;
  readonly threads: Map<string, Thread>;
  /** Each search by checkout root and key, until a run ends or the roots change. */
  searches: Map<string, Promise<ReadonlyArray<string>>>;
  /** Literal paths waiting for this turn's `getMetadata`. */
  batch: Map<
    string,
    Array<{ resolve: (exists: boolean) => void; reject: (error: unknown) => void }>
  >;
  active: number;
  readonly waiting: Array<() => void>;
  warned: boolean;
}

/** The page's verdicts, kept for its life; `counts` is what they cost, for measuring (`window.pult.fileLinks()`). */
export function makeFileLinks(sources: FileLinkSources) {
  const environments = new Map<string, Environment>();
  const listeners = new Map<string, Set<() => void>>();
  const counts = { metadataCalls: 0, metadataPaths: 0, searches: 0 };
  const keyOf = (ref: FileLinkRef) => `${ref.environmentId}\0${ref.threadId}\0${ref.path}`;
  let changed = new Set<string>();
  const notify = (ref: FileLinkRef) => {
    if (changed.size === 0)
      setTimeout(() => {
        const keys = changed;
        changed = new Set();
        for (const key of keys) for (const listener of listeners.get(key) ?? []) listener();
      }, sources.publishMs);
    changed.add(keyOf(ref));
  };

  const environmentOf = (environmentId: string) => {
    let environment = environments.get(environmentId);
    if (environment === undefined) {
      environment = {
        roots: sources.roots(environmentId),
        threads: new Map(),
        searches: new Map(),
        batch: new Map(),
        active: 0,
        waiting: [],
        warned: false,
      };
      environments.set(environmentId, environment);
    }
    return environment;
  };

  const flush = (environmentId: string, environment: Environment) => {
    const batch = [...environment.batch];
    environment.batch = new Map();
    for (let start = 0; start < batch.length; start += FILESYSTEM_METADATA_BATCH_LIMIT) {
      const chunk = batch.slice(start, start + FILESYSTEM_METADATA_BATCH_LIMIT);
      counts.metadataCalls += 1;
      counts.metadataPaths += chunk.length;
      sources
        .getMetadata(
          environmentId,
          chunk.map(([path]) => path),
        )
        .then(
          (entries) =>
            chunk.forEach(([, waiters], index) => {
              for (const waiter of waiters) waiter.resolve((entries[index] ?? null) !== null);
            }),
          (error: unknown) => {
            for (const [, waiters] of chunk) for (const waiter of waiters) waiter.reject(error);
          },
        );
    }
  };

  /** Every literal path asked in one turn of the event loop goes in one `getMetadata` call. */
  const exists = (environmentId: string, environment: Environment, uriPath: string) =>
    new Promise<boolean>((resolve, reject) => {
      const path = toHostPath(uriPath);
      if (environment.batch.size === 0) setTimeout(() => flush(environmentId, environment), 0);
      const waiters = environment.batch.get(path) ?? [];
      waiters.push({ resolve, reject });
      environment.batch.set(path, waiters);
    });

  const search = (
    environment: Environment,
    run: ResolveInput["search"],
    checkout: Checkout,
    key: string,
  ) => {
    const memo = `${checkout.root}\0${key}`;
    const known = environment.searches.get(memo);
    if (known !== undefined) return known;
    const searches = environment.searches;
    const searched = (async () => {
      // A search ending hands its slot to the next waiting.
      if (environment.active < SEARCHES) environment.active += 1;
      else await new Promise<void>((resolve) => environment.waiting.push(resolve));
      counts.searches += 1;
      try {
        return await run(checkout, key);
      } finally {
        const next = environment.waiting.shift();
        if (next === undefined) environment.active -= 1;
        else next();
      }
    })();
    searches.set(memo, searched);
    searched.catch(() => {
      if (searches.get(memo) === searched) searches.delete(memo);
    });
    return searched;
  };

  const check = async (ref: FileLinkRef, environment: Environment, thread: Thread) => {
    const revision = thread.revision;
    await sources.whenListed(ref.environmentId);
    const input = sources.input(ref.environmentId, ref.threadId);
    let state: State;
    if (input === undefined) state = "failed";
    else {
      let failed = false;
      const resolution = await resolveThreadPath({
        ...input,
        path: ref.path,
        exists: (path) =>
          exists(ref.environmentId, environment, path).catch((error: unknown) => {
            failed = true;
            warn(ref.environmentId, environment, error);
            return false;
          }),
        search: (checkout, key) =>
          search(environment, input.search, checkout, key).catch((error: unknown) => {
            failed = true;
            warn(ref.environmentId, environment, error);
            throw error;
          }),
      });
      state =
        resolution.kind === "open" || resolution.kind === "pick" ? "yes" : failed ? "failed" : "no";
    }
    if (thread.revision !== revision) return;
    const before = thread.states.get(ref.path);
    // A `no` checked again after a run keeps its answer through a failure.
    if (state === "failed" && before === "no") return;
    thread.states.set(ref.path, state);
    if (state !== "failed" && state !== before) notify(ref);
  };

  /** A failed check leaves the chip, told once per environment. */
  const warn = (environmentId: string, environment: Environment, error: unknown) => {
    if (environment.warned) return;
    environment.warned = true;
    console.warn(
      `Pult could not check the file links of ${environmentId}; they stay links.`,
      error,
    );
  };

  /** Drops the thread's verdicts: a yes or no's gate re-asks as it changes; one read as unknown before and after, pending or failed, is asked again here while a gate shows it. */
  const drop = (environmentId: string, threadId: string, thread: Thread) => {
    thread.revision += 1;
    // A copy: `ask` puts a path back into the map.
    for (const [path, state] of Array.from(thread.states)) {
      thread.states.delete(path);
      const ref = { environmentId, threadId, path };
      if (state === "yes" || state === "no") notify(ref);
      else if (listeners.has(keyOf(ref))) ask(ref);
    }
  };

  /** After the thread's run: a `no` a gate shows is checked again and reads `no` until its new answer is in, its gate told only if that differs; every other `no`, pending or failed verdict is dropped, asked again here while a gate shows it. */
  const recheck = (
    environmentId: string,
    environment: Environment,
    threadId: string,
    thread: Thread,
  ) => {
    const revision = ++thread.revision;
    // A copy: `ask` puts a path back into the map.
    for (const [path, state] of Array.from(thread.states)) {
      if (state === "yes") continue;
      const ref = { environmentId, threadId, path };
      const shown = listeners.has(keyOf(ref));
      if (state === "no" && shown) {
        // The server refreshes its index after the run without telling anyone: the check waits as
        // long as a gate's own ask of a dropped verdict did, after the publish.
        setTimeout(() => {
          if (thread.revision === revision) void check(ref, environment, thread);
        }, sources.publishMs);
        continue;
      }
      thread.states.delete(path);
      if (shown) ask(ref);
    }
  };

  sources.onDidChange(() => {
    for (const [environmentId, environment] of environments) {
      const roots = sources.roots(environmentId);
      if (roots !== environment.roots) {
        environment.roots = roots;
        environment.searches = new Map();
        for (const [threadId, thread] of environment.threads) drop(environmentId, threadId, thread);
        continue;
      }
      for (const [threadId, thread] of environment.threads) {
        const runEnd = sources.runEnd(environmentId, threadId);
        if (runEnd === thread.runEnd) continue;
        thread.runEnd = runEnd;
        // The server refreshes its index after every run.
        environment.searches = new Map();
        recheck(environmentId, environment, threadId, thread);
      }
    }
  });

  const ask = (ref: FileLinkRef) => {
    const environment = environmentOf(ref.environmentId);
    let thread = environment.threads.get(ref.threadId);
    if (thread === undefined) {
      thread = {
        runEnd: sources.runEnd(ref.environmentId, ref.threadId),
        revision: 0,
        states: new Map(),
      };
      environment.threads.set(ref.threadId, thread);
    }
    if (thread.states.has(ref.path)) return;
    thread.states.set(ref.path, "pending");
    void check(ref, environment, thread);
  };

  return {
    verdict: (ref) => {
      const state = environments
        .get(ref.environmentId)
        ?.threads.get(ref.threadId)
        ?.states.get(ref.path);
      return state === "yes" ? true : state === "no" ? false : undefined;
    },
    ask,
    subscribe: (ref, listener) => {
      const key = keyOf(ref);
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    counts: () => ({ ...counts }),
  } satisfies FileLinks & { counts: () => typeof counts };
}
