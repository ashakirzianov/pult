import { getService, IConfigurationService } from "@codingame/monaco-vscode-api";
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configurationRegistry";
import { Registry } from "@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform";

import { writeUserValue } from "../settings/userSetting.ts";

/**
 * The weekend (xaxis `pult/issues/weekend-aware-limits`), `pult.limits.weekend`,
 * in the user's settings under Pult: the days the user does not work, which
 * the Limits shelf's pace counts no time on (`paceShare`); Saturday and
 * Sunday by default, none for a pace by the calendar.
 */
const WEEKEND = "pult.limits.weekend";

/** The week as the setting and the settings page list it, Monday first. */
export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Day = (typeof DAYS)[number];

const DEFAULT_WEEKEND: ReadonlyArray<Day> = ["saturday", "sunday"];

/** A day's number as `Date.getDay` gives it, Sunday 0. */
export const dayNumber = (day: Day) => (DAYS.indexOf(day) + 1) % 7;

const toNumbers = (days: ReadonlyArray<Day>): ReadonlySet<number> => new Set(days.map(dayNumber));

let weekend = toNumbers(DEFAULT_WEEKEND);
const listeners = new Set<() => void>();

/** The weekend as day numbers, for `useSyncExternalStore`; the default until `startLimitsWeekend` reads the user's. */
export const limitsWeekend = {
  get: () => weekend,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export async function setLimitsWeekend(days: ReadonlyArray<Day>): Promise<void> {
  const ordered = DAYS.filter((day) => days.includes(day));
  await writeUserValue(await getService(IConfigurationService), WEEKEND, ordered);
}

/** Registers the setting. Called before the workbench starts. */
export function registerLimitsWeekend(): void {
  Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    id: "pult",
    title: "Pult",
    order: 1,
    properties: {
      [WEEKEND]: {
        type: "array",
        items: { type: "string", enum: [...DAYS] },
        uniqueItems: true,
        default: [...DEFAULT_WEEKEND],
        description:
          "The days you do not work. The usage limits' pace counts no time on them, so a weekly limit's even pace waits over the weekend. Empty, every day counts.",
        scope: ConfigurationScope.APPLICATION,
      },
    },
  });
}

/** Reads the setting into its store once the services are up, and on each change; a value that is no list of days reads as the default. */
export async function startLimitsWeekend(): Promise<void> {
  const configuration = await getService(IConfigurationService);
  const read = () => {
    const value = configuration.getValue<unknown>(WEEKEND);
    const days = Array.isArray(value) ? DAYS.filter((day) => value.includes(day)) : DEFAULT_WEEKEND;
    weekend = toNumbers(days);
    for (const listener of listeners) listener();
  };
  read();
  configuration.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(WEEKEND)) read();
  });
}
