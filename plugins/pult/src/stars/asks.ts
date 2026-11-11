// A Star's asks (xaxis `pult/issues/star-asks.md`): `.pult/asks/<name>.md`, one file per thing
// the Star needs from the user, written and deleted by the Star. Plain Markdown, nothing parsed
// but the title, and nothing rejected: every `.md` file there is an ask.
import { SYSTEM_DIRECTORY } from "./record.ts";

export const ASKS_DIRECTORY = `${SYSTEM_DIRECTORY}/asks`;

/** An ask as `GET /stars` serves it: `name` is its file's name without `.md`, `path` the file on the host. */
export interface Ask {
  readonly name: string;
  readonly title: string;
  readonly text: string;
  readonly path: string;
}

/** The ask a file of the folder is, by its name without `.md`; undefined for a file that is no ask. */
export const askName = (file: string): string | undefined =>
  file.endsWith(".md") && file.length > ".md".length ? file.slice(0, -".md".length) : undefined;

/** The first non-empty line with its leading `#`s dropped; the name where that leaves nothing. */
export function askTitle(name: string, text: string): string {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== "");
  return line?.trim().replace(/^#+/, "").trim() || name;
}

/** The ask at `path`; `text` undefined for a file that failed to read, which counts under its name. */
export const askOf = (name: string, path: string, text: string | undefined): Ask => ({
  name,
  title: askTitle(name, text ?? ""),
  text: text ?? "",
  path,
});
