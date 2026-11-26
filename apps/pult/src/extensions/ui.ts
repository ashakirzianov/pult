// What extensions publish into the page's UI slots (xaxis `pult/decisions`, `extension-ui`), as the
// page holds it, apart from the workbench so `node --test src/extensions/ui.test.ts` runs it: each
// environment's lists from `extensions.subscribeUi` (`index.ts` follows them), decoded by the
// slot's schema, an unknown slot skipped and an undecodable list dropped, each logged once; the
// rows, and the action pending on each from its click until `extensions.act` answers.
import {
  EXTENSION_SLOTS,
  type ExtensionComposed,
  type ExtensionShelfRow,
  type ExtensionSlot,
  type ExtensionUiPublished,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RoutePoster } from "../stars/plugin.ts";
import type { Star } from "../stars/stars.ts";

/** A shelf row as the page holds it: with the environment and the extension that published it. */
export interface PageRow {
  readonly environmentId: string;
  readonly extension: string;
  readonly row: ExtensionShelfRow;
}

/** A row's place on the panel's shelves (`src/panel/order.ts`). */
export const rowRef = ({ environmentId, extension, row }: PageRow) => ({
  environmentId,
  extension,
  key: row.key,
  shelf: row.shelf,
});

/** The RPCs an action and a send go by, on the row's environment. */
export interface Transport {
  readonly act: (
    environmentId: string,
    input: {
      readonly extension: string;
      readonly slot: ExtensionSlot;
      readonly key: string;
      readonly action: string;
      readonly value?: string;
    },
  ) => Promise<void>;
  readonly send: (
    environmentId: string,
    input: {
      readonly extension: string;
      readonly slot: ExtensionSlot;
      readonly key: string;
      readonly message: ExtensionComposed;
    },
  ) => Promise<{ readonly thread: string }>;
}

const decoders: {
  readonly [Slot in ExtensionSlot]: (
    items: unknown,
  ) => Option.Option<ReadonlyArray<(typeof EXTENSION_SLOTS)[Slot]["Type"]>>;
} = { "shelf-row": Schema.decodeUnknownOption(Schema.Array(EXTENSION_SLOTS["shelf-row"])) };

const isSlot = (slot: string): slot is ExtensionSlot => Object.hasOwn(EXTENSION_SLOTS, slot);

const listKey = (environmentId: string, extension: string, slot: string) =>
  JSON.stringify([environmentId, extension, slot]);

/** A row's identity across the page: its environment, extension and key. */
const rowId = (row: Pick<PageRow, "environmentId" | "extension"> & { readonly key: string }) =>
  JSON.stringify([row.environmentId, row.extension, row.key]);

export class ExtensionItems {
  private readonly lists = new Map<string, PageRow[]>();
  private readonly warned = new Set<string>();
  /** The action in flight on each row, by `rowId`. */
  private readonly pending = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  /** The environments whose stream sent anything since they were last forgotten: their rows are this connect's. */
  private readonly answered = new Set<string>();
  private shown: ReadonlyArray<PageRow> = [];

  private readonly warn: (message: string) => void;
  private readonly order: () => ReadonlyArray<string>;

