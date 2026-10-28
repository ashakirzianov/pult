import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { projectIconUri, useProjectIcons } from "../threads/projectIcon.ts";
import { threadStore } from "../threads/store.ts";

/**
 * A project's draft of a new thread, Ready's first cards: a thread card's
 * look, the project's icon and name, its `environment`'s label beside them
 * while there are several, with a pen where a thread's status sits, then
 * its `preview`, the prompt's first line, or "New thread" for an empty one.
 * A click selects it (`pult-shell.newThread`).
 */
export function DraftCard({
  environmentId,
  projectId,
  environment,
  preview,
  selected,
}: {
  environmentId: string;
  projectId: string;
  environment: string | undefined;
  preview: string;
  selected: boolean;
}) {
  const project = threadStore.project(environmentId, projectId);
  const name = project?.name ?? "Project";
  useProjectIcons();
  return (
    <li className={`pult-card pult-card-draft${selected ? " pult-card-selected" : ""}`}>
      <button
        type="button"
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={() =>
          void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.newThread", environmentId, projectId))
        }
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={projectIconUri(project ?? { environmentId, name, root: null, icon: null, faviconPath: null }).toString(true)} alt="" />
          <span className="pult-card-project">{name}</span>
          <EnvironmentChip label={environment} />
          <span className="pult-card-status">
            <i className="codicon codicon-edit" title="Draft" aria-label="Draft" />
          </span>
        </span>
        <span className="pult-card-title">{preview.length > 0 ? preview : "New thread"}</span>
      </button>
    </li>
  );
}

/** A card's environment, a small muted chip beside its project, while the page holds several; nothing with `label` undefined. */
export function EnvironmentChip({ label }: { label: string | undefined }) {
  if (label === undefined) return null;
  return (
    <span className="pult-card-environment" title={`Environment: ${label}`}>
      {label}
    </span>
  );
}
