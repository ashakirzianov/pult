// A Star's folder and its record, apart from the workbench so
// `node --test src/stars/record.test.ts` can run it: where Stars live, the
// record in `AGENTS.md`'s front matter, how it is read and rewritten, and the
// stock instructions written once at creation.

/** Where an environment's Stars live, relative to its home: a folder each. */
export const STARS_DIRECTORY = ".pult/stars";

/** The folder the page creates a Star in by default, under `STARS_DIRECTORY`. */
export const DEFAULT_STAR_FOLDER = "star";

/** The file holding a Star's record, in its front matter, and its standing instructions, in its body. */
export const RECORD_FILE = "AGENTS.md";

/** What a Star's folder holds beside its record: its memory, its own to write, and the transcripts Pult writes of its conversations. */
export const MEMORY_DIRECTORY = "memory";
export const CONVERSATIONS_DIRECTORY = "conversations";

/** The 🌟 upstream's UI shows for a Star's project. */
export const STAR_PROJECT_ICON = { kind: "emoji", emoji: "🌟" } as const;
export const STAR_PROJECT_TITLE = "Star";

/**
 * Whether a project's root is a Star's folder: a folder of a `.pult/stars`
 * directory. The page never shows such a project as a project, whether or
 * not its record has been read yet, so its threads never flash as cards.
 */
export function isStarRoot(root: string | null | undefined): boolean {
  if (root === null || root === undefined) return false;
  return /(^|[/\\])\.pult[/\\]stars[/\\][^/\\]+[/\\]?$/.test(root);
}

/** The tints a Star takes, as `pult-star`'s Curls sketch names them, each by its hue in degrees. */
export const TINTS = [
  { name: "amber", hue: 40 },
  { name: "coral", hue: 12 },
  { name: "rose", hue: 340 },
  { name: "violet", hue: 275 },
  { name: "indigo", hue: 235 },
  { name: "sky", hue: 200 },
  { name: "mint", hue: 155 },
] as const;

export type TintName = (typeof TINTS)[number]["name"];

export const DEFAULT_TINT: TintName = "amber";

/** A tint by name, the default for one Pult does not know. */
export function tintOf(name: string) {
  return TINTS.find((tint) => tint.name === name) ?? TINTS[0];
}

/** A Star's record: who it is. `name` is empty until the user names it, and the UI calls it "Star" meanwhile. */
export interface StarRecord {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
}

const KIND = "star";

/** The lines of a file's front matter, between its opening `---` and its closing one, and where its body starts; undefined without one. */
function frontMatter(
  text: string,
): { readonly lines: string[]; readonly bodyStart: number } | undefined {
  const opening = /^---\r?\n/.exec(text);
  if (opening === null) return undefined;
  const closing = /^---[ \t]*(\r?\n|$)/m;
  const rest = text.slice(opening[0].length);
  const match = closing.exec(rest);
  if (match === null) return undefined;
  const block = rest.slice(0, match.index);
  return {
    lines: block === "" ? [] : block.replace(/\r?\n$/, "").split(/\r?\n/),
    bodyStart: opening[0].length + match.index + match[0].length,
  };
}

/** A front matter line's key and value: a plain scalar, or a quoted one. */
function entry(line: string): { readonly key: string; readonly value: string } | undefined {
  const match = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
  if (match === null) return undefined;
  const [, key = "", raw = ""] = match;
  return { key, value: unquote(raw) };
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a JSON string after all: taken as written.
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    return raw.slice(1, -1).replaceAll("''", "'");
  return raw;
}

/** A value as the page writes it: a JSON string, which is YAML's double-quoted one. */
export const quoted = (value: string) => JSON.stringify(value);

/** A file's front matter, by key, and its body; undefined for a file without one. A Star's transcripts are read with it too (`transcript.ts`). */
export function readFrontMatter(
  text: string,
): { readonly fields: ReadonlyMap<string, string>; readonly body: string } | undefined {
  const matter = frontMatter(text);
  if (matter === undefined) return undefined;
  const fields = new Map(
    matter.lines.flatMap((line) => {
      const parsed = entry(line);
      return parsed === undefined ? [] : [[parsed.key, parsed.value] as const];
    }),
  );
  return { fields, body: text.slice(matter.bodyStart) };
}

/** The Star's record in `AGENTS.md`'s front matter; undefined for a file that is no Star's. */
export function parseRecord(text: string): StarRecord | undefined {
  const fields = readFrontMatter(text)?.fields;
  if (fields === undefined) return undefined;
  const id = fields.get("id");
  if (fields.get("xaxis-kind") !== KIND || id === undefined || id === "") return undefined;
  return {
    id,
    name: fields.get("name") ?? "",
    tint: fields.get("tint") || DEFAULT_TINT,
    created: fields.get("created") ?? "",
  };
}

/**
 * `text` with its front matter's `changes` written, each key's line rewritten
 * in place or added at the end, every other line and the body as they were.
 * A file without front matter is returned as it is.
 */
export function withRecordFields(
  text: string,
  changes: Partial<Pick<StarRecord, "name" | "tint">>,
): string {
  const matter = frontMatter(text);
  if (matter === undefined) return text;
  const pending = new Map(Object.entries(changes).filter(([, value]) => value !== undefined));
  const lines = matter.lines.map((line) => {
    const key = entry(line)?.key;
    const value = key === undefined ? undefined : pending.get(key);
    if (key === undefined || value === undefined) return line;
    pending.delete(key);
    return `${key}: ${quoted(value)}`;
  });
  for (const [key, value] of pending) lines.push(`${key}: ${quoted(value)}`);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return `---${newline}${lines.map((line) => line + newline).join("")}---${newline}${text.slice(matter.bodyStart)}`;
}

/** A new Star's record. */
export function newRecord(id: string, created: string): StarRecord {
  return { id, name: "", tint: DEFAULT_TINT, created };
}

/**
 * A new Star's `AGENTS.md`: its record, then its standing instructions,
 * written once and never overwritten, since they are the Star's and the
 * user's to change. They tell the Star what it is and where its memory and
 * its earlier conversations are; nothing of them is loaded into a thread.
 */
export function stockInstructions(record: StarRecord): string {
  return `---
xaxis-kind: ${KIND}
id: ${quoted(record.id)}
name: ${quoted(record.name)}
tint: ${quoted(record.tint)}
created: ${quoted(record.created)}
---

# Star

You are the user's Star: one continuous conversation with them, for as long as they keep you. The conversation is held in threads. After a while without messages you fall asleep, and the user's next message wakes you in a fresh thread, with nothing of the earlier ones loaded.

- \`${MEMORY_DIRECTORY}/\`, beside this file, is yours. Write down what you will want to know later as you go, not at the end: a conversation can end without warning.
- \`${CONVERSATIONS_DIRECTORY}/<environment>/\` holds the transcripts of your earlier conversations, which Pult writes when you fall asleep, each file named by when its conversation started. When the user refers to something said earlier, read the one it is in; do not read them all at the start.

Pult reads this file's front matter, your name and tint among it; keep it as it is.
`;
}
