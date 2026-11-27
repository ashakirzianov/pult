// Pult's, not upstream's (monore `pult/decisions`, `extension-ui-vocabulary`): what extensions publish
// into the page's UI slots, on A2UI's model, and the payloads of the three RPCs that carry them. An
// addition (a slot, an optional field, an `Input` member) needs no bump of the extension contract;
// changing or removing one does.
import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());

/** A codicon id; the page draws nothing for one it does not know, and logs it once. */
export const ExtensionIcon = NonEmpty;

export const ExtensionTime = Schema.Struct({
  at: Schema.String,
  /** `age`: how long ago, or until; `clock`: the time of day, with the date when not today. */
  as: Schema.Literals(["age", "clock"]),
});
export type ExtensionTime = typeof ExtensionTime.Type;

/** One of Pult's built-in components by name, data only; a page lacking it draws `fallback`. */
export const ExtensionNamed = Schema.Struct({
  named: Schema.Literal("star-mark"),
  star: NonEmpty,
  channel: Schema.optional(NonEmpty),
  fallback: Schema.Struct({ icon: ExtensionIcon, label: NonEmpty }),
});
export type ExtensionNamed = typeof ExtensionNamed.Type;

/**
 * What an action asks for before it is sent, a union declared inputs grow by members. `instant`:
 * Pult's time menu, its presets then Custom… titled by `label`, every choice in the future, sent as
 * `value` in ISO 8601; a dismissal sends nothing.
 */
export const ExtensionInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("instant"), label: NonEmpty }),
]);
export type ExtensionInput = typeof ExtensionInput.Type;

export const ExtensionAction = Schema.Struct({
  id: NonEmpty,
  label: NonEmpty,
  icon: ExtensionIcon,
  /** Draws the label beside the icon. */
  text: Schema.optional(Schema.Literal(true)),
  input: Schema.optional(ExtensionInput),
});
export type ExtensionAction = typeof ExtensionAction.Type;

/**
 * Where a composer writes, on the extension's environment: a thread's own composer, or one bound
 * to no thread whose every send goes to the extension's send handler (`extensions.send`).
 * `project` gives the composer its models and limits; `model` is what its picker shows until the
 * user picks, null for the composer's own.
 */
export const ExtensionTarget = Schema.Union([
  Schema.Struct({ thread: NonEmpty }),
  Schema.Struct({
    handled: Schema.Struct({
      project: NonEmpty,
      placeholder: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
      model: Schema.optional(Schema.NullOr(ModelSelection)),
    }),
  }),
]);
export type ExtensionTarget = typeof ExtensionTarget.Type;

/** A suggested reply: a click fills the input and sends nothing. */
export const ExtensionChip = Schema.Struct({ label: NonEmpty, text: NonEmpty });
export type ExtensionChip = typeof ExtensionChip.Type;

export const ExtensionReply = Schema.Struct({
  target: ExtensionTarget,
  /** After the name in "Reply to **name** · note"; display only. */
  note: Schema.optional(Schema.String),
  chips: Schema.Array(ExtensionChip).check(Schema.isMaxLength(4)),
});
export type ExtensionReply = typeof ExtensionReply.Type;

/** A row on one of the thread shelves, drawn as a thread's card is. */
export const ExtensionShelfRow = Schema.Struct({
  key: NonEmpty,
  shelf: Schema.Literals(["inbox", "working", "snoozed", "settled"]),
  title: Schema.String,
  /** A thread (its project's icon, its title), or a named component. */
  poster: Schema.Union([Schema.Struct({ thread: NonEmpty }), ExtensionNamed]),
  status: Schema.Struct({
    icon: ExtensionIcon,
    label: Schema.String,
    time: Schema.optional(ExtensionTime),
  }),
  actions: Schema.Array(ExtensionAction),
  /** A click selects the poster, opens `file` among its tabs, and shows `reply`'s composer. */
  open: Schema.Struct({
    file: Schema.optional(NonEmpty),
    reply: Schema.optional(ExtensionReply),
  }),
});
export type ExtensionShelfRow = typeof ExtensionShelfRow.Type;

/** Each slot an extension may publish into, by its name, with the schema of its items. */
export const EXTENSION_SLOTS = { "shelf-row": ExtensionShelfRow } as const;
export type ExtensionSlot = keyof typeof EXTENSION_SLOTS;
export type ExtensionSlotItem<Slot extends ExtensionSlot> = (typeof EXTENSION_SLOTS)[Slot]["Type"];

/** What a handled composer's Send hands the extension; the last three null unless picked there. */
export const ExtensionComposed = Schema.Struct({
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  /** As any send uploads them, pending until the thread they land in claims them. */
  attachments: Schema.Array(ChatAttachment),
  model: Schema.NullOr(ModelSelection),
  runtimeMode: Schema.NullOr(RuntimeMode),
  interactionMode: Schema.NullOr(ProviderInteractionMode),
});
export type ExtensionComposed = typeof ExtensionComposed.Type;

/** One extension's whole list for one slot, as `extensions.subscribeUi` streams it; items undecoded. */
export const ExtensionUiPublished = Schema.Struct({
  extension: Schema.String,
  slot: Schema.String,
  items: Schema.Array(Schema.Unknown),
});
export type ExtensionUiPublished = typeof ExtensionUiPublished.Type;

export const ExtensionActInput = Schema.Struct({
  extension: Schema.String,
  slot: Schema.String,
  key: Schema.String,
  action: Schema.String,
  /** The action's input, ISO 8601 for an instant; absent for an action with none. */
  value: Schema.optional(Schema.String),
});
export type ExtensionActInput = typeof ExtensionActInput.Type;

export const ExtensionSendInput = Schema.Struct({
  extension: Schema.String,
  slot: Schema.String,
  key: Schema.String,
  message: ExtensionComposed,
});
export type ExtensionSendInput = typeof ExtensionSendInput.Type;

/** The thread a handled send landed in, on the same environment. */
export const ExtensionSendResult = Schema.Struct({ thread: Schema.String });

/** Why an action or a send was refused: an unknown name, or the extension's own words. */
export class ExtensionUiRefused extends Schema.TaggedError<ExtensionUiRefused>()(
  "ExtensionUiRefused",
  { message: Schema.String },
) {}
