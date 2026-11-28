// What extensions publish into the page's UI slots (monore `pult/decisions`, `extension-ui`), as the
// page holds it, apart from the workbench so `node --test src/extensions/ui.test.ts` runs it: each
// environment's lists from `extensions.subscribeUi` (`index.ts` follows them), decoded by the
// slot's schema, an unknown slot skipped and an undecodable list dropped, each logged once; the
// rows, each drawn ahead from the click of an action or a send that declares its `then` until its
// extension publishes it changed or refuses, and an action that declares none pending until it answers.
import {
  EXTENSION_SLOTS,
  type ExtensionComposed,
  type ExtensionShelfRow,
  type ExtensionSlot,
  type ExtensionThen,
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

/** A row by its environment, extension and key. */
type RowName = Pick<PageRow, "environmentId" | "extension"> & { readonly key: string };

/** A row's identity across the page: its environment, extension and key. */
const rowId = (row: RowName) => JSON.stringify([row.environmentId, row.extension, row.key]);

/** What a publish of the row must change to end its drawing ahead. */
const asClicked = (row: ExtensionShelfRow) => JSON.stringify([row.shelf, row.status, row.actions]);

/** A row drawn ahead: its `then`, its times filled, over the row as published at the click. */
interface Ahead extends RowName {
  readonly shelf: ExtensionShelfRow["shelf"];
  readonly status: ExtensionShelfRow["status"];
  readonly at: string;
  /** The extension answered, so the next publish that still shows the row as clicked shows a `then` it never published. */
  answered: boolean;
}

export class ExtensionItems {
  private readonly lists = new Map<string, PageRow[]>();
  private readonly warned = new Set<string>();
  /** The action that declares nothing in flight on each row, by `rowId`, one mark per click; one drawn ahead is none, its row's publish showing what is next. */
  private readonly pending = new Map<string, { readonly action: string }>();
  /** The rows drawn ahead, by `rowId`. */
  private readonly ahead = new Map<string, Ahead>();
  private readonly listeners = new Set<() => void>();
  /** The environments whose stream sent anything since they were last forgotten: their rows are this connect's. */
  private readonly answered = new Set<string>();
  private shown: ReadonlyArray<PageRow> = [];

  private readonly warn: (message: string) => void;
  private readonly order: () => ReadonlyArray<string>;
  private readonly clock: () => number;

  constructor(
    warn: (message: string) => void,
    order: () => ReadonlyArray<string>,
    clock: () => number = Date.now,
  ) {
    this.warn = warn;
    this.order = order;
    this.clock = clock;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every environment's rows: in the environments' order, each one's by extension then as published; one drawn ahead with its `then`'s shelf and status, and no actions. */
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

  /** The action that declares nothing in flight on the row, which draws spinning while its other actions wait. */
  pendingOf(row: PageRow): string | undefined {
    return this.pending.get(rowId({ ...row, key: row.row.key }))?.action;
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
    // A row drawn ahead ends with its own publish, whatever it says: nothing orders it and the answer.
    for (const [id, drawn] of this.ahead) {
      if (drawn.environmentId !== environmentId || drawn.extension !== published.extension)
        continue;
      const now = this.published(drawn);
      if (now !== undefined && asClicked(now.row) === drawn.at && !drawn.answered) continue;
      this.ahead.delete(id);
      if (now !== undefined && asClicked(now.row) === drawn.at)
        this.warnOnce(
          `${environmentId}\0${published.extension}\0then`,
          `the extension "${published.extension}" declared what an action or a send does to its row "${drawn.key}" and did not publish it; the row is drawn as published`,
        );
    }
    this.update();
  }

  /** The environment's lists gone, as when it disconnects: its stream sends the whole set again. */
  forget(environmentId: string): void {
    this.answered.delete(environmentId);
    const ofIt = (key: string) => (JSON.parse(key) as ReadonlyArray<string>)[0] === environmentId;
    for (const key of this.lists.keys()) if (ofIt(key)) this.lists.delete(key);
    // Its rows drawn ahead and its pending marks go too: the next session's snapshot is the state.
    for (const id of this.ahead.keys()) if (ofIt(id)) this.ahead.delete(id);
    for (const id of this.pending.keys()) if (ofIt(id)) this.pending.delete(id);
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
   * A click on the row's action, `value` its input's: drawn ahead by its `then` where it declares
   * one, else pending until the extension answers; a refusal's words, the row drawn as published, or
   * null once done. One pending action at a time per row; a row drawn ahead offers none.
   */
  async act(
    transport: Transport,
    page: PageRow,
    action: string,
    value?: string,
  ): Promise<string | null> {
    const name = { ...page, key: page.row.key };
    const id = rowId(name);
    if (this.pending.has(id)) return null;
    const declared = this.published(name)?.row.actions.find((each) => each.id === action)?.then;
    const drawing = declared === undefined ? undefined : this.draw(name, declared, value);
    const mark = drawing === undefined ? { action } : undefined;
    if (mark !== undefined) this.pending.set(id, mark);
    this.update(true);
    try {
      await transport.act(page.environmentId, {
        extension: page.extension,
        slot: "shelf-row",
        key: page.row.key,
        action,
        ...(value === undefined ? {} : { value }),
      });
      if (drawing !== undefined && this.ahead.get(id) === drawing) drawing.answered = true;
      return null;
    } catch (error) {
      if (drawing !== undefined && this.ahead.get(id) === drawing) this.ahead.delete(id);
      return error instanceof Error ? error.message : String(error);
    } finally {
      if (mark !== undefined && this.pending.get(id) === mark) this.pending.delete(id);
      this.update(true);
    }
  }

  /**
   * A handled composer's Send on the row: drawn ahead by its reply's `then` where it declares one,
   * the thread it landed in once answered; a refusal thrown, the row drawn as published.
   */
  async send(
    transport: Transport,
    name: RowName,
    message: ExtensionComposed,
  ): Promise<{ readonly thread: string }> {
    const id = rowId(name);
    const declared = this.published(name)?.row.open.reply?.then;
    const drawing = declared === undefined ? undefined : this.draw(name, declared, undefined);
    if (drawing !== undefined) this.update(true);
    try {
      const answer = await transport.send(name.environmentId, {
        extension: name.extension,
        slot: "shelf-row",
        key: name.key,
        message,
      });
      if (drawing !== undefined && this.ahead.get(id) === drawing) drawing.answered = true;
      return answer;
    } catch (error) {
      if (drawing !== undefined && this.ahead.get(id) === drawing) {
        this.ahead.delete(id);
        this.update(true);
      }
      throw error;
    }
  }

  /** The row as its extension last published it, under any drawing ahead. */
  private published(name: RowName): PageRow | undefined {
    return this.lists
      .get(listKey(name.environmentId, name.extension, "shelf-row"))
      ?.find((each) => each.row.key === name.key);
  }

  /** The row drawn ahead by `then`, over any drawing before it: the click's instant, or the input's value, as its time. */
  private draw(name: RowName, then: ExtensionThen, value: string | undefined): Ahead | undefined {
    const now = this.published(name);
    if (now === undefined) return undefined;
    const { time, ...status } = then.status;
    const at = (of: "click" | "input") => {
      if (of === "click") return new Date(this.clock()).toISOString();
      // The server refuses an input's time on an action with none, and a reply's.
      if (value === undefined)
        throw new Error(`unreachable: a \`then\` of "${name.key}" draws an input it was not sent`);
      return value;
    };
    const drawing: Ahead = {
      environmentId: name.environmentId,
      extension: name.extension,
      key: name.key,
      shelf: then.shelf,
      status:
        time === undefined
          ? status
          : { ...status, time: "of" in time ? { at: at(time.of), as: time.as } : time },
      at: asClicked(now.row),
      answered: false,
    };
    this.ahead.set(rowId(name), drawing);
    return drawing;
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
      .flat()
      .map((page) => {
        const drawn = this.ahead.get(rowId({ ...page, key: page.row.key }));
        return drawn === undefined
          ? page
          : {
              ...page,
              row: { ...page.row, shelf: drawn.shelf, status: drawn.status, actions: [] },
            };
      });
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
