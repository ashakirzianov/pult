// What each held environment's Pult plugin does, by its `about` (`plugin.ts`),
// read on each connect.
import { connection } from "../connection/index.ts";
import { readAbout } from "./plugin.ts";

/** An environment as followed: whether it was ready at the last look, how many times it connected, and its plugin's features on this connect, undefined until read. */
interface Followed {
  wasReady: boolean;
  connects: number;
  features: ReadonlySet<string> | undefined;
}

const followed = new Map<string, Followed>();
const listeners = new Set<() => void>();

const tell = () => {
  for (const listener of listeners) listener();
};

/** Follows every environment the connection holds and no other, reading `about` as each becomes ready and forgetting it as each drops. */
function follow(): void {
  let changed = false;
  for (const environmentId of followed.keys())
    if (connection.environment(environmentId) === undefined) {
      followed.delete(environmentId);
      changed = true;
    }
  for (const environment of connection.environments) {
    const environmentId = environment.environmentId;
    let entry = followed.get(environmentId);
    if (entry === undefined) {
      entry = { wasReady: false, connects: 0, features: undefined };
      followed.set(environmentId, entry);
    }
    const ready = environment.phase === "ready";
    if (ready !== entry.wasReady && entry.features !== undefined) {
      entry.features = undefined;
      changed = true;
    }
    if (ready && !entry.wasReady) void read(environmentId, entry, ++entry.connects);
    entry.wasReady = ready;
  }
  if (changed) tell();
}

async function read(environmentId: string, entry: Followed, connect: number): Promise<void> {
  const credential = connection.credential(environmentId);
  const features = credential === undefined ? [] : await readAbout(credential);
  // Dropped or connected again meanwhile: that connect's read answers.
  if (followed.get(environmentId) !== entry || entry.connects !== connect || !entry.wasReady)
    return;
  entry.features = new Set(features);
  tell();
}

/** Starts reading the environments' `about`, on the page's connection. */
export function startPluginAbout(): void {
  connection.onDidChange(follow);
  follow();
}

/** The features of the environment's Pult plugin on this connect, none for a server without one; undefined while it is not ready or its `about` is not read yet. */
export function pluginFeatures(environmentId: string): ReadonlySet<string> | undefined {
  return followed.get(environmentId)?.features;
}

/** Calls `listener` whenever an environment's plugin features are read or forgotten. */
export function onDidChangePluginFeatures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
