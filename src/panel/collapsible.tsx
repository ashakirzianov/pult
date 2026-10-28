import { useState } from "react";

/**
 * A collapsible header after upstream's: the label and its count when one is
 * given, a status when one is given, and the chevron at the far end. A
 * shelf's and a card's subagents'.
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
      <i className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`} aria-hidden />
    </button>
  );
}

/** A collapsible's state, kept in localStorage under `key`; collapsed until opened, or with `initial` open until closed. */
export function useExpanded(key: string, initial = false): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpanded] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === "true";
  });
  return [
    expanded,
    (next) => {
      localStorage.setItem(key, String(next));
      setExpanded(next);
    },
  ];
}
