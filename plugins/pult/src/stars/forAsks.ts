// The Stars as the asks reach them (`asks/asks.ts`, `AskStars`): two features of one plugin, so a
// port rather than a contract call; when the Stars' core moves onto the contract, only this does.
import { ThreadId } from "@t3tools/contracts";

import type { AskStars } from "../asks/asks.ts";
import { Effect, type Path } from "../host.ts";
import type { Deliver } from "./deliver.ts";
import type { Stars } from "./stars.ts";

/** The asks folder, Pult's Markdown for the asks posted as `text`: beside the Stars directory. */
export const asksFolderOf = (starsDirectory: string, path: Path.Path) =>
  path.join(path.dirname(starsDirectory), "asks");

export const forAsks = (stars: Stars, deliver: Deliver, path: Path.Path): AskStars => ({
  asksFolder: asksFolderOf(stars.directory, path),
  posterOf: (threadId) =>
    Effect.map(stars.ofThread(ThreadId.make(threadId)), (own) =>
      own === undefined ? undefined : { star: own.star.id, channel: own.channel },
    ),
  tell: Effect.fn("AskStars.tell")(function* ({ star: starId, channel, text, from, key }) {
    const star = yield* stars.get(starId);
    if (star === undefined) return "gone" as const;
    yield* deliver({ star, text, from, to: channel, key, sender: "plugin" });
    return "told" as const;
  }),
});
