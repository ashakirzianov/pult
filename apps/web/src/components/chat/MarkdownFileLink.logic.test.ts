import { expect, it } from "vite-plus/test";

import {
  markdownFileCopyMenuItems,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./MarkdownFileLink.logic";

// Pult: the chip's text as written comes first, with or without a relative path below it.
it("copies the chip's text as written first", () => {
  const ids = (items: ReturnType<typeof markdownFileCopyMenuItems>) =>
    items.map(({ id, label, value }) => ({ id, label, value }));
  expect(
    ids(
      markdownFileCopyMenuItems({
        targetPath: "/repo/threads.send",
        workspaceRelativePath: "threads.send",
        text: "threads.send",
      }),
    ),
  ).toEqual([
    { id: "copy-text", label: "Copy threads.send", value: "threads.send" },
    { id: "copy-relative", label: "Copy relative path", value: "threads.send" },
    { id: "copy-full", label: "Copy full path", value: "/repo/threads.send" },
  ]);
  expect(
    ids(
      markdownFileCopyMenuItems({
        targetPath: "/elsewhere/a.md:3",
        workspaceRelativePath: null,
        text: "/elsewhere/a.md:3",
      }),
    ),
  ).toEqual([
    { id: "copy-text", label: "Copy /elsewhere/a.md:3", value: "/elsewhere/a.md:3" },
    { id: "copy-full", label: "Copy full path", value: "/elsewhere/a.md:3" },
  ]);
});

it("opens PDFs in the file panel and uses the browser only when no other destination exists", () => {
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: true,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: false,
    }),
  ).toBe(true);
});
