import { createRoot } from "react-dom/client";

import { Centre } from "./Centre.tsx";
import { Rail } from "./Rail.tsx";
import "./shell.css";

/**
 * Builds the page: Pult's rail and thread column as React roots of their own,
 * and the element the workbench is initialised into on the right. Returns that
 * element. The workbench never sees the two columns beside it.
 */
export function mountShell(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "pult-shell";
  const rail = document.createElement("div");
  rail.style.display = "contents";
  const centre = document.createElement("div");
  centre.style.display = "contents";
  const editor = document.createElement("section");
  editor.className = "pult-editor";
  const workbench = document.createElement("div");
  workbench.id = "workbench";
  editor.append(workbench);
  shell.append(rail, centre, editor);
  document.body.replaceChildren(shell);
  createRoot(rail).render(<Rail />);
  createRoot(centre).render(<Centre />);
  return workbench;
}
