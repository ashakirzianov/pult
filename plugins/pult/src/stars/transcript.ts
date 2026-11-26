// A Star's conversation as a transcript (`star-conversations`): front matter, then `### User · <time>`
// (`· header=<caption JSON>` for a message with a header, its body the header's line, a blank line,
// the text), `### Star · <time> · messageId="<id>"` and `### Tool · <time> · <line>` sections; an
// older file's headings name neither, and an earlier page wrote `partial: true` over the latest turns.
import {
  idleCompactionOf,
  MessageHeaderCaption,
  messageHeaderOf,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DateTime, Schema } from "../host.ts";
import type { Channel } from "./channels.ts";
import { CHANNELS_DIRECTORY, quoted, readFrontMatter } from "./record.ts";

/** An id as one path segment: kept to what any filesystem takes, and never `.` or `..`, so it can name nothing above its folder. */
function segment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(safe) ? `_${safe}` : safe;
}

/** The folder of a Star's home holding the transcripts of its conversations in `channel` run on `environmentId`, relative to the home. */
export const transcriptsFolder = (environmentId: string, channel: Channel) =>
  `${CHANNELS_DIRECTORY}/${segment(channel)}/conversations/${segment(environmentId)}`;

const STAMP = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)/;

/**
 * A conversation's transcript's file name: when its thread was created, in
 * UTC, `YYYY-MM-DDTHH-MM-SSZ`, so the names sort by start, then its thread's
 * id, kept to what any filesystem takes.
 */
export function transcriptName(createdAt: DateTime.Utc, threadId: string): string {
  const [, day, hours, minutes, seconds] = STAMP.exec(DateTime.formatIso(createdAt)) ?? [];
  return `${day}T${hours}-${minutes}-${seconds}Z-${segment(threadId)}.md`;
}

/** When the conversation a transcript's file name names started, as an ISO time; undefined for a name of none. */
export function transcriptStart(name: string): string | undefined {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)Z-.+\.md$/.exec(name);
  return match === null ? undefined : `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
}

/** Whether a file of a transcripts' folder is a transcript, by its name. */
export const isTranscriptName = (name: string) => transcriptStart(name) !== undefined;

/** `YYYY-MM-DDTHH-MM-SSZ-`, the start a transcript's name has before its thread's segment. */
const START_LENGTH = 21;

/**
 * Whether a transcript's file name may be the thread's: its thread's segment after its start, as
 * `transcriptName` writes it. A segment is lossy, so only the file's front matter tells it is.
 */
export const mayNameThread = (name: string, threadId: string) =>
  isTranscriptName(name) && name.slice(START_LENGTH) === `${segment(threadId)}.md`;

export type TranscriptInput = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "messages" | "nodes" | "visibleTurnItems"
>;

type Item = OrchestrationV2TurnItem;

const iso = (time: DateTime.Utc) => DateTime.formatIso(time);
/** A heading's time, to the second. */
const second = (time: DateTime.Utc) => iso(time).replace(/\.\d+Z$/, "Z");

const MARKER = /^(\\*)(### (?:User|Star|Tool) · )/gm;
const ESCAPED_MARKER = /^\\(\\*### (?:User|Star|Tool) · )/gm;
const HEADING = /^### (User|Star|Tool) · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?: · (.*))?$/;
/** What a Star heading's detail starts with when it names its message, the id after it as a JSON string. */
const MESSAGE_ID = "messageId=";
/** What a User heading's detail starts with for a message with a header, its caption after it as JSON. */
const HEADER = "header=";
const decodeCaption = Schema.decodeUnknownSync(Schema.NullOr(MessageHeaderCaption));

/** A User heading's caption, null for a header without one; undefined for a heading of a message without a header, a throw for a marked one whose caption does not decode. */
function captionOf(detail: string): MessageHeaderCaption | null | undefined {
  if (!detail.startsWith(HEADER)) return undefined;
  const raw = detail.slice(HEADER.length);
  try {
    return decodeCaption(JSON.parse(raw));
  } catch (cause) {
    throw new Error(`A User heading's header is no caption: ${raw}`, { cause });
  }
}

