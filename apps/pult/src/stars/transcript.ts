// A Star's conversation as a transcript (xaxis `pult/issues/star-sleep`),
// apart from the workbench so `node --test src/stars/transcript.test.ts` can
// run it: its file's name, and its text, written deterministically from the
// conversation's projection, so any page writes the same file and a rewrite
// that changes nothing writes nothing; and the text read back, for the fold
// of the Star's tab.
//
// conversations/<environmentId>/2026-11-03T14-02-11Z-<threadId>.md:
//
//   ---
//   thread: "<threadId>"
//   started: "2026-11-03T14:02:11.000Z"
//   ended: "2026-11-03T14:32:40.000Z"
//   environment: "MacBook"
//   title: "Plan the week"
//   turns: 2
//   ---
//
//   ### User · 2026-11-03T14:02:11Z
//
//   What is on this week?
//
//   ### Tool · 2026-11-03T14:02:15Z · Ran: cat memory/week.md
//
//   ### Star · 2026-11-03T14:02:30Z
//
//   Three things…
//
// Every user and assistant message under a heading with its time, each tool
// call on its heading's one line; a message's own line that reads as such a
// heading is written with one more backslash before it, and read back
// without. A transcript written from a window of the conversation's latest
// turns, where the page could not read the whole of it, says so in its
// front matter (`partial: true`), its turns those of the window.
import {
  idleCompactionOf,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { CONVERSATIONS_DIRECTORY, quoted, readFrontMatter } from "./record.ts";

/** An id as one path segment: kept to what any filesystem takes, and never `.` or `..`, so it can name nothing above its folder. */
function segment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(safe) ? `_${safe}` : safe;
}

/** The folder of a Star's home holding the transcripts of the conversations run on `environmentId`, relative to the home. */
export const transcriptsFolder = (environmentId: string) => `${CONVERSATIONS_DIRECTORY}/${segment(environmentId)}`;

const STAMP = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)/;

/**
 * A conversation's transcript's file name: when its thread was created, in
 * UTC, `YYYY-MM-DDTHH-MM-SSZ`, so the names sort by start, then its thread's
 * id, kept to what any filesystem takes.
 */
export function transcriptName(createdAt: string, threadId: string): string {
  const [, day, hours, minutes, seconds] = STAMP.exec(new Date(createdAt).toISOString()) ?? [];
  return `${day}T${hours}-${minutes}-${seconds}Z-${segment(threadId)}.md`;
}

/** When the conversation a transcript's file name names started, as an ISO time; undefined for a name of none. */
export function transcriptStart(name: string): string | undefined {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)Z-.+\.md$/.exec(name);
  return match === null ? undefined : `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
}

/** Whether a file of a transcripts' folder is a transcript, by its name. */
export const isTranscriptName = (name: string) => transcriptStart(name) !== undefined;

export type TranscriptInput = Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "nodes" | "visibleTurnItems">;

type Item = OrchestrationV2TurnItem;

const iso = (time: DateTime.Utc) => DateTime.formatIso(time);
/** A heading's time, to the second. */
const second = (time: DateTime.Utc) => iso(time).replace(/\.\d+Z$/, "Z");

const MARKER = /^(\\*)(### (?:User|Star|Tool) · )/gm;
const ESCAPED_MARKER = /^\\(\\*### (?:User|Star|Tool) · )/gm;
const HEADING = /^### (User|Star|Tool) · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?: · (.*))?$/;

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
      const counts = item.additions === undefined && item.deletions === undefined ? "" : ` (+${item.additions ?? 0} −${item.deletions ?? 0})`;
      return `Edited ${item.fileName}${counts}`;
    }
    case "file_search":
      return item.pattern === undefined ? "Searched files" : `Searched files: ${oneLine(item.pattern)}`;
    case "web_search":
      return item.patterns === undefined || item.patterns.length === 0 ? "Searched the web" : `Searched the web: ${oneLine(item.patterns.join(", "))}`;
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
 * A conversation's transcript, from its projection: the front matter (its
 * thread, its start, its end, the settlement, the environment's name, its
 * title and its turns, the user's messages), then its messages and tool
 * calls in the timeline's order, the agent's own alone, not its subagents';
 * T3 Code's own idle compactions left out. Undefined while the thread is not
 * settled, since its end is its settlement. `partial` for a projection that
 * is a window of the latest turns, which the front matter then says.
 */
export function formatTranscript(projection: TranscriptInput, environmentName: string, { partial = false } = {}): string | undefined {
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
  for (const { item } of projection.visibleTurnItems.toSorted((left, right) => left.position - right.position)) {
    if (inSubagent(item)) continue;
    const time = item.startedAt ?? item.updatedAt;
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message = messages.get(item.messageId);
      if (message !== undefined && idleCompactionOf(message) !== undefined) continue;
      const text = (item.textOmitted === true ? message?.text : item.text)?.trim() ?? "";
      if (text === "") continue;
      if (item.type === "user_message") turns += 1;
      const role = item.type === "user_message" ? "User" : "Star";
      sections.push(`### ${role} · ${second(message?.createdAt ?? time)}\n\n${text.replace(MARKER, "\\$1$2")}\n`);
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
    ...(partial ? ["partial: true"] : []),
  ];
  return `---\n${front.join("\n")}\n---\n${sections.map((section) => `\n${section}`).join("")}`;
}

/** One entry of a transcript as the fold shows it. */
export type TranscriptEntry =
  | { readonly kind: "user" | "star"; readonly at: string; readonly text: string }
  | { readonly kind: "tool"; readonly at: string; readonly text: string };

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
export function transcriptHead(text: string): { readonly ended: string | undefined; readonly partial: boolean } | undefined {
  const fields = readFrontMatter(text)?.fields;
  return fields && { ended: fields.get("ended") || undefined, partial: fields.get("partial") === "true" };
}

/** A transcript read back, its entries in order; undefined for a file with no front matter. */
export function parseTranscript(text: string): Transcript | undefined {
  const matter = readFrontMatter(text);
  if (matter === undefined) return undefined;
  const { fields, body } = matter;
  const entries: TranscriptEntry[] = [];
  let open: { kind: "user" | "star"; at: string; lines: string[] } | undefined;
  const close = () => {
    if (open === undefined) return;
    entries.push({ kind: open.kind, at: open.at, text: open.lines.join("\n").trim().replace(ESCAPED_MARKER, "$1") });
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
    else open = { kind: role === "User" ? "user" : "star", at, lines: [] };
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
