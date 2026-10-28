import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { projectIconUri } from "../threads/projectIcon.ts";
import { threadStore } from "../threads/store.ts";

/**
 * The selected draft of a new thread, at the top of the cards while it is
 * selected: a thread card's look, the project's icon and name, its
 * `environment`'s label beside them while there are several, with a pen
 * where a thread's status sits, then "New thread". It has no card once
 * another selection is made; its project's New Thread brings it back.
 */
export function DraftCard({
  environmentId,
  projectId,
  environment,
}: {
  environmentId: string;
  projectId: string;
  environment: string | undefined;
}) {
  const project = threadStore.project(environmentId, projectId);
  const name = project?.name ?? "Project";
  return (
    <li className="pult-card pult-card-selected pult-card-draft">
      <button
        type="button"
        className="pult-card-select"
        aria-current
        onClick={() =>
          void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.newThread", environmentId, projectId))
        }
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={projectIconUri(name, project?.icon ?? null).toString(true)} alt="" />
          <span className="pult-card-project">{name}</span>
          <EnvironmentChip label={environment} />
          <span className="pult-card-status">
            <i className="codicon codicon-edit" title="Draft" aria-label="Draft" />
          </span>
        </span>
        <span className="pult-card-title">New thread</span>
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
