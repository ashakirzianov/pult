// Pult's hook point, not upstream's: above the message input of the composer an ask is answered
// in, the line naming where the reply arrives (`ShellReply.destination`), its name a link to the
// thread while there is one, and the replies the ask's poster suggests, as chips
// (`ShellReply.suggestions`). A chip's click fills the input and sends nothing.
import { useGT } from "gt-react";
import { ReplyIcon } from "lucide-react";

import { useShellReplyDestination, useShellReplySuggestions } from "./ShellComposerOptions";

export function ComposerReplySuggestions(props: { readonly onPick: (text: string) => void }) {
  const gt = useGT();
  const destination = useShellReplyDestination();
  const suggestions = useShellReplySuggestions();
  return (
    <>
      {destination === null ? null : (
        <div
          data-composer-reply-destination="true"
          className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground"
        >
          <ReplyIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {/* Each part ellipsed on its own, the note giving way first, so a long name keeps its link in view. */}
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0">{gt("Reply to")}</span>{" "}
            {destination.open === null ? (
              <span className="min-w-0 truncate font-medium text-foreground">
                {destination.name}
              </span>
            ) : (
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
                onClick={destination.open}
              >
                {destination.name}
              </button>
            )}{" "}
            {destination.note === null ? null : (
              <span className="min-w-0 shrink-[4] truncate">· {destination.note}</span>
            )}
          </span>
        </div>
      )}
      {suggestions.length === 0 ? null : (
        <div
          role="group"
          aria-label={gt("Suggested replies")}
          data-composer-reply-suggestions="true"
          className="mb-2 flex flex-wrap gap-1.5"
        >
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              className="max-w-full cursor-pointer rounded-xl border border-border px-2.5 py-1 text-left text-xs leading-snug wrap-anywhere whitespace-pre-wrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              // The editor keeps its focus and selection through the click.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => props.onPick(text)}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
