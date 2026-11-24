import { useSyncExternalStore } from "react";

import { posterName } from "../asks/asks.ts";
import { starMarks, starStillUrl } from "../stars/mark.ts";
import type { RoutePoster } from "../stars/plugin.ts";
import { starById, starStore } from "../stars/model.ts";
import type { Star } from "../stars/stars.ts";
import { projectIconUri, threadProjectIcon, useProjectIcons } from "../threads/projectIcon.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** The poster's icon in the project's place: a Star's mark as its tab shows it, a thread's project's icon. */
function PosterIcon({ star, thread }: { star: Star | undefined; thread: ShellThread | undefined }) {
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  useProjectIcons();
  if (star !== undefined)
    return <img className="pult-card-icon" src={starStillUrl(star, marks)} alt="" />;
  if (thread !== undefined)
    return (
      <img
        className="pult-card-icon"
        src={projectIconUri(threadProjectIcon(thread)).toString(true)}
        alt=""
      />
    );
  return <i className="codicon codicon-comment-discussion pult-card-icon" aria-hidden />;
}

/**
 * A row an agent posted for the user, an ask's or a secret's, in a thread
 * card's look: its poster in the project's place, a Star's mark and name
 * with its channel but its default one, or the posting thread's project icon and
 * title, its environment's chip while there are several, its `slot` where a
 * thread's status sits (its status, giving way to its actions on hover), and
 * its title. A click, or Enter, runs `onOpen`.
 */
export function PosterCard({
  environmentId,
  poster,
  environment,
  rowKey,
  title,
  settled = false,
  slot,
  onOpen,
}: {
  environmentId: string;
  poster: RoutePoster;
  environment: string | undefined;
  rowKey: string;
  title: string;
  settled?: boolean;
  slot: React.ReactNode;
  onOpen: () => void;
}) {
  useSyncExternalStore(starStore.subscribe, starStore.get);
  const { threads } = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const star = "star" in poster ? starById(poster.star) : undefined;
  const thread =
    "thread" in poster
      ? threads.find((each) => each.environmentId === environmentId && each.id === poster.thread)
      : undefined;
  const name = posterName({ environmentId, poster }, starById, () => thread?.title);
  return (
    <li className={`pult-card${settled ? " pult-card-settled" : ""}`}>
      {/* A button by role, as a thread's card: its actions are buttons inside it. */}
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        title={title}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="pult-card-top">
          <PosterIcon star={star} thread={thread} />
          <span className="pult-card-project">{name}</span>
          <EnvironmentChip label={environment} />
          {slot}
        </span>
        <span className="pult-card-title">{title}</span>
        <JumpHint rowKey={rowKey} />
      </div>
    </li>
  );
}
