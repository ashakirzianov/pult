import {
  getService,
  ICommandService,
  IContextKeyService,
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
import { threadStore } from "../threads/store.ts";
import { desktopHost } from "./host.ts";
import {
  installableVersion,
  nextUpdateStep,
  updateRunning,
  type UpdateStep,
} from "./updateSteps.ts";

/**
 * Pult.app's updates (`pult/issues/release-feed`), through upstream's updater
 * over `window.desktopBridge`: the palette's Pult: Check for Updates, which
 * checks, downloads what it finds and answers with one notification, and
 * Pult: Restart to Update while a downloaded update waits, which installs it
 * now. Neither is offered outside Pult.app. While a downloaded update waits
 * and the app's own server is at rest, the tray offers Restart to Update too
 * (`restartOffer`).
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
        if (version === null) return;
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
          const step = nextUpdateStep(state, downloadTried);
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
 * The tray's Restart to Update (`src/panel/rows.tsx`): the downloaded version while one waits and
 * Pult.app's own server is at rest, by the server's own reading (`server.getActivity`, which the
 * at-rest install reads too), else null. The rest is read again a second after the threads or the
 * connection change, and once a minute for what the threads do not show (a native subagent's end).
 */
class RestartOffer {
  private downloaded: string | null = null;
  private atRest = false;
  private readonly listeners = new Set<() => void>();
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private reads = 0;

  readonly get = (): string | null => (this.atRest ? this.downloaded : null);

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    threadStore.subscribe(this.schedule);
    connection.onDidChange(this.schedule);
    setInterval(this.schedule, 60_000);
  }

  setDownloaded(version: string | null): void {
    if (version === this.downloaded) return;
    this.downloaded = version;
    this.emit();
    void this.read();
  }

  /** Reads the rest now, and restarts into the update only if the server is still at rest; else the offer goes. */
  async restart(): Promise<void> {
    if (!(await this.read())) return;
    await (await getService(ICommandService)).executeCommand("pult-shell.restartToUpdate");
  }

  private readonly schedule = () => {
    if (this.downloaded === null) return;
    this.scheduled ??= setTimeout(() => {
      this.scheduled = undefined;
      void this.read();
    }, 1000);
  };

  /** Whether the local server is at rest now; a read overtaken by a later one leaves the offer to it. */
  private async read(): Promise<boolean> {
    const read = ++this.reads;
    const local = connection.localEnvironment;
    let atRest = false;
    if (this.downloaded !== null && local?.phase === "ready") {
      try {
        atRest = (
          await connection.run(local.environmentId, request(WS_METHODS.serverGetActivity, {}))
        ).atRest;
      } catch (error) {
        console.error("[pult-shell] the local server's activity did not load", error);
      }
    }
    if (read === this.reads && atRest !== this.atRest) {
      this.atRest = atRest;
      this.emit();
    }
    return atRest;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const restartOffer = new RestartOffer();

/** In Pult.app, sets the context key and keeps it, and the tray's offer, with the updater's state. */
export async function startUpdateContext(): Promise<void> {
  const host = desktopHost();
  if (host === undefined) return;
  const key = UpdateContext.bindTo(await getService(IContextKeyService));
  const apply = (state: DesktopUpdateState) => {
    const version = installableVersion(state);
    key.set(version === null ? "none" : "downloaded");
    restartOffer.setDownloaded(version);
  };
  let heard = false;
  host.onUpdateState((state) => {
    heard = true;
    apply(state);
  });
  key.set("none");
  restartOffer.start();
  void host.getUpdateState().then(
    (state) => {
      if (!heard) apply(state);
    },
    (error: unknown) => console.error("[pult-shell] the updater's state did not load", error),
  );
}