/** A Star heading's message id; undefined for an older heading that names none, a throw for a marked one that is no JSON string. */
function messageIdOf(detail: string): string | undefined {
  if (!detail.startsWith(MESSAGE_ID)) return undefined;
  const raw = detail.slice(MESSAGE_ID.length);
  let id: unknown;
  try {
    id = JSON.parse(raw);
  } catch {
    id = undefined;
  }
  if (typeof id !== "string")
    throw new Error(`A Star heading's messageId is no JSON string: ${raw}`);
  return id;
}

const oneLine = (text: string, limit = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** A tool call's line: what it did, in a few words; undefined for an item that is no tool call. */
function toolLine(item: Item): string | undefined {
  switch (item.type) {
    case "command_execution":
      return `Ran: ${oneLine(item.input)}`;
    case "file_change": {
      const counts =
        item.additions === undefined && item.deletions === undefined
          ? ""
          : ` (+${item.additions ?? 0} −${item.deletions ?? 0})`;
      return `Edited ${item.fileName}${counts}`;
    }
    case "file_search":
      return item.pattern === undefined
        ? "Searched files"
        : `Searched files: ${oneLine(item.pattern)}`;
    case "web_search":
      return item.patterns === undefined || item.patterns.length === 0
        ? "Searched the web"
        : `Searched the web: ${oneLine(item.patterns.join(", "))}`;
    case "dynamic_tool": {
      const name = item.toolName ?? "Tool";
      return item.title === null || item.title === name ? name : `${name}: ${oneLine(item.title)}`;
    }
    case "subagent":
      return `Subagent: ${oneLine(item.title ?? item.prompt)}`;
    default:
      return undefined;
  }
}

/**
 * A settled conversation's transcript, its messages and tool calls in the timeline's order, the
 * agent's own and not its subagents', idle compactions left out, a line that reads as a heading
 * escaped with one more backslash; undefined while unsettled, since its end is its settlement.
 */
export function formatTranscript(
  projection: TranscriptInput,
  environmentName: string,
): string | undefined {
  const { thread } = projection;
  if (thread.settledOverride !== "settled" || thread.settledAt === null) return undefined;
  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  // Below a subagent's node, an item is the subagent's work, which its own line stands for.
  const inSubagent = (item: Item) => {
    const seen = new Set<string>();
    let parent = item.nodeId === null ? undefined : nodes.get(item.nodeId)?.parentNodeId;
    while (parent != null && !seen.has(parent)) {
      seen.add(parent);
      const node = nodes.get(parent);
      if (node?.kind === "subagent") return true;
      parent = node?.parentNodeId;
    }
    return false;
  };
  const sections: string[] = [];
  let turns = 0;
  for (const { item } of projection.visibleTurnItems.toSorted(
    (left, right) => left.position - right.position,
  )) {
    if (inSubagent(item)) continue;
    const time = item.startedAt ?? item.updatedAt;
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message = messages.get(item.messageId);
      if (message !== undefined && idleCompactionOf(message) !== undefined) continue;
      const text = (item.textOmitted === true ? message?.text : item.text)?.trim() ?? "";
      if (text === "") continue;
      if (item.type === "user_message") turns += 1;
      const header =
        item.type === "user_message" ? messageHeaderOf(item.context ?? message?.context) : null;
      const heading =
        item.type === "assistant_message"
          ? `Star · ${second(message?.createdAt ?? time)} · ${MESSAGE_ID}${JSON.stringify(item.messageId)}`
          : header === null
            ? `User · ${second(message?.createdAt ?? time)}`
            : `User · ${second(message?.createdAt ?? time)} · ${HEADER}${JSON.stringify(header.caption)}`;
      const body = header === null ? text : `${header.line}\n\n${text}`;
      sections.push(`### ${heading}\n\n${body.replace(MARKER, "\\$1$2")}\n`);
      continue;
    }
    const line = toolLine(item);
    if (line !== undefined) sections.push(`### Tool · ${second(time)} · ${line}\n`);
  }
  const front = [
    `thread: ${quoted(thread.id)}`,
    `started: ${quoted(iso(thread.createdAt))}`,
    `ended: ${quoted(iso(thread.settledAt))}`,
    `environment: ${quoted(environmentName)}`,
    `title: ${quoted(thread.title)}`,
    `turns: ${turns}`,
  ];
  return `---\n${front.join("\n")}\n---\n${sections.map((section) => `\n${section}`).join("")}`;
}

