// `pult_star_list` (xaxis `pult/tasks/star-directory-tool.task`): a thread finds the Stars of this
// server, each with the id `pult_star_message` takes, its name and its record's `description`.
// Declared through the server's `McpToolAccess`, so it refuses the callers `pult_star_message` does.
import { OrchestratorMcpFailure } from "@t3tools/contracts";

import {
  Effect,
  McpInvocationContext,
  McpLinkOrigin,
  McpSchema,
  McpThreadAccess,
  McpToolAccess,
  Schema,
  ThreadManagementService,
  Tool,
  Toolkit,
  toolkitRegistration,
} from "../host.ts";
import { starName } from "./record.ts";
import type { Stars } from "./stars.ts";

const StarListTool = Tool.make("pult_star_list", {
  description:
    "The Stars on this server, the user's personal agents in Pult: each with its `id`, the address `pult_star_message` takes, its `name`, and its `description`, what the Star is for in its own or the user's words, empty where none is written. The calling Star is listed too. Stars on other environments are not listed.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    stars: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "List the Stars")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  // Thread-bound, so outside clients, which it refuses, are not offered it either.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const StarListToolkit = Toolkit.make(StarListTool);

const unavailable = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const listStars = Effect.fn("PultTools.listStars")(function* (stars: Stars) {
  // The list exists to address `pult_star_message`, so it refuses fenced work as that tool does.
  yield* McpLinkOrigin.assertNotLinked(yield* McpThreadAccess.loadCaller(), "list the Stars");
  const found = yield* stars.list.pipe(Effect.mapError(unavailable));
  const listed = found.map((star) => ({
    id: star.id,
    name: starName(star),
    description: star.description,
  }));
  listed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { stars: listed };
});

/** The tool's registration, to build in the plugin's activation once everything else is up. */
export const make = (stars: Stars) =>
  Effect.succeed(
    toolkitRegistration(
      StarListToolkit,
      McpToolAccess.toLayer(StarListToolkit, {
        pult_star_list: McpToolAccess.readsAsCaller(() => listStars(stars)),
      }),
    ),
  );
