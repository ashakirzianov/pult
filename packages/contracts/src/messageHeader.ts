// Pult's, not upstream's (monore `pult/decisions`, `message-header`): who sent a message, as data
// in one context record no marker references. The server writes its `line` for the model in place
// of upstream's sender note (`withMessageSenderNote`), the page draws its `caption`, and the stored
// text is the sender's own words.
import * as Schema from "effect/Schema";

import {
  type ComposerContextRecord,
  ComposerContextId,
  type OrchestrationMessageContext,
} from "./composerContext.ts";

const MESSAGE_HEADER_KIND = "pult-header";
const MESSAGE_HEADER_CONTEXT_ID = "pult-header";
const MESSAGE_HEADER_LINE_MAX_CHARS = 2_000;

const OneLine = Schema.String.check(Schema.isPattern(/^[^\n\r]*$/u));

/** What the caption's name opens: a thread, or a row the same extension publishes. */
export const MessageHeaderOpen = Schema.Union([
  Schema.Struct({ thread: Schema.String }),
  Schema.Struct({ row: Schema.String }),
]);
export type MessageHeaderOpen = typeof MessageHeaderOpen.Type;

/**
 * The caption over the bubble, in the shape of the composer's "Reply to **name** · note": `reply`
 * draws the reply arrow, `lead` is plain text, `name` bold (a link where `open` resolves), `note`
 * after a dot.
 */
export const MessageHeaderCaption = Schema.Struct({
  reply: Schema.Boolean,
  lead: OneLine,
  name: Schema.NullOr(OneLine),
  open: Schema.NullOr(MessageHeaderOpen),
  note: Schema.NullOr(OneLine),
});
export type MessageHeaderCaption = typeof MessageHeaderCaption.Type;

export const MessageHeader = Schema.Struct({
  /** The sender's name, `pult` today. */
  extension: Schema.String,
  /** What the agent reads above the text: one line. */
  line: OneLine.check(Schema.isMaxLength(MESSAGE_HEADER_LINE_MAX_CHARS)),
  caption: Schema.NullOr(MessageHeaderCaption),
});
export type MessageHeader = typeof MessageHeader.Type;

const decodeHeader = Schema.decodeUnknownOption(MessageHeader);
const checkHeader = Schema.decodeUnknownSync(MessageHeader);

const isHeaderRecord = (record: ComposerContextRecord) => record.kind === MESSAGE_HEADER_KIND;

/** The message's header; null where its context holds none, or one whose payload does not decode. */
export function messageHeaderOf(
  context: OrchestrationMessageContext | undefined,
): MessageHeader | null {
  const record = context?.records.find(isHeaderRecord);
  if (record === undefined || !("payload" in record)) return null;
  const decoded = decodeHeader(record.payload);
  return decoded._tag === "Some" ? decoded.value : null;
}

/** `context` with `header`'s record added; a second header, or a header that does not decode (a line with a newline), throws. */
export function withMessageHeader(
  context: OrchestrationMessageContext | undefined,
  header: MessageHeader,
): OrchestrationMessageContext {
  if (context?.records.some(isHeaderRecord))
    throw new Error("A message carries at most one header.");
  const record: ComposerContextRecord = {
    version: 1,
    contextId: ComposerContextId.make(MESSAGE_HEADER_CONTEXT_ID),
    label: "",
    kind: MESSAGE_HEADER_KIND,
    payload: checkHeader(header),
  };
  return { ...context, version: 1, records: [...(context?.records ?? []), record] };
}

/** `context` without its header's record. */
export function withoutMessageHeader<Context extends OrchestrationMessageContext | undefined>(
  context: Context,
): Context {
  if (context === undefined || !context.records.some(isHeaderRecord)) return context;
  return { ...context, records: context.records.filter((record) => !isHeaderRecord(record)) };
}
