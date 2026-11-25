// A channel's settings as its details shelf draws them (`../details/ChannelDetails.tsx`), from the
// plugin of the home the Star is drawn from (`GET stars/<id>/channels/<slug>/settings`): read as
// the shelf mounts, again as the Stars directory's watch tells of a settings file changed
// (`channelSettingsStars`, `model.ts`) and as the channel wakes or sleeps, and written through the
// route's `POST`, whose answer is the fresh state.
import { getService, INotificationService } from "@codingame/monaco-vscode-api";

import { connection } from "../connection/index.ts";
import {
  type ChannelSettings,
  type ChannelSettingsChanges,
  readStarChannelSettings,
  writeStarChannelSettings,
} from "./plugin.ts";

/** Each channel's settings as the plugin answered them last, by environment, Star and channel. */
const settings = new Map<string, ChannelSettings>();
/** How many shelves show each channel now, by the same key: only those are read again. */
const shown = new Map<string, number>();
/** The channels with a write in flight, by the same key: a read meanwhile may answer the file as it was, so none is asked. */
const writing = new Set<string>();
/** Each channel's latest read or write asked for, so an earlier one answering late is dropped. */
const latest = new Map<string, number>();
let asked = 0;
const listeners = new Set<() => void>();

const keyOf = (environmentId: string, starId: string, channel: string) =>
  JSON.stringify([environmentId, starId, channel]);

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

function store(key: string, request: number, answer: ChannelSettings): void {
  if (latest.get(key) !== request) return;
  settings.set(key, answer);
  for (const listener of listeners) listener();
}

/** The channel's settings, undefined until read. */
export const channelSettingsOf = (environmentId: string, starId: string, channel: string) =>
  settings.get(keyOf(environmentId, starId, channel));

/** Calls `listener` whenever any channel's settings change; returns its removal. */
export function onDidChangeChannelSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the channel's settings again, the ones read last shown meanwhile and kept where the read fails. */
export function readChannelSettings(environmentId: string, starId: string, channel: string): void {
  const credential = connection.credential(environmentId);
  if (credential === undefined) return;
  const key = keyOf(environmentId, starId, channel);
  if (writing.has(key)) return;
  const request = ++asked;
  latest.set(key, request);
  void readStarChannelSettings(credential, starId, channel).then(
    (answer) => store(key, request, answer),
    (error: unknown) =>
      console.warn(
        `[pult-shell] could not read the settings of ${starId}'s channel ${channel}: ${errorMessage(error)}`,
      ),
  );
}

/** Reads the channel's settings as a shelf shows it, and keeps them while one does; what it returns stops following. */
export function followChannelSettings(
  environmentId: string,
  starId: string,
  channel: string,
): () => void {
  const key = keyOf(environmentId, starId, channel);
  shown.set(key, (shown.get(key) ?? 0) + 1);
  readChannelSettings(environmentId, starId, channel);
  return () => {
    const left = (shown.get(key) ?? 1) - 1;
    if (left > 0) shown.set(key, left);
    else shown.delete(key);
  };
}

/** Reads again every channel of the Star on `environmentId` a shelf shows, as a settings file there changed. */
export function refreshChannelSettings(environmentId: string, starId: string): void {
  for (const key of shown.keys()) {
    const [environment, star, channel] = JSON.parse(key) as [string, string, string];
    if (environment === environmentId && star === starId)
      readChannelSettings(environmentId, starId, channel);
  }
}

/** Writes `changes` into the channel's own file on `environmentId`, its answer the shelf's from then on; a refusal is notified. */
export async function writeChannelSettings(
  environmentId: string,
  starId: string,
  channel: string,
  changes: ChannelSettingsChanges,
): Promise<void> {
  const credential = connection.credential(environmentId);
  if (credential === undefined) return;
  const key = keyOf(environmentId, starId, channel);
  const request = ++asked;
  latest.set(key, request);
  writing.add(key);
  try {
    const answer = await writeStarChannelSettings(credential, starId, channel, changes);
    writing.delete(key);
    store(key, request, answer);
  } catch (error) {
    writing.delete(key);
    (await getService(INotificationService)).error(
      `Pult could not change the settings of the channel ${channel}: ${errorMessage(error)}`,
    );
    readChannelSettings(environmentId, starId, channel);
  }
}
