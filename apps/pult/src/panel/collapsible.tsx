import { useState } from "react";

/**
 * A collapsible header after upstream's: the label and its count when one is
 * given, a status when one is given, and the chevron at the far end: a
 * card's subagents'; the shelves close instead (`ShelfHeader`, `shelves.tsx`).
 */
export function CollapsibleHeader({
  label,
  count,
  expanded,
  onToggle,
  status = null,
}: {
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  status?: React.ReactNode;
}) {
  return (
    <button type="button" className="pult-shelf-header" aria-expanded={expanded} onClick={onToggle}>
      <span className="pult-shelf-label">{label}</span>
      {count !== undefined ? <span className="pult-shelf-count">{count}</span> : null}
      <span className="pult-shelf-spacer" aria-hidden />
      {status}
      <i
        className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`}
        aria-hidden
      />
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
function storedExpanded(key: string, initial = false): boolean {
  const stored = localStorage.getItem(key);
  return stored === null ? initial : stored === "true";
}
