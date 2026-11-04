import { useState } from "react";

/**
 * A collapsible header after upstream's: the label and its count when one is
 * given, a status when one is given, and the chevron at the far end. A
 * shelf's and a card's subagents'. `title` is its tooltip and
 * `onContextMenu` its right-click, the Limits shelf's.
 */
export function CollapsibleHeader({
  label,
  count,
  expanded,
  onToggle,
  status = null,
  title,
  onContextMenu,
}: {
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  status?: React.ReactNode;
  title?: string;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  return (
    <button type="button" className="pult-shelf-header" aria-expanded={expanded} title={title} onClick={onToggle} onContextMenu={onContextMenu}>
      <span className="pult-shelf-label">{label}</span>
      {count !== undefined ? <span className="pult-shelf-count">{count}</span> : null}
      <span className="pult-shelf-spacer" aria-hidden />
      {status}
      <i className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`} aria-hidden />
    </button>
  );
}

/** A collapsible's state, kept in localStorage under `key`; collapsed until opened, or with `initial` open until closed. */
export function useExpanded(key: string, initial = false): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpanded] = useState(() => storedExpanded(key, initial));
  return [
    expanded,
    (next) => {
      localStorage.setItem(key, String(next));
      setExpanded(next);
    },
  ];
}

/** A collapsible's state as `useExpanded` keeps it, for code outside its component: the jumps (`jump.ts`). */
export function storedExpanded(key: string, initial = false): boolean {
  const stored = localStorage.getItem(key);
  return stored === null ? initial : stored === "true";
}
