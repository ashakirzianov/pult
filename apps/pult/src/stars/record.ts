// A Star's folder and its record, apart from the workbench so
// `node --test src/stars/record.test.ts` can run it: where Stars live, what
// in a Star's folder is Pult's, the record in `.pult/star.yaml`, how it is
// read and rewritten, the `AGENTS.md` Pult keeps in every Star's
// folder, and the layout before it, which the page migrates.

/** Where an environment's Stars live, relative to its home: a folder each, in one git repository. */
export const STARS_DIRECTORY = ".pult/stars";

/** The folder the page creates a Star in by default, under `STARS_DIRECTORY`. */
export const DEFAULT_STAR_FOLDER = "star";

/** What of a Star's folder is Pult's beside `AGENTS.md`; everything else is the Star's own. */
export const SYSTEM_DIRECTORY = ".pult";

/** The file holding a Star's record, plain YAML lines, which the Star may edit too: no front matter, which Claude Code strips from the files `AGENTS.md` loads. */
export const RECORD_FILE = `${SYSTEM_DIRECTORY}/star.yaml`;

/** The transcripts Pult writes of a Star's conversations, a folder per environment (`transcript.ts`). */
export const CONVERSATIONS_DIRECTORY = `${SYSTEM_DIRECTORY}/conversations`;

/** Pult's instructions to the Star, the same for every Star, rewritten by a newer Pult (`AGENTS_TEXT`). */
export const AGENTS_FILE = "AGENTS.md";

/** The Star's own instructions, which `AGENTS.md` loads: empty at creation, the Star's to keep. */
export const INSTRUCTIONS_FILE = "instructions.md";

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

/**
 * A Star's record: who it is. `name` is empty until the user or the Star
 * names it, and the UI calls it "Star" meanwhile.
 */
export interface StarRecord {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
}

/** The fields the page rewrites in the record. */
export type RecordFields = Partial<Pick<StarRecord, "name" | "tint">>;

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

/** A record's or front matter's line's key and value: a plain scalar, or a quoted one. */
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
  return { fields: fieldsOf(matter.lines), body: text.slice(matter.bodyStart) };
}

const fieldsOf = (lines: ReadonlyArray<string>) =>
  new Map(
    lines.flatMap((line) => {
      const parsed = entry(line);
      return parsed === undefined ? [] : [[parsed.key, parsed.value] as const];
    }),
  );

/** The Star's record in `.pult/star.yaml`; undefined for a file that is no Star's. */
export function parseRecord(text: string): StarRecord | undefined {
  return recordOf(fieldsOf(text.split(/\r?\n/)));
}

/** The record in a legacy file's front matter, a `.pult/star.md`'s or an `AGENTS.md`'s; undefined for a file that is no Star's. */
export function parseLegacyRecord(text: string): StarRecord | undefined {
  const fields = readFrontMatter(text)?.fields;
  return fields === undefined ? undefined : recordOf(fields);
}

function recordOf(fields: ReadonlyMap<string, string>): StarRecord | undefined {
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
 * A record's `text` with `changes` written, each key's line rewritten in
 * place or added at the end, every other line as it was.
 */
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

/** A new Star's record. */
export function newRecord(id: string, created: string): StarRecord {
  return { id, name: "", tint: DEFAULT_TINT, created };
}

/** A Star's `.pult/star.yaml`: its record. */
export function recordText(record: StarRecord): string {
  return `xaxis-kind: ${KIND}
id: ${quoted(record.id)}
name: ${quoted(record.name)}
tint: ${quoted(record.tint)}
created: ${quoted(record.created)}
`;
}

/** The version of `AGENTS_TEXT`, its first line: raised with every change of the text. */
export const AGENTS_VERSION = 2;

/**
 * The `AGENTS.md` Pult keeps in every Star's folder (xaxis
 * `pult/issues/star-folder-layout`): what the Star is and what Pult does for
 * it, loading its record and its own instructions. Claude Code expands the
 * `@` lines; Codex does not, which its last paragraph covers.
 */
export const AGENTS_TEXT = `<!-- pult-agents-md: ${AGENTS_VERSION} -->
# Star

You are the user's Star: their personal agent in Pult, the app they talk to you through, and the same agent across all your conversations with them. Each conversation is a thread. After a while without messages you fall asleep, and the user's next message wakes you in a fresh thread with none of the earlier ones loaded; what carries over is this folder. Whatever you will want to know later has to be in it by then, and a conversation can end without warning.

- \`${RECORD_FILE}\` is your record, loaded below: your name and your tint, the colour Pult draws you in. You and the user can both change them. \`name\` is free text, empty until you are named; \`tint\` is one of amber, coral, rose, violet, indigo, sky or mint. Leave \`id\` and \`created\` as they are.
- \`${CONVERSATIONS_DIRECTORY}/<environment>/\` holds the transcripts of your earlier conversations. Pult writes one as you fall asleep, named by when that conversation started. When the user refers to something said earlier, read the transcript it is in; don't read them all at the start.

Pult manages this file and \`${SYSTEM_DIRECTORY}/\`, and rewrites this file as Pult changes, so anything you write here will be lost. Everything else in this folder is yours. Your own instructions go in \`${INSTRUCTIONS_FILE}\`, which you manage on your own and which is loaded below. If you don't see the contents of \`${INSTRUCTIONS_FILE}\` or \`${RECORD_FILE}\` below, read them before your first reply.

@${RECORD_FILE}
@${INSTRUCTIONS_FILE}
`;

/** Whether an `AGENTS.md` is due Pult's text: missing, of no version, or of an older one; a newer Pult's is left alone. */
export function agentsOutdated(text: string | undefined): boolean {
  if (text === undefined) return true;
  const version = /^<!-- pult-agents-md: (\d+) -->/.exec(text)?.[1];
  return version === undefined || Number(version) < AGENTS_VERSION;
}

/**
 * The layouts before: until `pult/issues/star-folder-layout`, the record in
 * `AGENTS.md`'s front matter, its body the stock instructions, the
 * transcripts in `conversations/`, and `memory/` beside them, which only
 * those instructions pointed the Star at; and for a day after, the record
 * in `.pult/star.md`'s front matter, in today's layout otherwise.
 */
export const LEGACY_RECORD_FILE = `${SYSTEM_DIRECTORY}/star.md`;
export const LEGACY_CONVERSATIONS_DIRECTORY = "conversations";
export const LEGACY_MEMORY_DIRECTORY = "memory";

/** A migrated Star's `instructions.md`, where it has a `memory/`: the one pointer of the stock instructions only they gave. */
export const LEGACY_INSTRUCTIONS = `- \`${LEGACY_MEMORY_DIRECTORY}/\` is yours: write down what you will want to know later as you go, not at the end.
`;
