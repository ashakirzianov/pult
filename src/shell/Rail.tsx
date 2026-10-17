import { useSyncExternalStore } from "react";

import { type ShellThread, threadStore } from "../threads/store.ts";
import { selection } from "./selection.ts";
import { runCommand } from "./commands.ts";

/**
 * The left column: every thread of the environment, by project, the way a
 * mail client lists conversations. Pult's own React, outside the workbench.
 */
export function Rail() {
  const state = useSyncExternalStore((l) => threadStore.subscribe(l), () => threadStore.get());
  const selected = useSyncExternalStore((l) => selection.subscribe(l), () => selection.get());
  const groups = new Map<string, ShellThread[]>();
  for (const thread of [...state.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const group = groups.get(thread.projectName) ?? [];
    group.push(thread);
    groups.set(thread.projectName, group);
  }
  return (
    <aside className="pult-rail">
      <header className="pult-rail-head">
        <img src="/pult.svg" alt="" width={22} height={22} />
        <span className="pult-rail-title">Pult</span>
        <button className="pult-icon-button" title="New thread" onClick={() => runCommand("pult.newThread")}>
          +
        </button>
      </header>
      <div className="pult-rail-list">
        {state.environment === null ? (
          <button className="pult-rail-connect" onClick={() => runCommand("pult.connect")}>
            Connect to an environment…
          </button>
        ) : null}
        {[...groups].map(([project, threads]) => (
          <section key={project}>
            <h2 className="pult-rail-project">{project}</h2>
            {threads.map((thread) => (
              <button
                key={thread.id}
                className={`pult-rail-row${thread.id === selected ? " selected" : ""}`}
                onClick={() => selection.set(thread.id)}
              >
                <span className={`pult-dot ${thread.working ? "working" : thread.settled ? "settled" : "idle"}`} />
                <span className="pult-rail-row-title">{thread.title}</span>
                <span className="pult-rail-row-time">{short(thread.updatedAt)}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <footer className="pult-rail-foot">
        {state.environment === null ? (
          <span>No environment</span>
        ) : (
          <>
            <span className={`pult-dot ${state.environment.phase === "ready" ? "ready" : "idle"}`} />
            <span className="pult-rail-env">{state.environment.label}</span>
            <button className="pult-link" onClick={() => runCommand("workbench.action.toggleSidebarVisibility")}>
              Explorer
            </button>
          </>
        )}
      </footer>
    </aside>
  );
}

function short(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
