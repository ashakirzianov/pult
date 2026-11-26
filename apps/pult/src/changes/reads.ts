// One checkout's diff reads, apart from the workbench so
// `node --test src/changes/reads.test.ts` can run it.

/** A read's outcome: its answer, or what it failed with. */
export type Settled<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown };

export interface CheckoutReadsOptions<A> {
  readonly read: () => Promise<A>;
  /** What makes two answers the same: one equal to the last delivered is dropped. */
  readonly keyOf: (answer: Settled<A>) => string;
  /** The newest read's answer, unless it equals the last delivered. */
  readonly delivered: (answer: Settled<A>) => void;
  /** The newest read's answer, equal to the last delivered. */
  readonly unchanged: () => void;
  /** The newest read ended after a file changed during it: one more read is owed, which the caller times. */
  readonly followUp: () => void;
}

/**
 * A checkout's diff reads: one in flight unless forced, the newest winning;
 * a file changed during a read owes one read after it, however many changed;
 * an answer equal to the last delivered is dropped.
 */
export class CheckoutReads<A> {
  private generation = 0;
  private inFlight: Promise<void> | undefined;
  /** A file changed since the read in flight began. */
  private owed = false;
  private lastKey: string | undefined;
  private readonly options: CheckoutReadsOptions<A>;

  constructor(options: CheckoutReadsOptions<A>) {
    this.options = options;
  }

  /** The read in flight, if any. */
  get loading(): Promise<void> | undefined {
    return this.inFlight;
  }

  /** The read in flight unless `force`, else a new one, which supersedes it. */
  read(force: boolean): Promise<void> {
    if (this.inFlight !== undefined && !force) return this.inFlight;
    const generation = ++this.generation;
    // This read begins after every change so far.
    this.owed = false;
    const settle = (answer: Settled<A>) => {
      if (generation !== this.generation) return;
      this.inFlight = undefined;
      const key = this.options.keyOf(answer);
      if (key === this.lastKey) this.options.unchanged();
      else {
        this.lastKey = key;
        this.options.delivered(answer);
      }
      if (this.owed) {
        this.owed = false;
        this.options.followUp();
      }
    };
    const inFlight = this.options.read().then(
      (value) => settle({ ok: true, value }),
      (error: unknown) => settle({ ok: false, error }),
    );
    this.inFlight = inFlight;
    return inFlight;
  }

  /** A file changed: read now, or once the read in flight ends. */
  stale(): void {
    if (this.inFlight === undefined) void this.read(false);
    else this.owed = true;
  }

  /** Forgets the last delivered answer, so the next is delivered whatever it is. */
  reset(): void {
    this.lastKey = undefined;
  }
}
