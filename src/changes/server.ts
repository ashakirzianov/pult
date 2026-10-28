import { EnvironmentRpcUnavailableError, request } from "@t3tools/client-runtime/rpc";
import {
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  WS_METHODS,
} from "@t3tools/contracts";

import { connection, type ShellEnvironment } from "../connection/index.ts";

/** How long a call waits for a connecting page before it fails. */
const READY_TIMEOUT_MS = 15_000;

/** The server's review calls the changes view uses, on the page's connection: a project's diff sources with their files, and a file's two sides. */
export const changesServer = {
  diffPreview: async (input: ReviewDiffPreviewInput): Promise<ReviewDiffPreviewResult> => {
    await whenReady();
    return connection.run(request(WS_METHODS.reviewGetDiffPreview, input));
  },
  diffFileContents: async (input: ReviewDiffFileContentsInput): Promise<ReviewDiffFileContentsResult> => {
    await whenReady();
    return connection.run(request(WS_METHODS.reviewGetDiffFileContents, input));
  },
};

/** Resolves once the page's connection is ready; fails at once without an environment, or when it stays unready. */
function whenReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const environment = connection.environment;
      if (environment?.phase === "ready") {
        resolve();
        return true;
      }
      // A saved environment publishes itself shortly after the page restores it.
      const waiting =
        environment === null
          ? connection.credential !== undefined
          : environment.phase === "connecting" || environment.phase === "reconnecting";
      if (waiting) return false;
      reject(unavailable(environment));
      return true;
    };
    if (settle()) return;
    const stop = connection.onDidChange(() => {
      if (!settle()) return;
      clearTimeout(timer);
      stop();
    });
    const timer = setTimeout(() => {
      stop();
      reject(unavailable(connection.environment));
    }, READY_TIMEOUT_MS);
  });
}

function unavailable(environment: ShellEnvironment | null) {
  return new EnvironmentRpcUnavailableError({
    environmentId: environment?.environmentId ?? "",
    message:
      environment === null
        ? "Pult is not connected to an environment."
        : (environment.error ?? `${environment.label} is ${environment.phase}.`),
  });
}
