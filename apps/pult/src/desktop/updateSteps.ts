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

/** The next step; `downloadTried` once a download this run started has ended. */
export function nextUpdateStep(state: DesktopUpdateState, downloadTried: boolean): UpdateStep {
  const downloaded = installableVersion(state);
  if (downloaded !== null) {
    // Unit F of `pult/issues/release-feed` installs at rest: then "Pult <version> downloaded; it installs when Pult rests."
    return {
      kind: "answer",
      severity: "info",
      message: `Pult ${downloaded} downloaded. Restart to Update installs it.`,
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
