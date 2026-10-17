import { useSyncExternalStore } from "react";
import { Uri } from "monaco-editor";

import { threadStore } from "../threads/store.ts";
import { ThreadView } from "../threads/ThreadView.tsx";
import { runCommand } from "./commands.ts";
import { selection } from "./selection.ts";

/**
 * The centre column: the selected thread, full height, no tabs. The editor
 * groups to its right are where its citations open; the two buttons show the
 * seams, a file of the thread's project in the stock editor and the same
 * thread as a tab in the groups (the question 1 pane).
 */
export function Centre() {
  const selected = useSyncExternalStore((l) => selection.subscribe(l), () => selection.get());
  const state = useSyncExternalStore((l) => threadStore.subscribe(l), () => threadStore.get());
  const thread = state.threads.find((candidate) => candidate.id === selected);
  if (selected === null || thread === undefined) {
    return <main className="pult-centre pult-centre-empty">Pick a thread, or start one.</main>;
  }
  const openFile = (name: string) => {
    if (state.environment === null || thread.projectRoot === null) return;
    const uri = Uri.from({ scheme: "pult", authority: state.environment.id, path: `${thread.projectRoot}/${name}` });
    void runCommand("vscode.open", uri, { preview: false });
  };
  return (
    <main className="pult-centre">
      <div className="pult-centre-actions">
        <button className="pult-link" onClick={() => openFile("README.md")}>
          Open README.md beside
        </button>
        <button className="pult-link" onClick={() => void runCommand("pult-shell.openThreadPane", thread.id)}>
          Open as a tab
        </button>
        <button className="pult-link" onClick={() => void runCommand("pult.openThread", thread.id)}>
          Open the webview tab
        </button>
      </div>
      <div className="pult-centre-scroll">
        <ThreadView threadId={thread.id} />
      </div>
      <form className="pult-composer" onSubmit={(event) => event.preventDefault()}>
        <textarea placeholder={`Message ${thread.projectName}…`} rows={3} disabled />
        <div className="pult-composer-row">
          <span className="pult-composer-hint">The composer is upstream's; it mounts here with the thread view.</span>
        </div>
      </form>
    </main>
  );
}
