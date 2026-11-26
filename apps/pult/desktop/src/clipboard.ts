import { clipboard } from "electron";

/**
 * The private pasteboard type desktop VS Code's Copy writes in its explorer,
 * `code/file-list`, as Electron's `clipboard.read()` names a raw OS type.
 */
const FILE_LIST_TYPE = 'electron application/osclipboard;format="code/file-list"';

/**
 * The files desktop VS Code's Copy put on the clipboard, as its pasteboard
 * type holds them, their `file:` URIs one a line
 * (`NativeClipboardService.writeResources`); empty for anything else.
 */
export async function copiedFileList(): Promise<string> {
  for (const item of await clipboard.read()) {
    if (!item.types.includes(FILE_LIST_TYPE)) continue;
    const data = await item.getType(FILE_LIST_TYPE);
    if (!(data instanceof Blob)) throw new Error(`${FILE_LIST_TYPE} is not a Blob.`);
    return data.text();
  }
  return "";
}
