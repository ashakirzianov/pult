import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import { onDidChangePluginFeatures, pluginFeatures } from "../stars/about.ts";
import { SCHEDULES_FEATURE } from "../stars/plugin.ts";
import { type ScheduleRow, scheduleRows } from "../stars/schedules.ts";
import { drawnHome, type Star } from "../stars/stars.ts";
import { DetailsShelf } from "../details/shelves.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** Whether the environment's server fires schedules, by its plugin's `about`; undefined while not read. */
function useFiring(environmentId: string | undefined): boolean | undefined {
  return useSyncExternalStore(onDidChangePluginFeatures, () =>
    environmentId === undefined ? undefined : pluginFeatures(environmentId)?.has(SCHEDULES_FEATURE),
  );
}

/**
 * A selected Star's schedules in its details cards (xaxis
 * `pult/tasks/star-schedules.task`), those of the home it is drawn from, as
 * that home's plugin serves them on its `stars` route: under a collapsible
 * "Schedules", in the warning colour while any failed or
 * will not run, adding "not run on this environment" where that home's
 * `about` lacks `star-schedules`. A row is its title, else its file's name, and the next run, over
 * the rule in words and the last run, a spent one-off dimmed; a click opens
 * its file as a tab (`pult-shell.openStarSchedule`). Hidden with none.
 */
export function StarSchedules({ star, now }: { star: Star; now: number }) {
  const home = drawnHome(star);
  const firing = useFiring(home?.environmentId);
  if (home === undefined || home.schedules.length === 0) return null;
  const rows = scheduleRows(
    home.schedules,
    now,
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const warning = rows.some((row) => row.warning);
  return (
    <DetailsShelf
      name="schedules"
      className={warning ? "pult-card-schedules-warning" : ""}
      status={
        firing === false ? (
          <span
            className="pult-card-status pult-schedules-off"
            title="This environment's server fires no schedules: its schedules-off is set."
          >
            not run on this environment
          </span>
        ) : null
      }
    >
      <ul className="pult-schedules-list" aria-label="Schedules">
        {rows.map((row) => (
          <li key={row.name}>
            <ScheduleButton
              row={row}
              open={() => run("pult-shell.openStarSchedule", star.id, row.name)}
            />
          </li>
        ))}
      </ul>
    </DetailsShelf>
  );
}

function ScheduleButton({ row, open }: { row: ScheduleRow; open: () => void }) {
  const className = `pult-schedule${row.spent ? " pult-schedule-spent" : ""}`;
  return (
    <button type="button" className={className} title={row.hover} onClick={open}>
      <span className="pult-schedule-head">
        <span className="pult-schedule-name">{row.label}</span>
        {row.next === undefined ? null : <span className="pult-schedule-next">{row.next}</span>}
      </span>
      <span className="pult-schedule-line">
        {row.rule === undefined ? null : <span className="pult-schedule-rule">{row.rule}</span>}
        <span className={`pult-schedule-last${row.warning ? " pult-schedule-last-warning" : ""}`}>
          {row.last}
        </span>
      </span>
    </button>
  );
}
