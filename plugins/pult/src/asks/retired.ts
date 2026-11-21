// The Stars' asks before `pult_ask` (`asks.ts`): files a Star wrote in `.pult/asks/`, which Pult no
// longer reads. Each Star with any left there is told once, at the plugin's start, to post again
// what is still open; nothing is imported, since a file names no channel to answer in.
import { Cause, Effect, FileSystem, Path } from "../host.ts";
import type { Deliver } from "../stars/deliver.ts";
import type { Stars } from "../stars/stars.ts";

const RETIRED_DIRECTORY = ".pult/asks";

export const RETIRED_ASKS_NOTICE = `Pult no longer reads \`${RETIRED_DIRECTORY}/\`, so the user no longer sees the asks there. Post each one still open again with \`pult_ask\`, naming a file of yours with \`file\` or passing its text as \`text\`, from the channel that should get the reply, then delete \`${RETIRED_DIRECTORY}/\`. Your \`AGENTS.md\` says how asks work now.`;

/** Tells each Star with a `.md` file left in `.pult/asks/`, in `work`, once per server: the key replays. */
export const tellRetiredAsks = Effect.fn("Asks.tellRetired")(function* (
  stars: Stars,
  deliver: Deliver,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const star of yield* stars.list) {
    const folder = path.join(star.root, RETIRED_DIRECTORY);
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    if (!names.some((name) => name.endsWith(".md"))) continue;
    yield* deliver({
      star,
      text: RETIRED_ASKS_NOTICE,
      from: "Pult, about your asks",
      to: "work",
      key: "asks-retired",
      sender: "plugin",
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Could not tell a Star its asks moved to pult_ask.", {
            starId: star.id,
            cause,
          }),
      ),
    );
  }
});
