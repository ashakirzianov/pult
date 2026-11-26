// A message's header caption (`messageHeader.ts`) over its bubble, drawn as the composer's reply
// destination is (`apps/web/src/components/chat/ComposerReplySuggestions.tsx`) at the row's caption
// size: the reply arrow, the lead, the name in bold, the note after a dot. The timeline's row
// (`ThreadView.tsx`) and a Star's transcript (`StarTranscript.tsx`) draw it.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type MessageHeaderCaption, ThreadId } from "@t3tools/contracts";
import { ReplyIcon } from "lucide-react";

import { useQuietThreadShell } from "~/state/entities";
import { threadViewHost } from "./host.ts";

/** The caption of `extension`'s on `environmentId`, its name a link to a thread the view holds there, or to Pult's ask, else plain. */
export function MessageCaption({
  caption,
  extension,
  environmentId,
}: {
  caption: MessageHeaderCaption;
  extension: string;
  environmentId: string;
}) {
  const { open } = caption;
  const thread = useQuietThreadShell(
    open !== null && "thread" in open
      ? scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(open.thread))
      : null,
  );
  const opens =
    open === null
      ? null
      : "thread" in open
        ? thread === null
          ? null
          : () => threadViewHost().openThread(environmentId, open.thread)
        : () => threadViewHost().openRow(environmentId, extension, open.row);
  return (
    <p
      className="me-1 flex min-w-0 max-w-[80%] items-center gap-1 text-2xs whitespace-nowrap text-muted-foreground/70"
      data-user-message-attribution="header"
    >
      {caption.reply ? (
        <ReplyIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
      {/* Each part ellipsed on its own, the note giving way first, so a long name keeps its link in view. */}
      <span className="shrink-0">{caption.lead}</span>
      {caption.name === null ? null : opens === null ? (
        <span className="min-w-0 truncate font-medium text-foreground">{caption.name}</span>
      ) : (
        <button
          type="button"
          className="min-w-0 cursor-pointer truncate font-medium text-foreground underline decoration-foreground/35 underline-offset-2"
          onClick={opens}
        >
          {caption.name}
        </button>
      )}
      {caption.note === null ? null : (
        <span className="min-w-0 shrink-[4] truncate">· {caption.note}</span>
      )}
    </p>
  );
}

/** What a folded message names its sender by: the name and the note, else the lead. */
export const captionLabel = (caption: MessageHeaderCaption) =>
  caption.name === null
    ? caption.lead
    : caption.note === null
      ? caption.name
      : `${caption.name} · ${caption.note}`;
