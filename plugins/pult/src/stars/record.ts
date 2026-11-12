// A Star's folder and its record in `.pult/star.yaml`: the layout, the parse, the text, and the
// rewrite that keeps the Star's other lines. Byte for byte the page's format
// (`apps/pult/src/stars/record.ts`), which a released page still reads and writes.

/** Where a server's Stars live, beside its home (`directory.ts`). */
export const STARS_DIRECTORY = ".pult/stars";

/** The folder a Star is created in, then `star-2`, `star-3` and on. */
export const DEFAULT_STAR_FOLDER = "star";

/** What of a Star's folder is Pult's beside `AGENTS.md`. */
export const SYSTEM_DIRECTORY = ".pult";

export const RECORD_FILE = `${SYSTEM_DIRECTORY}/star.yaml`;

/** A Star's channels, a folder each holding its transcripts, a folder per environment (`transcript.ts`). */
export const CHANNELS_DIRECTORY = `${SYSTEM_DIRECTORY}/channels`;

export const AGENTS_FILE = "AGENTS.md";

/** The Star's own instructions, which `AGENTS.md` loads: empty at creation. */
export const INSTRUCTIONS_FILE = "instructions.md";

export const STAR_PROJECT_ICON = { kind: "emoji", emoji: "🌟" } as const;

/** The tint a record without one reads as. */
const DEFAULT_TINT = "amber";

/** A Star's record: who it is. `name` is empty until the user or the Star names it. */
export interface StarRecord {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
}

export interface RecordFields {
  readonly name?: string | undefined;
  readonly tint?: string | undefined;
}

const KIND = "star";

/** How a Star is named where it has no name: its project's title, the page's card. */
export const starName = (record: Pick<StarRecord, "name">) => record.name.trim() || "Star";

/** Whether a project's root is a folder of a `.pult/stars` directory, ours or another home's. */
export function isStarRoot(root: string): boolean {
  return /(^|[/\\])\.pult[/\\]stars[/\\][^/\\]+[/\\]?$/.test(root);
}

/** A text's front matter as its lines, and where its body starts; undefined for a text without one. */
export function frontMatter(
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

/** A line's key and value: a plain scalar, or a quoted one. */
export function entry(line: string): { readonly key: string; readonly value: string } | undefined {
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

/** A value as Pult writes it: a JSON string, which is YAML's double-quoted one. */
export const quoted = (value: string) => JSON.stringify(value);

/** A file's front matter, by key, and its body; undefined for a file without one. */
export function readFrontMatter(
  text: string,
): { readonly fields: ReadonlyMap<string, string>; readonly body: string } | undefined {
  const matter = frontMatter(text);
  if (matter === undefined) return undefined;
  return { fields: fieldsOf(matter.lines), body: text.slice(matter.bodyStart) };
}

/** Each line's key and value, by key; a line of another shape is left out. */
export const fieldsOf = (lines: ReadonlyArray<string>) =>
  new Map(
    lines.flatMap((line) => {
      const parsed = entry(line);
      return parsed === undefined ? [] : [[parsed.key, parsed.value] as const];
    }),
  );

/** The Star's record in `.pult/star.yaml`; undefined for a file that is no Star's. */
export function parseRecord(text: string): StarRecord | undefined {
  const fields = fieldsOf(text.split(/\r?\n/));
  const id = fields.get("id");
  if (fields.get("xaxis-kind") !== KIND || id === undefined || id === "") return undefined;
  return {
    id,
    name: fields.get("name") ?? "",
    tint: fields.get("tint") || DEFAULT_TINT,
    created: fields.get("created") ?? "",
  };
}

/** A record's `text` with `changes` written, each key's line rewritten in place or added at the end. */
export function withRecordFields(text: string, changes: RecordFields): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Map(Object.entries(changes).filter(([, value]) => value !== undefined));
  const lines = (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/)).map((line) => {
    const key = entry(line)?.key;
    const value = key === undefined ? undefined : pending.get(key);
    if (key === undefined || value === undefined) return line;
    pending.delete(key);
    return `${key}: ${quoted(value)}`;
  });
  for (const [key, value] of pending) lines.push(`${key}: ${quoted(value)}`);
  return lines.map((line) => line + newline).join("");
}

export function newRecord(id: string, created: string): StarRecord {
  return { id, name: "", tint: DEFAULT_TINT, created };
}

export function recordText(record: StarRecord): string {
  return `xaxis-kind: ${KIND}
id: ${quoted(record.id)}
name: ${quoted(record.name)}
tint: ${quoted(record.tint)}
created: ${quoted(record.created)}
`;
}
