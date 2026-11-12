import {
  getService,
  ICommandService,
  IContextKeyService,
  IDialogService,
  INotificationService,
  IProgressService,
} from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ProgressLocation } from "@codingame/monaco-vscode-api/vscode/vs/platform/progress/common/progress";
import { request } from "@t3tools/client-runtime/rpc";
import { type DesktopBridge, type DesktopUpdateState, WS_METHODS } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import { threadStore } from "../threads/store.ts";
import { desktopHost } from "./host.ts";
import {
  busyRestartDetail,
  installableVersion,
  nextUpdateStep,
  type TrayOffer,
  trayOffer,
  updateRunning,
  type UpdateStep,
} from "./updateSteps.ts";

/**
 * Pult.app's updates (`pult/issues/release-feed`), through upstream's updater
 * over `window.desktopBridge`: the palette's Pult: Check for Updates, which
 * checks, downloads what it finds and answers with one notification, and
 * Pult: Restart to Update while a downloaded update waits, which installs it
 * now, asking first while agents work here; and the tray's button, Download
 * Update, then Restart to Update (`updateOffer`). While the local server's
 * `autoUpdateDesktopApp` is on, the page downloads an update as the updater
 * finds one, and the server installs it at rest (`InstallAtRest.ts`). None of
 * it is offered outside Pult.app.
 */

/** `downloaded` while an update waits to be installed, `none` otherwise in Pult.app, empty elsewhere. */
const UpdateContext = new RawContextKey<string>("pult.desktopUpdate", "");

let running: Promise<void> | undefined;

/** Registers the palette's Pult: Check for Updates and Restart to Update. Called before the workbench starts. */
export function registerUpdateCommands(): void {
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.checkForUpdates",
          title: { value: "Check for Updates", original: "Check for Updates" },
          category,
          f1: true,
          precondition: UpdateContext.notEqualsTo(""),
        });
      }

      run(): Promise<void> {
        const host = desktopHost();
        if (host === undefined) return Promise.resolve();
        // A second run while one goes on is answered by the first's notification.
        running ??= checkForUpdates(host).finally(() => (running = undefined));
        return running;
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.restartToUpdate",
          title: { value: "Restart to Update", original: "Restart to Update" },
          category,
          f1: true,
          precondition: UpdateContext.isEqualTo("downloaded"),
        });
      }

      async run(): Promise<void> {
        const host = desktopHost();
        if (host === undefined) return;
        const version = installableVersion(await host.getUpdateState());
        if (version === null || !(await confirmRestart())) return;
        const result = await host.installUpdate(version);
        // Accepted, the app quits into the update; refused or failed, it stays.
        if (result.accepted && result.state.message === null) return;
        (await getService(INotificationService)).error(
          result.state.message ?? `Pult could not install ${version} now.`,
        );
      }
    },
  );
}

