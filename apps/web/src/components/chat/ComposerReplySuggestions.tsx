// Pult's hook point, not upstream's: the replies an ask's poster suggests, as chips above the
// message input of the composer the ask is answered in (`ShellReply.suggestions`). A click fills
// the input and sends nothing.
import { useGT } from "gt-react";

import { useShellReplySuggestions } from "./ShellComposerOptions";

export function ComposerReplySuggestions(props: { readonly onPick: (text: string) => void }) {
  const gt = useGT();
  const suggestions = useShellReplySuggestions();
  if (suggestions.length === 0) return null;
  return (
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
  );
}
