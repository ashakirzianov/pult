// The thread view's file chip as markup, for the reader's frame (`src/reader/render.ts`, `chips`),
// which runs no script: upstream's chip (`MarkdownFileLink.tsx`), its link shape and kind, the
// file's icon and its label, drawn once to a string. The icon's sprite is the page's alone, so
// its shape is copied into the icon in place of the reference to it.
import { renderToStaticMarkup } from "react-dom/server";

import { ContextChip, ContextChipLabel } from "~/components/ContextChip";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { documentChipKindForFileName } from "~/pierre-icons";

/** Upstream's class for a chip in a message's Markdown (`MarkdownFileLink.tsx`). */
const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

/** The chip of the file at `path`, reading `label`, in `theme`'s icon colours. */
export function readerChip(path: string, label: string, theme: "light" | "dark"): string {
  const template = document.createElement("template");
  template.innerHTML = renderToStaticMarkup(
    <ContextChip
      kind={documentChipKindForFileName(path) ?? "mention"}
      dir="ltr"
      render={<a href="#" />}
      className={MARKDOWN_FILE_LINK_CLASS_NAME}
    >
      <PierreEntryIcon pathValue={path} kind="file" theme={theme} />
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>,
  );
  for (const use of template.content.querySelectorAll("use")) {
    const symbol = document.getElementById(use.getAttribute("href")?.slice(1) ?? "");
    const icon = use.parentElement;
    if (symbol === null || icon === null) continue;
    const viewBox = symbol.getAttribute("viewBox");
    if (viewBox !== null) icon.setAttribute("viewBox", viewBox);
    icon.replaceChildren(...[...symbol.childNodes].map((node) => node.cloneNode(true)));
  }
  return template.innerHTML;
}
