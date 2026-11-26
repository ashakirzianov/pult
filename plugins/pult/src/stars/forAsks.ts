// The Stars as the asks reach them (`asks/asks.ts`, `AskStars`): two features of one plugin, so a
// port rather than a contract call; when the Stars' core moves onto the contract, only this does.
import { ThreadId } from "@t3tools/contracts";

import type { AskStars } from "../asks/asks.ts";
import { Effect, type Path } from "../host.ts";
import type { Delivering } from "./deliver.ts";
import type { Stars } from "./stars.ts";

/** The asks folder, Pult's Markdown for the asks posted as `text`: beside the Stars directory. */
export const asksFolderOf = (starsDirectory: string, path: Path.Path) =>
  path.join(path.dirname(starsDirectory), "asks");

export const forAsks = (
  stars: Stars,
  { deliver, wakeModel }: Delivering,
  path: Path.Path,
): AskStars => ({
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
  reply: Effect.fn("AskStars.reply")(function* ({ star: starId, channel, composed, from, key }) {
    const star = yield* stars.get(starId);
    if (star === undefined)
      return yield* Effect.fail({ message: "The Star that asked is no more on this server." });
    if (composed.runtimeMode !== null || composed.interactionMode !== null)
      return yield* Effect.die(
        new Error("todo: a reply's runtime or interaction mode, which a delivery cannot apply"),
      );
    const delivered = yield* deliver({
      star,
      text: composed.text,
      from,
      to: channel,
      key,
      sender: {
        user: {
          attachments: composed.attachments,
          context: composed.context,
          model: composed.model,
        },
      },
    });
    // Each reply has a key of its own, so none replays.
    if (delivered.threadId === null)
      return yield* Effect.die(new Error("unreachable: a reply's delivery replayed"));
    return delivered.threadId as string;
  }),
  replyTarget: Effect.fn("AskStars.replyTarget")(function* (starId, channel) {
    const star = yield* stars.get(starId);
    if (star === undefined) return undefined;
    const { current, newest } = yield* stars.withConversation(star, channel, (conversations) =>
      Effect.succeed(conversations),
    );
    const model =
      current !== null
        ? current.modelSelection
        : newest === null
          ? null
          : ((yield* wakeModel(star, channel, newest.runtimeMode)) ?? newest.modelSelection);
    return {
      project: star.projectId,
      model,
      note: current === null ? "asleep, wakes in a new conversation" : "into its open conversation",
    };
  }),
});
