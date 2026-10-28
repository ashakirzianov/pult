import { request } from "@t3tools/client-runtime/rpc";
import {
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  WS_METHODS,
} from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { whenReady } from "../files/server.ts";

/**
 * The server's review calls the changes view uses, on the page's connection
 * to `environmentId`: a project's diff sources with their files, and a file's
 * two sides. A call waits for a connecting environment, as the files' do.
 */
export function changesServer(environmentId: string) {
  return {
    diffPreview: async (input: ReviewDiffPreviewInput): Promise<ReviewDiffPreviewResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(WS_METHODS.reviewGetDiffPreview, input));
    },
    diffFileContents: async (input: ReviewDiffFileContentsInput): Promise<ReviewDiffFileContentsResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(WS_METHODS.reviewGetDiffFileContents, input));
    },
  };
}
