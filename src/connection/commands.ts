import {
  getService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ProgressLocation } from "@codingame/monaco-vscode-api/vscode/vs/platform/progress/common/progress";
import type { ResolvedRemotePairingTarget } from "@t3tools/shared/remote";

import { connection } from "./connection.ts";
import { ConnectedContext } from "./contextKey.ts";
import { parseConnectInput } from "./pairing.ts";
import { ProbeError } from "./probe.ts";

/**
 * The palette's "Pult: Connect to Environment" (`pult-shell.connect`) and
 * "Pult: Disconnect" (`pult-shell.disconnect`, while the page holds an
 * environment, which it forgets with its bearer). The prompts are the
 * page's, so no extension can bind the page to a server of its choosing;
 * only a development build takes a pairing link as argument, for
 * `scripts/drive.ts`.
 */
export function registerConnectionCommands(): void {
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.connect",
          title: { value: "Connect to Environment", original: "Connect to Environment" },
          category,
          f1: true,
        });
      }

      async run(_accessor: ServicesAccessor, pairingLink?: unknown): Promise<void> {
        if (import.meta.env.DEV && typeof pairingLink === "string") {
          const input = parseConnectInput(pairingLink);
          if (input._tag !== "PairingLink") throw new Error("pult-shell.connect takes a complete pairing link.");
          return connection.connect(input.target);
        }
        return connect();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.disconnect",
          title: { value: "Disconnect", original: "Disconnect" },
          category,
          f1: true,
          precondition: ConnectedContext,
        });
      }

      run(): Promise<void> {
        return connection.disconnect();
      }
    },
  );
}

/** Connects the page, offering a retry or a disconnect first when it holds an environment already. */
async function connect(): Promise<void> {
  const quickInput = await getService(IQuickInputService);
  const bound = connection.environment;
  if (bound !== null) {
    const choice = await quickInput.pick(
      [
        ...(bound.phase === "ready" ? [] : [{ id: "retry", label: "Retry Now" }]),
        { id: "disconnect", label: "Disconnect", description: "to connect to another environment" },
      ],
      { placeHolder: `Connected to ${bound.label} (${bound.phase})${bound.error === null ? "" : `: ${bound.error}`}` },
    );
    if (choice?.id === "retry") return connection.retryNow();
    if (choice?.id !== "disconnect") return;
    await connection.disconnect();
  }
  const value = await quickInput.input({
    title: "Connect to a T3 Code environment",
    prompt: "A pairing link from `t3 pair`, or the server's URL",
    placeHolder: "https://host/pair#token=…  or  http://localhost:3773",
    ignoreFocusLost: true,
    validateInput: async (text) => {
      const input = parseConnectInput(text);
      return input._tag === "Invalid" && text.trim() !== "" ? input.message : undefined;
    },
  });
  if (value === undefined) return;
  const input = parseConnectInput(value);
  if (input._tag === "Invalid") return void (await getService(INotificationService)).error(input.message);
  if (input._tag === "PairingLink") return void (await attach(input.target));
  // A refused token asks again.
  for (;;) {
    const token = await quickInput.input({
      title: `Token for ${input.host}`,
      prompt: "A pairing code from `t3 pair`, or a session token from `t3 auth session issue`",
      password: true,
      ignoreFocusLost: true,
      validateInput: async (text) => (text.trim() === "" ? "Enter the token." : undefined),
    });
    if (token === undefined || (await attach(input.withToken(token.trim()))) !== "auth") return;
  }
}

/**
 * Probes and connects with progress, showing a failure with its cause: the
 * probe's, or the secret storage's when it cannot keep the bearer (the
 * desktop wrapper refuses to store it without the system keychain).
 */
async function attach(target: ResolvedRemotePairingTarget): Promise<"connected" | "failed" | ProbeError["kind"]> {
  const host = new URL(target.httpBaseUrl).host;
  const progress = await getService(IProgressService);
  try {
    await progress.withProgress({ location: ProgressLocation.Notification, title: `Pult: connecting to ${host}…` }, () =>
      connection.connect(target),
    );
    return "connected";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const detail = error instanceof ProbeError ? error.detail : error.message;
    (await getService(INotificationService)).error(`Pult could not connect to ${host}. ${detail}`);
    return error instanceof ProbeError ? error.kind : "failed";
  }
}
