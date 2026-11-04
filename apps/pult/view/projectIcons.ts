// Upstream's project icon sources for the page's own cards and tabs (`src/threads/projectIcon.ts`):
// the favicon cache the view's `ProjectFavicon` reads, one for both, and its Lucide icons as SVG
// markup. Imported statically by the page; the Lucide set and the renderer load on first use.
import { createElement } from "react";

export { projectFaviconCache } from "~/assets/projectFaviconCache";

/** A Lucide icon by its saved name, as upstream resolves it, drawn in `color` as an SVG document; its folder icon for an unknown name. */
export async function lucideIconSvg(name: string, color: string): Promise<string> {
  const [{ lucideIconByName }, { FolderCodeIcon }, { renderToStaticMarkup }] = await Promise.all([
    import("~/lib/lucideIconByName"),
    import("lucide-react"),
    import("react-dom/server"),
  ]);
  return renderToStaticMarkup(
    createElement(lucideIconByName(name) ?? FolderCodeIcon, { color, size: 16 }),
  );
}
