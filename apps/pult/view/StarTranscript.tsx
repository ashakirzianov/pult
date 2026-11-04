// A Star's earlier conversation as the fold of its tab shows it
// (`src/stars/fold.tsx`), in the timeline's look: the user's messages in
// upstream's bubble and the Star's as upstream's replies, both through
// upstream's markdown, each tool call a muted line; and the divider between
// conversations, upstream's system divider. Rendered inside the view's own
// providers and router (`MountOptions.timelineHeader`), which upstream's
// markdown needs.
import { EnvironmentId } from "@t3tools/contracts";
import { MoonIcon, WrenchIcon } from "lucide-react";

import ChatMarkdown from "../t3/src/components/ChatMarkdown";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "../t3/src/components/chat/TimelineRowParts";
import { TimelineSystemDivider } from "../t3/src/components/chat/TimelineSystemDivider";
import { cn } from "../t3/src/lib/utils";

/** One entry of a transcript, as `src/stars/transcript.ts` reads it back. */
export interface TranscriptEntry {
  readonly kind: "user" | "star" | "tool";
  readonly at: string;
  readonly text: string;
}

/** Where the transcript's links resolve: the Star's folder on its environment. */
interface Place {
  readonly environmentId: string;
  readonly cwd: string;
}

function Entry({ entry, next, place }: { entry: TranscriptEntry; next: TranscriptEntry | undefined; place: Place }) {
  const environmentId = EnvironmentId.make(place.environmentId);
  if (entry.kind === "user") {
    return (
      <div className="flex flex-col items-end gap-1 pb-4" title={entry.at}>
        <div className="relative min-w-0 max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
          <MessageAuthorHeading>You</MessageAuthorHeading>
          <ChatMarkdown
            text={entry.text}
            cwd={place.cwd}
            environmentId={environmentId}
            className="text-foreground"
            lineBreaks
            parseRawHtml={false}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
          />
        </div>
      </div>
    );
  }
  // The space a row leaves below it, as the timeline's: more before the user's next message.
  const space = next === undefined || next.kind === "user" ? "pb-4" : next.kind === "tool" && entry.kind === "tool" ? undefined : "pb-2";
  if (entry.kind === "star") {
    return (
      <div className={cn("relative min-w-0 px-1 py-0.5", space)} title={entry.at}>
        <MessageAuthorHeading>Star</MessageAuthorHeading>
        <ChatMarkdown text={entry.text} cwd={place.cwd} environmentId={environmentId} headingLevelOffset={MESSAGE_HEADING_LEVEL} />
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-muted-foreground text-xs", space)} title={entry.at}>
      <WrenchIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{entry.text}</span>
    </div>
  );
}

/** A transcript's entries in order. */
export function TranscriptEntries({ entries, environmentId, cwd }: { entries: ReadonlyArray<TranscriptEntry> } & Place) {
  const place = { environmentId, cwd };
  return entries.map((entry, index) => <Entry key={`${entry.at}-${index}`} entry={entry} next={entries[index + 1]} place={place} />);
}

/** The divider after a conversation: "Fell asleep 14:32", with its environment while the page holds several. */
export function ConversationDivider({ label, detail }: { label: string; detail?: string | undefined }) {
  return <TimelineSystemDivider label={label} detail={detail ?? null} icon={MoonIcon} />;
}
