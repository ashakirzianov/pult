import {
  getService,
  ICommandService,
  INotificationService,
  IQuickInputService,
} from "@codingame/monaco-vscode-api";

import { advertisedEndpoints } from "../desktop/serverExposure.ts";
import { type MintedPairing, mintPairing } from "./access.ts";
import { connection, environmentName } from "./connection.ts";
import { type PairingAddress, pairingAddresses } from "./pairingLink.ts";

/**
 * A pairing link Pair Device minted for another device (xaxis
 * `pult/issues/pair-device`), shown under its environment's row of the
 * settings page until it expires, is redeemed or revoked, or is put away:
 * the code, and the addresses a link of it may use (`pairingLink.ts`).
 */
export interface Pairing extends MintedPairing {
  readonly environmentId: string;
  /** Whether it is Pult.app's own server's, whose network access the card offers to turn on. */
  readonly local: boolean;
  readonly addresses: ReadonlyArray<PairingAddress>;
}

/** By environment id, one each: minting another replaces it. */
let shown: ReadonlyMap<string, Pairing> = new Map();
const listeners = new Set<() => void>();

export const pairings = {
  get: () => shown,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function set(environmentId: string, pairing: Pairing | undefined): void {
  const next = new Map(shown);
  if (pairing === undefined) next.delete(environmentId);
  else next.set(environmentId, pairing);
  shown = next;
  for (const listener of listeners) listener();
}

/** Puts the pairing away, if it is still the one shown for its environment. */
export function dismissPairing(pairing: Pairing): void {
  if (shown.get(pairing.environmentId) === pairing) set(pairing.environmentId, undefined);
}

/**
 * Pair Device (`pult-shell.pairDevice [environmentId]`, the settings page's
 * row action): asks for the device's name, optional, which the server gives
 * the link and then the client that redeems it, mints a pairing link on the
 * environment and shows it on the settings page; Escape mints nothing, and a
 * failure, a session without `access:write` among them, is a notification
 * with the server's reason.
 */
export async function pairDevice(environmentId: string): Promise<void> {
  const environment = connection.environment(environmentId);
  if (environment === undefined) return;
  const local = connection.localEnvironment?.environmentId === environment.environmentId;
  const name = await (
    await getService(IQuickInputService)
  ).input({
    title: `Pair a device with ${environmentName(environment, connection.environments)}`,
    prompt: "A name for the device, shown in the environment's clients (optional)",
    placeHolder: "My phone",
  });
  if (name === undefined) return;
  const label = name.trim() === "" ? undefined : name.trim();
  try {
    const minted = await mintPairing(environment.environmentId, label);
    const endpoints = local ? await advertisedEndpoints() : undefined;
    const pairing: Pairing = {
      ...minted,
      environmentId: environment.environmentId,
      local,
      addresses: pairingAddresses(
        { httpBaseUrl: environment.httpBaseUrl, ...(endpoints === undefined ? {} : { endpoints }) },
        minted.credential,
      ),
    };
    set(environment.environmentId, pairing);
    setTimeout(() => dismissPairing(pairing), Math.max(0, pairing.expiresAt - Date.now()));
    await (await getService(ICommandService)).executeCommand("pult-shell.selectSettings");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(
      `Pult could not create a pairing link on ${environmentName(environment, connection.environments)}. ${reason}`,
    );
  }
}
