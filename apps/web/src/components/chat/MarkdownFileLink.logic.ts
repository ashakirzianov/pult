import type { EnvironmentId } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

import type { MarkdownFileLinkMeta } from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

/**
 * Pult: `text` is the chip's text as written, an inline code span's or a link's destination, its
 * "Copy <text>" first, so a chip that names no file copies what it said.
 */
export function markdownFileCopyMenuItems({
  targetPath,
  workspaceRelativePath,
  text,
}: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath"> & { text: string }) {
  const items = [
    {
      id: "copy-full",
      label: m(msg("Copy full path")),
      value: targetPath,
      title: m(msg("Full path")),
    },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: m(msg("Copy relative path")),
      value: `${workspaceRelativePath}${position}`,
      title: m(msg("Relative path")),
    });
  }
  items.unshift({
    id: "copy-text",
    label: m(msg("Copy {text}", { text })),
    value: text,
    title: m(msg("Text")),
  });
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return input.canOpenInBrowser && !input.canOpenInEditor && !input.canOpenInPanel;
}
