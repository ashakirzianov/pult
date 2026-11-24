// An image a document the reader shows names by a file path (`render.ts`,
// `readImage`), read by the shell the way it reads the document, through the
// `pult:` files, and handed to the frame as a `data:` URL, whose policy stays
// `data:` alone (`pult/decisions`, `html-reader-rendering`). Only a path a
// click on it would open is read: the click's own resolver (`resolve.ts`) on
// the document's checkouts and roots, a relative path from the document's
// folder.
import { getService, IFileService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";

import { joinPath, parentOf, toHostPath, toUriPath } from "../files/paths.ts";
import { resolveThreadPath } from "../files/resolve.ts";
import { pultResource, whenListed } from "../files/workspace.ts";
import { documentPathInput } from "../threads/files.ts";
import type { ImageShown } from "./render.ts";

/** An image's bytes, at most. */
const IMAGE_LIMIT = 10 * 1024 * 1024;

/** The types the frame's `img` shows, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** `path`'s `.` and `..` segments taken out. */
function normalized(path: string): string {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** The bytes as a `data:` URL of `type`. */
const dataUrl = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type }));
  });

/** The image `src` names in `document`, a `pult:` file, as the frame shows it, or why not. */
export async function readImage(document: URI, src: string): Promise<ImageShown> {
  let path = src;
  try {
    path = decodeURIComponent(src);
  } catch {
    // A malformed escape names the file as written.
  }
  const type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (type === undefined) return { refused: "not an image the preview shows" };
  const environmentId = document.authority;
  const uriPath = path.startsWith("/")
    ? toUriPath(path)
    : normalized(joinPath(parentOf(document.path), path));
  const [files] = await Promise.all([getService(IFileService), whenListed(environmentId)]);
  const resolution = await resolveThreadPath({
    ...documentPathInput(environmentId, document.path),
    path: toHostPath(uriPath),
    exists: (candidate) => files.exists(pultResource(environmentId, candidate)).catch(() => false),
  });
  switch (resolution.kind) {
    case "outside":
      return { refused: "outside the projects" };
    case "missing":
      return { refused: "missing" };
    case "pick":
      return { refused: "several files match" };
    case "open":
      break;
  }
  const resource = pultResource(environmentId, resolution.path);
  // A stock server's stat guesses the size, so the bytes read are measured too.
  if ((await files.stat(resource)).size > IMAGE_LIMIT) return { refused: "over 10 MB" };
  const { value } = await files.readFile(resource);
  if (value.byteLength > IMAGE_LIMIT) return { refused: "over 10 MB" };
  return { url: await dataUrl(value.buffer as Uint8Array<ArrayBuffer>, type) };
}