async function checkForUpdates(host: DesktopBridge): Promise<void> {
  const notifications = await getService(INotificationService);
  let answer: Extract<UpdateStep, { kind: "answer" }>;
  try {
    answer = await (
      await getService(IProgressService)
    ).withProgress(
      { location: ProgressLocation.Notification, title: "Pult: checking for updates…" },
      async (progress) => {
        let state = (await host.checkForUpdate()).state;
        let downloadTried = false;
        for (;;) {
          const step = nextUpdateStep(state, downloadTried, updateOffer.automatic() === true);
          if (step.kind === "answer") return step;
          if (step.kind === "wait") {
            state = await settled(host);
            continue;
          }
          progress.report({ message: `downloading Pult ${state.availableVersion ?? ""}` });
          const result = await host.downloadUpdate();
          state = result.state;
          // Refused while another check or download runs, it is tried again once that ends.
          downloadTried = result.accepted || !updateRunning(state);
        }
      },
    );
  } catch (error) {
    answer = {
      kind: "answer",
      severity: "error",
      message: `Pult could not check for updates. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (answer.severity === "info") notifications.info(answer.message);
  else notifications.error(answer.message);
}

/** The updater's state once no check or download runs. */
function settled(host: DesktopBridge): Promise<DesktopUpdateState> {
  return new Promise((resolve, reject) => {
    const done = (state: DesktopUpdateState) => {
      if (updateRunning(state)) return;
      stop();
      resolve(state);
    };
    const stop = host.onUpdateState(done);
    host.getUpdateState().then(done, (error: unknown) => {
      stop();
      reject(error);
    });
  });
}

/**
 * Whether to restart now: at once while Pult.app's own server is at rest by its own reading
 * (`server.getActivity`, which the at-rest install reads too) or while the app runs none, else
 * after a warning naming the threads at work, with Restart Anyway.
 */
async function confirmRestart(): Promise<boolean> {
  const local = connection.localEnvironment;
  if (local === undefined) return true;
  let detail: string;
  try {
    const { atRest } = await connection.run(
      local.environmentId,
      request(WS_METHODS.serverGetActivity, {}),
    );
    if (atRest) return true;
    const working = threadStore
      .get()
      .threads.filter(
        (thread) =>
          thread.environmentId === local.environmentId &&
          thread.parentId === null &&
          (thread.working || thread.awaitsUser),
      )
      .map((thread) => thread.title);
    detail = busyRestartDetail(working);
  } catch (error) {
    console.error("[pult-shell] the local server's activity did not load", error);
    detail =
      "Pult could not tell whether agents are working on this computer. Restarting now interrupts any that are.";
  }
  const { confirmed } = await (
    await getService(IDialogService)
  ).confirm({
    type: "warning",
    message: "Restart Pult to update?",
    detail,
    primaryButton: "Restart Anyway",
  });
  return confirmed;
}

/**
 * Pult.app's update as the tray shows it (`src/panel/rows.tsx`), from the updater's state
 * (`trayOffer`), and the local server's `autoUpdateDesktopApp`, followed from its config: while
 * on, an update the updater finds is downloaded at once, each version once.
 */
class UpdateOffer {
  private host: DesktopBridge | undefined;
  private state: DesktopUpdateState | null = null;
  private offer: TrayOffer | null = null;
  private setting: boolean | null = null;
  private readonly downloadsTried = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private followed: { readonly environmentId: string; readonly stop: () => void } | undefined;

  readonly get = (): TrayOffer | null => this.offer;

  /** The local server's setting, null while the page holds no local server or has not read it. */
  readonly automatic = (): boolean | null => this.setting;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(host: DesktopBridge): void {
    this.host = host;
    const follow = () => {
      const local = connection.localEnvironment?.environmentId;
      if (local === this.followed?.environmentId) return;
      this.followed?.stop();
      this.followed = undefined;
      this.setAutomaticRead(null);
      if (local === undefined) return;
      const stop = followServerConfig(local, (config) =>
        this.setAutomaticRead(config.settings.autoUpdateDesktopApp),
      );
      this.followed = { environmentId: local, stop };
    };
    connection.onDidChange(follow);
    follow();
  }

  setState(state: DesktopUpdateState): void {
    this.state = state;
    const offer = trayOffer(state);
    if (offer?.kind !== this.offer?.kind || offer?.version !== this.offer?.version) {
      this.offer = offer;
      this.emit();
    }
    this.downloadIfAutomatic();
  }

  /** Writes the local server's setting; its config's change brings it back here. */
  async setAutomatic(automatic: boolean): Promise<void> {
    const local = connection.localEnvironment;
    if (local === undefined) return;
    try {
      await connection.run(
        local.environmentId,
        request(WS_METHODS.serverUpdateSettings, { patch: { autoUpdateDesktopApp: automatic } }),
      );
    } catch (error) {
      (await getService(INotificationService)).error(
        `Pult could not change automatic updates. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The tray's click: downloads the update found, or restarts into the one downloaded. */
  async act(): Promise<void> {
    const host = this.host;
    if (host === undefined || this.offer === null) return;
    if (this.offer.kind === "restart") {
      await (await getService(ICommandService)).executeCommand("pult-shell.restartToUpdate");
    } else if (this.offer.kind === "download") {
      await this.download(host, true);
    }
  }

  private async download(host: DesktopBridge, asked: boolean): Promise<void> {
    const { state } = await host.downloadUpdate();
    // An automatic download's failure is told by the tray, which offers Download again.
    if (asked && state.status === "error" && state.errorContext === "download") {
      (await getService(INotificationService)).error(
        state.message ?? `Pult could not download ${state.availableVersion ?? "the update"}.`,
      );
    }
  }

  private downloadIfAutomatic(): void {
    const { host, state } = this;
    if (host === undefined || state === null || this.setting !== true) return;
    const version = state.availableVersion;
    if (state.status !== "available" || version === null || this.downloadsTried.has(version))
      return;
    this.downloadsTried.add(version);
    void this.download(host, false).catch((error: unknown) =>
      console.error("[pult-shell] the automatic download failed", error),
    );
  }

  private setAutomaticRead(automatic: boolean | null): void {
    if (automatic === this.setting) return;
    this.setting = automatic;
    this.emit();
    this.downloadIfAutomatic();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const updateOffer = new UpdateOffer();

/** In Pult.app, sets the context key and keeps it, and the tray's offer, with the updater's state. */
export async function startUpdateContext(): Promise<void> {
  const host = desktopHost();
  if (host === undefined) return;
  const key = UpdateContext.bindTo(await getService(IContextKeyService));
  const apply = (state: DesktopUpdateState) => {
    key.set(installableVersion(state) === null ? "none" : "downloaded");
    updateOffer.setState(state);
  };
  let heard = false;
  host.onUpdateState((state) => {
    heard = true;
    apply(state);
  });
  key.set("none");
  updateOffer.start(host);
  void host.getUpdateState().then(
    (state) => {
      if (!heard) apply(state);
    },
    (error: unknown) => console.error("[pult-shell] the updater's state did not load", error),
  );
}
