/**
 * Pult's: what extensions publish into the page's UI slots (`@t3tools/contracts`'s `extensionUi.ts`),
 * as state, and their action and send handlers. `host.ui` (`ExtensionContract.ts`) writes it; the
 * page follows it on `extensions.subscribeUi` and answers it on `extensions.act` and `extensions.send`
 * (`ws.ts`). A list goes with its extension's activation (`drop`).
 */
import {
  EXTENSION_SLOTS,
  type ExtensionActInput,
  type ExtensionSendInput,
  type ExtensionSlot,
  type ExtensionShelfRow,
  type ExtensionThen,
  type ExtensionUiPublished,
  ExtensionUiRefused,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { HostCallError, type UiAction, type UiSend } from "./contract.ts";

export type ActionHandler = (action: UiAction) => Effect.Effect<void, { readonly message: string }>;
export type SendHandler = (
  send: UiSend,
) => Effect.Effect<{ readonly thread: string }, { readonly message: string }>;

const fromInput = (then: ExtensionThen | undefined) =>
  then?.status.time !== undefined && "of" in then.status.time && then.status.time.of === "input";

/** Per slot: the actions an item offers, whether its composer is handled, and why its `then`s cannot be drawn. */
const SLOT_READERS: {
  readonly [Slot in ExtensionSlot]: {
    readonly actions: (item: ExtensionShelfRow) => ExtensionShelfRow["actions"];
    readonly handled: (item: ExtensionShelfRow) => boolean;
    readonly undrawable: (item: ExtensionShelfRow) => string | undefined;
  };
} = {
  "shelf-row": {
    actions: (row) => row.actions,
    handled: (row) => row.open.reply !== undefined && "handled" in row.open.reply.target,
    undrawable: (row) => {
      const action = row.actions.find((each) => each.input === undefined && fromInput(each.then));
      if (action !== undefined)
        return `the action "${action.id}" of "${row.key}" draws its input's time, and takes none`;
      const reply = row.open.reply;
      if (reply?.then === undefined) return undefined;
      if ("thread" in reply.target)
        return `the reply of "${row.key}" declares what its send does, and no handler answers a thread's composer`;
      if (fromInput(reply.then))
        return `the reply of "${row.key}" draws an input's time, and a send has none`;
      return undefined;
    },
  },
};

const decodeSlot = Object.fromEntries(
  Object.entries(EXTENSION_SLOTS).map(([slot, schema]) => [
    slot,
    Schema.decodeUnknownEffect(Schema.Array(schema)),
  ]),
) as {
  readonly [Slot in ExtensionSlot]: (
    items: unknown,
  ) => Effect.Effect<ReadonlyArray<ExtensionShelfRow>, Schema.SchemaError>;
};

const isSlot = (slot: string): slot is ExtensionSlot => Object.hasOwn(EXTENSION_SLOTS, slot);

const listKey = (extension: string, slot: string) => JSON.stringify([extension, slot]);

interface State {
  /** Each extension's list per slot, by `listKey`, an emptied one kept until its activation goes. */
  readonly lists: ReadonlyMap<string, ExtensionUiPublished>;
  /** The list the last write changed, which a subscriber past the snapshot is sent. */
  readonly last: ExtensionUiPublished | undefined;
}

export class ExtensionUi extends Context.Service<
  ExtensionUi,
  {
    /** Replaces the extension's whole list for `slot`; a malformed item, a repeated key or a `then` the page cannot draw fails it. */
    readonly publish: (
      extension: string,
      slot: string,
      items: ReadonlyArray<unknown>,
    ) => Effect.Effect<void, HostCallError>;
    /** Once per activation. */
    readonly onAction: (
      extension: string,
      handle: ActionHandler,
    ) => Effect.Effect<void, HostCallError>;
    /** Once per activation. */
    readonly onSend: (extension: string, handle: SendHandler) => Effect.Effect<void, HostCallError>;
    /** The extension's lists and handlers, gone with its activation. */
    readonly drop: (extension: string) => Effect.Effect<void>;
    /** Every list, then each list as it changes; one gone with its activation is sent once, empty. */
    readonly published: Stream.Stream<ExtensionUiPublished>;
    readonly act: (input: ExtensionActInput) => Effect.Effect<void, ExtensionUiRefused>;
    readonly send: (
      input: ExtensionSendInput,
    ) => Effect.Effect<{ readonly thread: string }, ExtensionUiRefused>;
  }
>()("t3/plugins/ExtensionUi") {}

const refused = (message: string) => new ExtensionUiRefused({ message });

const make = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<State>({ lists: new Map(), last: undefined });
  const actionHandlers = new Map<string, ActionHandler>();
  const sendHandlers = new Map<string, SendHandler>();

  /** An emptied list stays in the set, empty, so a page's first snapshot tells it the extension has nothing there; `drop` removes it. */
  const write = (published: ExtensionUiPublished, remove = false) =>
    SubscriptionRef.update(state, ({ lists }) => {
      const next = new Map(lists);
      const key = listKey(published.extension, published.slot);
      if (remove) next.delete(key);
      else next.set(key, published);
      return { lists: next, last: published };
    });

  const publish = Effect.fn("ExtensionUi.publish")(function* (
    extension: string,
    slot: string,
    items: ReadonlyArray<unknown>,
  ) {
    const failed = (message: string) =>
      new HostCallError({ call: "ui.publish", message: `${extension}: ${message}` });
    if (!isSlot(slot)) return yield* failed(`there is no slot "${slot}"`);
    const decoded = yield* decodeSlot[slot](items).pipe(
      Effect.mapError((error) => failed(`an item of "${slot}" does not decode: ${error.message}`)),
    );
    const keys = new Set<string>();
    for (const item of decoded) {
      if (keys.has(item.key)) return yield* failed(`the key "${item.key}" repeats in "${slot}"`);
      keys.add(item.key);
      const undrawable = SLOT_READERS[slot].undrawable(item);
      if (undrawable !== undefined) return yield* failed(undrawable);
    }
    yield* write({ extension, slot, items: decoded });
  });

  const once = <Handler>(handlers: Map<string, Handler>, call: string) =>
    Effect.fn(`ExtensionUi.${call}`)(function* (extension: string, handle: Handler) {
      if (handlers.has(extension))
        return yield* new HostCallError({
          call: `ui.${call}`,
          message: `${extension}: it has a handler already, one per activation`,
        });
      handlers.set(extension, handle);
    });

  const drop = Effect.fn("ExtensionUi.drop")(function* (extension: string) {
    actionHandlers.delete(extension);
    sendHandlers.delete(extension);
    const { lists } = yield* SubscriptionRef.get(state);
    for (const list of lists.values())
      if (list.extension === extension) yield* write({ ...list, items: [] }, true);
  });

  /** The published item named by the input, or why there is none, by name. */
  const itemOf = Effect.fn("ExtensionUi.itemOf")(function* (input: {
    readonly extension: string;
    readonly slot: string;
    readonly key: string;
  }) {
    if (!isSlot(input.slot)) return yield* refused(`There is no slot "${input.slot}".`);
    const list = (yield* SubscriptionRef.get(state)).lists.get(
      listKey(input.extension, input.slot),
    );
    if (list === undefined)
      return yield* refused(
        `The extension "${input.extension}" has nothing in the slot "${input.slot}".`,
      );
    const item = (list.items as ReadonlyArray<ExtensionShelfRow>).find(
      (each) => each.key === input.key,
    );
    if (item === undefined)
      return yield* refused(
        `The extension "${input.extension}" has no item "${input.key}" in "${input.slot}".`,
      );
    return { slot: input.slot, item };
  });

  const act = Effect.fn("ExtensionUi.act")(function* (input: ExtensionActInput) {
    const { slot, item } = yield* itemOf(input);
    const action = SLOT_READERS[slot].actions(item).find((each) => each.id === input.action);
    if (action === undefined)
      return yield* refused(`The item "${input.key}" has no action "${input.action}".`);
    if (action.input === undefined && input.value !== undefined)
      return yield* refused(`The action "${input.action}" takes no value.`);
    if (action.input !== undefined) {
      if (input.value === undefined)
        return yield* refused(`The action "${input.action}" needs a value.`);
      if (DateTime.make(input.value)._tag === "None")
        return yield* refused(`The action "${input.action}" needs an ISO 8601 time.`);
    }
    const handle = actionHandlers.get(input.extension);
    if (handle === undefined)
      return yield* refused(`The extension "${input.extension}" handles no actions.`);
    yield* handle({ slot, key: input.key, action: input.action, value: input.value }).pipe(
      Effect.mapError((error) => refused(error.message)),
    );
  });

  const send = Effect.fn("ExtensionUi.send")(function* (input: ExtensionSendInput) {
    const { slot, item } = yield* itemOf(input);
    if (!SLOT_READERS[slot].handled(item))
      return yield* refused(`The item "${input.key}" has no composer its extension handles.`);
    const handle = sendHandlers.get(input.extension);
    if (handle === undefined)
      return yield* refused(`The extension "${input.extension}" handles no sends.`);
    return yield* handle({ slot, key: input.key, message: input.message }).pipe(
      Effect.mapError((error) => refused(error.message)),
    );
  });

  const published = SubscriptionRef.changes(state).pipe(
    Stream.zipWithIndex,
    Stream.flatMap(([{ lists, last }, index]) =>
      Stream.fromIterable(index === 0 ? [...lists.values()] : last === undefined ? [] : [last]),
    ),
  );

  return ExtensionUi.of({
    publish,
    onAction: once(actionHandlers, "onAction"),
    onSend: once(sendHandlers, "onSend"),
    drop,
    published,
    act,
    send,
  });
});

export const layer = Layer.effect(ExtensionUi, make);
