import type { DesktopUpdateState } from "@t3tools/contracts";

/**
 * What Pult: Check for Updates does next with the state of upstream's updater
 * (`apps/desktop/src/updates/DesktopUpdates.ts`): wait while a check or a
 * download runs, whoever started it; download an update found, once; else
 * answer with one notification.
 */
export type UpdateStep =
  | { readonly kind: "wait" }
  | { readonly kind: "download" }
  | { readonly kind: "answer"; readonly severity: "info" | "error"; readonly message: string };

/** The downloaded version Restart to Update installs, as upstream's own Install button reads it; null with none waiting. */
export function installableVersion(state: DesktopUpdateState): string | null {
  const installable =
    state.status === "downloaded" ||
    (state.status === "error" && (state.errorContext === null || state.errorContext === "install"));
  return installable ? state.downloadedVersion : null;
}

/** A check or a download is running, which the updater refuses to start another beside. */
export function updateRunning(state: DesktopUpdateState): boolean {
  return state.status === "checking" || state.status === "downloading";
}

/**
 * The next step; `downloadTried` once a download this run started has ended, `installsAtRest`
 * while the server installs updates on its own (`autoUpdateDesktopApp`).
 */
export function nextUpdateStep(
  state: DesktopUpdateState,
  downloadTried: boolean,
  installsAtRest: boolean,
): UpdateStep {
  const downloaded = installableVersion(state);
  if (downloaded !== null) {
    // The server installs at rest only a download that has not failed to install here.
    const failedHere =
      downloaded === state.notAppliedVersion || downloaded === state.installFailedVersion;
    return {
      kind: "answer",
      severity: "info",
      message:
        failedHere || !installsAtRest
          ? `Pult ${downloaded} downloaded. Restart to Update installs it.`
          : `Pult ${downloaded} downloaded; it installs when Pult rests.`,
    };
  }
  if (!state.enabled || state.status === "disabled") {
    return {
      kind: "answer",
      severity: "error",
      message: state.message ?? "Updates are not available in this build.",
    };
  }
  if (updateRunning(state)) return { kind: "wait" };
  switch (state.status) {
    case "available":
      if (!downloadTried) return { kind: "download" };
      return {
        kind: "answer",
        severity: "error",
        message:
          state.message ?? `Pult could not download ${state.availableVersion ?? "the update"}.`,
      };
    case "up-to-date":
      return { kind: "answer", severity: "info", message: "You're up to date." };
    default:
      return {
        kind: "answer",
        severity: "error",
        message: state.message ?? "Pult could not check for updates.",
      };
  }
}

/** The tray's update button (`src/panel/rows.tsx`): Download for an update found, its download under way, or Restart for one downloaded. */
export interface TrayOffer {
  readonly kind: "download" | "downloading" | "restart";
  readonly version: string;
}

/** What the tray offers in this state, as upstream's sidebar pill reads it; null for nothing. */
export function trayOffer(state: DesktopUpdateState): TrayOffer | null {
  const downloaded = installableVersion(state);
  if (downloaded !== null) return { kind: "restart", version: downloaded };
  const version = state.availableVersion;
  if (version === null) return null;
  if (state.status === "downloading") return { kind: "downloading", version };
  if (
    state.status === "available" ||
    (state.status === "error" && state.errorContext === "download")
  )
    return { kind: "download", version };
  return null;
}

/** The restart's warning while a server is busy, naming up to three of its threads at work; `place` is "this computer" or the environment's name. */
export function busyRestartDetail(working: ReadonlyArray<string>, place: string): string {
  const named = working.slice(0, 3).map((title) => `“${title}”`);
  const more = working.length - named.length;
  const what =
    working.length === 0
      ? `Agent work is running on ${place}`
      : `${working.length === 1 ? "An agent is" : "Agents are"} working on ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return `${what}. Restarting now interrupts it.`;
}
