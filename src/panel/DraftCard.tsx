import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { projectIconUri } from "../threads/projectIcon.ts";
import { threadStore } from "../threads/store.ts";

/**
 * The selected draft of a new thread, at the top of the cards while it is
 * selected: a thread card's look, the project's icon and name with a pen
 * where a thread's status sits, then "New thread". It has no card once
 * another selection is made; its project's New Thread brings it back.
 */
export function DraftCard({ projectId }: { projectId: string }) {
  const project = threadStore.project(projectId);
  const name = project?.name ?? "Project";
  return (
    <li className="pult-card pult-card-selected pult-card-draft">
      <button
        type="button"
        className="pult-card-select"
        aria-current
        onClick={() => void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.newThread", projectId))}
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={projectIconUri(name, project?.icon ?? null).toString(true)} alt="" />
          <span className="pult-card-project">{name}</span>
          <span className="pult-card-status">
            <i className="codicon codicon-edit" title="Draft" aria-label="Draft" />
          </span>
        </span>
        <span className="pult-card-title">New thread</span>
      </button>
    </li>
  );
}
