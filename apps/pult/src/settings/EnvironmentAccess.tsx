import { getService, IClipboardService, INotificationService } from "@codingame/monaco-vscode-api";
import type { AuthClientSession, AuthPairingLink } from "@t3tools/contracts";
import { QrCode } from "@t3tools/shared/qrCode";
import * as DateTime from "effect/DateTime";
import { useState, useSyncExternalStore } from "react";

import { type AccessState, revokeClient, revokePairingLink } from "../connection/access.ts";
import { dismissPairing, type Pairing } from "../connection/pairDevice.ts";
import { serverExposure, setNetworkAccess } from "../desktop/serverExposure.ts";

// An environment's devices on the settings page, under Devices in its group
// (xaxis `pult/issues/pair-device`): the pairing link Pair Device minted, and
// the environment's outstanding pairing links and authorized clients.

const dateTime = (millis: number) =>
  new Date(millis).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const time = (millis: number) =>
  new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function copy(text: string, what: string): Promise<void> {
  await (await getService(IClipboardService)).writeText(text);
  (await getService(INotificationService)).info(`Copied the ${what}.`);
}

async function revoke(what: string, revoking: Promise<void>): Promise<void> {
  try {
    await revoking;
  } catch (error) {
    (await getService(INotificationService)).error(
      `Pult could not revoke the ${what}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The pairing link minted for another device: a QR code of its link on the
 * address picked among several, the link and Copy Link, the code (to type
 * where a link cannot reach) and Copy Code, when it expires, and Done, which puts it away; with no address another device
 * reaches, the code alone and why, and for Pult.app's own server while it is
 * local-only, Make Reachable.
 */
export function PairingCard({ pairing }: { pairing: Pairing }) {
  const [picked, setPicked] = useState(pairing.addresses[0]?.id);
  const mode = useSyncExternalStore(serverExposure.subscribe, serverExposure.get);
  const address = pairing.addresses.find((each) => each.id === picked) ?? pairing.addresses[0];
  const localOnly = pairing.local && mode === "local-only";
  return (
    <div className="pult-settings-pairing">
      {address === undefined ? null : <QrCodeSvg value={address.url} />}
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">Pair a device</div>
        <div className="pult-settings-row-description">
          {address === undefined
            ? localOnly
              ? "This computer's server is reachable from it alone, so another device cannot open a link to it. Make it reachable, or give the device the code."
              : pairing.local
                ? "This computer's server has no address another device reaches. Give the device the code, with an address of this computer it reaches."
                : "Pult reaches this environment at a loopback address. Give the other device the code, with an address of the environment it reaches."
            : "Scan the code on the other device, or open the link there; Pult's Connect to Environment takes it too."}
        </div>
        {pairing.addresses.length > 1 ? (
          <div
            className="pult-settings-segments pult-settings-pairing-addresses"
            role="group"
            aria-label="Address"
          >
            {pairing.addresses.map((each) => (
              <button
                key={each.id}
                type="button"
                className="pult-settings-segment"
                aria-pressed={each.id === address?.id}
                onClick={() => setPicked(each.id)}
              >
                {each.label}
              </button>
            ))}
          </div>
        ) : null}
        {address === undefined ? null : (
          <div className="pult-settings-pairing-value">{address.url}</div>
        )}
        <div className="pult-settings-pairing-value">Code {pairing.credential}</div>
        <div className="pult-settings-row-description">Expires at {time(pairing.expiresAt)}.</div>
        <div className="pult-settings-row-actions pult-settings-pairing-actions">
          {address === undefined ? null : (
            <button
              type="button"
              className="pult-settings-button"
              onClick={() => void copy(address.url, "pairing link")}
            >
              Copy Link
            </button>
          )}
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => void copy(pairing.credential, "pairing code")}
          >
            Copy Code
          </button>
          {localOnly ? (
            <button
              type="button"
              className="pult-settings-button"
              onClick={() => void setNetworkAccess(true)}
            >
              Make Reachable…
            </button>
          ) : null}
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => dismissPairing(pairing)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** The link as a QR code, dark on light whatever the theme, so a camera reads it. */
function QrCodeSvg({ value }: { value: string }) {
  const qr = QrCode.encodeText(value, QrCode.Ecc.LOW);
  const margin = 2;
  const box = qr.size + margin * 2;
  const path: string[] = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.getModule(x, y)) path.push(`M${x + margin} ${y + margin}h1v1h-1z`);
  return (
    <svg
      className="pult-settings-pairing-qr"
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing link QR code"
    >
      <rect width={box} height={box} fill="#fff" />
      <path d={path.join("")} fill="#000" />
    </svg>
  );
}

/**
 * What may connect to the environment: its outstanding
 * pairing links (label, expiry, Revoke) and authorized clients (label or
 * device, last connected, Revoke, this page's own marked This Pult and not
 * revocable here), newest first, as its access stream stands, each a row of
 * the environment's group, inset under its row; why it cannot be read, when
 * it cannot.
 */
export function AuthorizedClients({
  environmentId,
  access,
}: {
  environmentId: string;
  access: AccessState | undefined;
}) {
  if (access === undefined) return null;
  if (access._tag === "failed")
    return (
      <div className="pult-settings-row pult-settings-subrow">
        <div className="pult-settings-row-description">
          Pult cannot list this environment's devices. {access.message}
        </div>
      </div>
    );
  const links = [...access.snapshot.pairingLinks].sort(
    (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
  );
  const sessions = [...access.snapshot.clientSessions].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(b.connected) - Number(a.connected) ||
      DateTime.toEpochMillis(b.issuedAt) - DateTime.toEpochMillis(a.issuedAt),
  );
  return (
    <>
      {links.map((link) => (
        <PairingLinkRow key={link.id} environmentId={environmentId} link={link} />
      ))}
      {sessions.map((session) => (
        <ClientRow key={session.sessionId} environmentId={environmentId} session={session} />
      ))}
    </>
  );
}

function PairingLinkRow({ environmentId, link }: { environmentId: string; link: AuthPairingLink }) {
  return (
    <div className="pult-settings-row pult-settings-subrow">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">{link.label ?? "Pairing link"}</div>
        <div className="pult-settings-row-description">
          Not used yet · expires {dateTime(DateTime.toEpochMillis(link.expiresAt))}
        </div>
      </div>
      <button
        type="button"
        className="pult-settings-link"
        onClick={() => void revoke("pairing link", revokePairingLink(environmentId, link.id))}
      >
        Revoke
      </button>
    </div>
  );
}

function ClientRow({
  environmentId,
  session,
}: {
  environmentId: string;
  session: AuthClientSession;
}) {
  const { client } = session;
  const device = [
    client.deviceType === "unknown"
      ? undefined
      : client.deviceType.charAt(0).toUpperCase() + client.deviceType.slice(1),
    client.os,
    client.browser,
    client.ipAddress,
  ].filter((part) => part !== undefined);
  const label =
    client.label ?? ([client.os, client.browser].filter(Boolean).join(" · ") || session.subject);
  const seen = session.current
    ? "This Pult"
    : session.connected
      ? "Connected"
      : session.lastConnectedAt === null
        ? "Not connected yet"
        : `Last connected ${dateTime(DateTime.toEpochMillis(session.lastConnectedAt))}`;
  return (
    <div className="pult-settings-row pult-settings-subrow">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">{label}</div>
        <div className="pult-settings-row-description">{[...device, seen].join(" · ")}</div>
      </div>
      {session.current ? null : (
        <button
          type="button"
          className="pult-settings-link"
          onClick={() => void revoke("client", revokeClient(environmentId, session.sessionId))}
        >
          Revoke
        </button>
      )}
    </div>
  );
}