/** One entry of a transcript as the fold shows it. */
export type TranscriptEntry =
  | { readonly kind: "tool"; readonly at: string; readonly text: string }
  | {
      readonly kind: "user";
      readonly at: string;
      readonly text: string;
      /** A message with a header's caption, null for a header without one, its line cut from `text`; absent for a message without a header. */
      readonly caption?: MessageHeaderCaption | null;
    }
  | {
      readonly kind: "star";
      readonly at: string;
      readonly text: string;
      /** The reply's message, absent from a file written before headings named it. */
      readonly messageId?: string;
    };

export interface Transcript {
  readonly threadId: string;
  readonly started: string;
  readonly ended: string;
  readonly environment: string;
  readonly title: string;
  /** Whether it holds only a window of the conversation's latest turns. */
  readonly partial: boolean;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

/** What a transcript's front matter says of it: when its conversation ended, and whether it is partial; undefined for a file of none. */
export function transcriptHead(
  text: string,
): { readonly ended: string | undefined; readonly partial: boolean } | undefined {
  const fields = readFrontMatter(text)?.fields;
  return (
    fields && { ended: fields.get("ended") || undefined, partial: fields.get("partial") === "true" }
  );
}

/** A transcript read back, its entries in order; undefined for a file with no front matter. */
export function parseTranscript(text: string): Transcript | undefined {
  const matter = readFrontMatter(text);
  if (matter === undefined) return undefined;
  const { fields, body } = matter;
  const entries: TranscriptEntry[] = [];
  let open:
    | {
        kind: "user" | "star";
        at: string;
        messageId: string | undefined;
        caption: MessageHeaderCaption | null | undefined;
        lines: string[];
      }
    | undefined;
  const close = () => {
    if (open === undefined) return;
    const { kind, at, messageId, caption } = open;
    const text = open.lines.join("\n").trim().replace(ESCAPED_MARKER, "$1");
    if (caption !== undefined) {
      // The header's line, then a blank line, then the message's own words.
      const cut = text.indexOf("\n\n");
      entries.push({
        kind: "user",
        at,
        text: cut === -1 ? "" : text.slice(cut + 2).trim(),
        caption,
      });
    } else
      entries.push(
        messageId === undefined ? { kind, at, text } : { kind: "star", at, text, messageId },
      );
    open = undefined;
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading === null) {
      open?.lines.push(line);
      continue;
    }
    close();
    const [, role, at = "", detail = ""] = heading;
    if (role === "Tool") entries.push({ kind: "tool", at, text: detail });
    else if (role === "User")
      open = { kind: "user", at, messageId: undefined, caption: captionOf(detail), lines: [] };
    else open = { kind: "star", at, messageId: messageIdOf(detail), caption: undefined, lines: [] };
  }
  close();
  return {
    threadId: fields.get("thread") ?? "",
    started: fields.get("started") ?? "",
    ended: fields.get("ended") ?? "",
    environment: fields.get("environment") ?? "",
    title: fields.get("title") ?? "",
    partial: fields.get("partial") === "true",
    entries,
  };
}