  constructor(warn: (message: string) => void, order: () => ReadonlyArray<string>) {
    this.warn = warn;
    this.order = order;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every environment's rows: in the environments' order, each one's by extension then as published. */
  rows(): ReadonlyArray<PageRow> {
    return this.shown;
  }

  row(environmentId: string, extension: string, key: string): PageRow | undefined {
    return this.shown.find(
      (each) =>
        each.environmentId === environmentId &&
        each.extension === extension &&
        each.row.key === key,
    );
  }

  /** The action in flight on the row, which draws spinning while its other actions wait. */
  pendingOf(row: PageRow): string | undefined {
    return this.pending.get(rowId({ ...row, key: row.row.key }));
  }

  /** One extension's whole list for one slot, as the environment's stream sends it. */
  apply(environmentId: string, published: ExtensionUiPublished): void {
    this.answered.add(environmentId);
    const key = listKey(environmentId, published.extension, published.slot);
    if (!isSlot(published.slot)) {
      this.warnOnce(
        `${environmentId}\0${published.extension}\0slot\0${published.slot}`,
        `the extension "${published.extension}" publishes into the slot "${published.slot}", which this page does not know`,
      );
      return;
    }
    const decoded = decoders[published.slot](published.items);
    if (Option.isNone(decoded)) {
      this.warnOnce(
        `${environmentId}\0${published.extension}\0items\0${published.slot}`,
        `an item the extension "${published.extension}" publishes into "${published.slot}" does not decode; its list there is not drawn`,
      );
      this.lists.delete(key);
    } else if (decoded.value.length === 0) this.lists.delete(key);
    else
      this.lists.set(
        key,
        decoded.value.map((row) => ({ environmentId, extension: published.extension, row })),
      );
    this.update();
  }

  /** The environment's lists gone, as when it disconnects: its stream sends the whole set again. */
  forget(environmentId: string): void {
    this.answered.delete(environmentId);
    for (const key of this.lists.keys())
      if ((JSON.parse(key) as ReadonlyArray<string>)[0] === environmentId) this.lists.delete(key);
    this.update();
  }

  /** Whether the environment's rows are this connect's, which the notices take as their baseline (`src/stars/notify.ts`). */
  answeredOn(environmentId: string): boolean {
    return this.answered.has(environmentId);
  }

  /** The environments' order changed. */
  reorder(): void {
    this.update();
  }

  /**
   * A click on the row's action, `value` its input's: pending until the extension answers, its own
   * publish already in by then; a refusal's words, or null once done. One action at a time per row.
   */
  async act(
    transport: Transport,
    page: PageRow,
    action: string,
    value?: string,
  ): Promise<string | null> {
    const id = rowId({ ...page, key: page.row.key });
    if (this.pending.has(id)) return null;
    this.pending.set(id, action);
    this.update(true);
    try {
      await transport.act(page.environmentId, {
        extension: page.extension,
        slot: "shelf-row",
        key: page.row.key,
        action,
        ...(value === undefined ? {} : { value }),
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      this.pending.delete(id);
      this.update(true);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  private update(force = false): void {
    const order = this.order();
    const rank = (environmentId: string) => {
      const index = order.indexOf(environmentId);
      return index === -1 ? order.length : index;
    };
    const next = [...this.lists.values()]
      .toSorted(
        (left, right) =>
          rank(left[0]!.environmentId) - rank(right[0]!.environmentId) ||
          left[0]!.extension.localeCompare(right[0]!.extension),
      )
      .flat();
    if (!force && JSON.stringify(next) === JSON.stringify(this.shown)) return;
    this.shown = next;
    for (const listener of this.listeners) listener();
  }
}

/** The rows the panel shows: a `star-mark` poster's only while Show Star is on, the component's rule. */
export const shownRows = (rows: ReadonlyArray<PageRow>, starsShown: boolean): PageRow[] =>
  rows.filter((page) => starsShown || !("named" in page.row.poster));

/** The key a row's reply composer is mounted under: a republish with the same target keeps the mount, a new target or a new opening mounts anew. */
export const replyMountKey = (opened: number, page: PageRow) =>
  JSON.stringify([
    opened,
    page.environmentId,
    page.extension,
    page.row.key,
    page.row.open.reply?.target,
  ]);

/** Where the page opens the thread a reply landed in (`index.ts`): a thread poster's own thread, and the thread itself for a Star the page does not hold. */
export type ReplyLanding =
  | { readonly kind: "thread" }
  | { readonly kind: "star"; readonly star: string }
  | { readonly kind: "channel"; readonly star: string; readonly slug: string };

/**
 * A Star's reply lands on the Star's tab for its default channel and on the channel's tab for any
 * other. The poster's channel decides it, not the conversation the page's Stars name, since a reply
 * that wakes a fresh conversation is answered before the Stars' read knows it.
 */
export const replyLanding = (
  poster: RoutePoster,
  star: Pick<Star, "id" | "defaultChannel"> | undefined,
): ReplyLanding =>
  "thread" in poster || star === undefined
    ? { kind: "thread" }
    : poster.channel === star.defaultChannel
      ? { kind: "star", star: star.id }
      : { kind: "channel", star: star.id, slug: poster.channel };
