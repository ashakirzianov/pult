// A scheduled run's record, Pult's own: `.pult/runs/<name>/<due>.yaml`, plain YAML lines as the
// Star's record is, written once the run's message was delivered or failed to be.
import { DateTime } from "../host.ts";
import { fieldsOf, quoted, SYSTEM_DIRECTORY } from "../stars/record.ts";

export const RUNS_DIRECTORY = `${SYSTEM_DIRECTORY}/runs`;

export type RunResult = "started" | "queued" | "launched" | "replayed" | "failed";

const RESULTS: ReadonlySet<string> = new Set([
  "started",
  "queued",
  "launched",
  "replayed",
  "failed",
]);

export interface RunRecord {
  readonly schedule: string;
  /** ISO instants. */
  readonly due: string;
  readonly environment: string;
  readonly fired: string;
  readonly result: RunResult;
  /** Why it failed; null unless it did. */
  readonly error: string | null;
  /** The conversation the message is in, where the delivery named it. */
  readonly thread: string | null;
}

/** As `GET /stars` serves a schedule's newest run. */
export type LastRun = Pick<RunRecord, "due" | "fired" | "result" | "error" | "thread">;

const pad = (value: number) => String(value).padStart(2, "0");

/** A run's file, by its due time in UTC to the minute: `2026-11-10T12-00Z.yaml`, so names sort by time. */
export function runFileName(due: number): string {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(due));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}-${pad(parts.minute)}Z.yaml`;
}

export const isRunFileName = (file: string) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z\.yaml$/.test(file);

export function runRecordText(record: RunRecord): string {
  const lines = [
    `schedule: ${quoted(record.schedule)}`,
    `due: ${quoted(record.due)}`,
    `environment: ${quoted(record.environment)}`,
    `fired: ${quoted(record.fired)}`,
    `result: ${record.result}`,
    ...(record.error === null ? [] : [`error: ${quoted(record.error)}`]),
    ...(record.thread === null ? [] : [`thread: ${quoted(record.thread)}`]),
  ];
  return lines.map((line) => `${line}\n`).join("");
}

/** A record's run as the route serves it; undefined for a file that is no record. */
export function parseLastRun(text: string): LastRun | undefined {
  const fields = fieldsOf(text.split(/\r?\n/));
  const due = fields.get("due");
  const fired = fields.get("fired");
  const result = fields.get("result");
  if (due === undefined || fired === undefined || result === undefined || !RESULTS.has(result))
    return undefined;
  return {
    due,
    fired,
    result: result as RunResult,
    error: fields.get("error") ?? null,
    thread: fields.get("thread") ?? null,
  };
}
