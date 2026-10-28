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


import { connection, type ShellEnvironment } from "./connection.ts";
import { ConnectedContext } from "./contextKey.ts";
import { parseConnectInput } from "./pairing.ts";
import { ProbeError } from "./probe.ts";

/**
 * The palette's "Pult: Connect to Environment" (`pult-shell.connect`), which
 * adds an environment beside those the page holds, "Pult: Disconnect"
 * (`pult-shell.disconnect [environmentId]`, while the page holds one, which
 * it forgets with its bearer) and "Pult: Retry Connection"
 * (`pult-shell.retryConnection [environmentId]`, for one waiting between
 * attempts); with several environments held, the last two pick one first.
 * The prompts are the page's, so no extension can bind the page to a server
 * of its choosing; only a development build takes a pairing link as
 * argument, for `scripts/drive.ts`.
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

      async run(_accessor: ServicesAccessor, environmentId?: unknown): Promise<void> {
        const picked =
          typeof environmentId === "string"
            ? connection.environment(environmentId)
            : await pickEnvironment(connection.environments, "Disconnect from an environment");
        if (picked !== undefined) await connection.disconnect(picked.environmentId);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.retryConnection",
          title: { value: "Retry Connection", original: "Retry Connection" },
          category,
          f1: true,
          precondition: ConnectedContext,
        });
      }

      async run(_accessor: ServicesAccessor, environmentId?: unknown): Promise<void> {
        if (typeof environmentId === "string") return connection.retryNow(environmentId);
        const waiting = connection.environments.filter((environment) => environment.phase !== "ready");
        if (waiting.length === 0) {
          return void (await getService(INotificationService)).info("Pult: every environment is connected.");
        }
        const picked = await pickEnvironment(waiting, "Retry an environment's connection now");
        if (picked !== undefined) await connection.retryNow(picked.environmentId);
      }
    },
  );
}

/** How an environment's connection stands, for a pick: its server's host and phase, and its error when it has one. */
function describeEnvironment(environment: ShellEnvironment): { description: string; detail?: string } {
  const host = URL.canParse(environment.httpBaseUrl) ? `${new URL(environment.httpBaseUrl).host} · ` : "";
  return { description: `${host}${environment.phase}`, ...(environment.error === null ? {} : { detail: environment.error }) };
}

/**
 * One of `environments`, picked in the shell's quick input, each with its
 * phase and error; one needs no pick, none gives undefined.
 */
export async function pickEnvironment(
  environments: ReadonlyArray<ShellEnvironment>,
  placeHolder: string,
): Promise<ShellEnvironment | undefined> {
  if (environments.length <= 1) return environments[0];
  const picked = await (await getService(IQuickInputService)).pick(
    environments.map((environment) => ({ label: environment.label, ...describeEnvironment(environment), environment })),
    { placeHolder, matchOnDescription: true },
  );
  return picked?.environment;
}

/** Connects the page to another environment, or a held one anew with the bearer given. */
async function connect(): Promise<void> {
  const quickInput = await getService(IQuickInputService);
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
