// The thread view's lightbox for an image of a reader's page (`src/reader/pane.ts`): upstream's
// `ExpandedImageDialog`, over the shell's page, opened and closed as a message's image is.
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { I18nProvider } from "~/i18n/I18nProvider";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

let root: Root | undefined;
let opened = 0;

/** Shows `images[index]` in the lightbox, the page's other images a step away, until it closes. */
export function showReaderImage(
  images: ReadonlyArray<{ readonly src: string; readonly name: string }>,
  index: number,
): void {
  root ??= createRoot(document.createElement("div"));
  const shown = root;
  // The dialog closes inside its own handler, so the root stays and renders nothing.
  shown.render(
    <StrictMode>
      <I18nProvider>
        <AppAtomRegistryProvider>
          <ExpandedImageDialog
            key={++opened}
            preview={{ images: images.map(({ src, name }) => ({ src, name })), index }}
            onClose={() => shown.render(null)}
          />
        </AppAtomRegistryProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
