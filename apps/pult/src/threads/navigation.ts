/**
 * Pult's back-and-forward history of places (`selection.ts`'s Go Back and Go
 * Forward): each entry a place, a selection and its active tab there, in the
 * order they were visited. Generic over the entry, so it is tested without
 * a workbench. It lives in memory, as the workbench's own stacks do.
 */
export class PlaceHistory<Entry> {
  #entries: Entry[] = [];
  #index = -1;
  readonly #same: (left: Entry, right: Entry) => boolean;
  readonly #cap: number;

  /** `same` tells whether two entries are one place; `cap` is the stock stack's size. */
  constructor(same: (left: Entry, right: Entry) => boolean, cap = 50) {
    this.#same = same;
    this.#cap = cap;
  }

  /**
   * Records arriving at `entry`: the current place again replaces it, keeping
   * what is ahead of it; another place drops what is ahead, as a browser does.
   */
  push(entry: Entry): void {
    const current = this.#entries[this.#index];
    if (current !== undefined && this.#same(current, entry)) {
      this.#entries[this.#index] = entry;
      return;
    }
    this.#entries.length = this.#index + 1;
    this.#entries.push(entry);
    if (this.#entries.length > this.#cap) this.#entries.splice(0, this.#entries.length - this.#cap);
    this.#index = this.#entries.length - 1;
  }

  /** The nearest earlier entry that is usable and not the current place, without moving. */
  back(usable: (entry: Entry) => boolean): number | undefined {
    for (let index = this.#index - 1; index >= 0; index--)
      if (this.#reachable(index, usable)) return index;
    return undefined;
  }

  /** The nearest later entry that is usable and not the current place, without moving. */
  forward(usable: (entry: Entry) => boolean): number | undefined {
    for (let index = this.#index + 1; index < this.#entries.length; index++)
      if (this.#reachable(index, usable)) return index;
    return undefined;
  }

  /** The entry at `index`, as `back` or `forward` answered it. */
  at(index: number): Entry {
    const entry = this.#entries[index];
    if (entry === undefined) throw new Error(`No place at ${index} of ${this.#entries.length}.`);
    return entry;
  }

  /** Moves to `index` once a navigation there landed. */
  commit(index: number): void {
    this.at(index);
    this.#index = index;
  }

  /** Rewrites every entry, as a draft's promotion renames its selection to the thread's. */
  rewrite(map: (entry: Entry) => Entry): void {
    this.#entries = this.#entries.map(map);
  }

  #reachable(index: number, usable: (entry: Entry) => boolean): boolean {
    const entry = this.at(index);
    const current = this.#entries[this.#index];
    return usable(entry) && (current === undefined || !this.#same(current, entry));
  }
}
