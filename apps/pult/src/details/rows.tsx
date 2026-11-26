import type { ReactNode } from "react";

/** One of a row's actions, a button at its end. */
export interface DetailsRowAction {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
}

/**
 * A row of a thread's shelves: a label, a value and actions, the shape an
 * extension's details section takes (`pult/decisions`, `extension-ui`), with
 * its codicon, a line under its label and what its click opens.
 */
export interface DetailsRow {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  readonly description?: string;
  readonly value?: ReactNode;
  readonly title?: string;
  readonly open?: () => void;
  readonly selected?: boolean;
  readonly actions?: ReadonlyArray<DetailsRowAction>;
}

/** A shelf's rows, in the subagents' look. */
export function DetailsRows({ label, rows }: { label: string; rows: ReadonlyArray<DetailsRow> }) {
  return (
    <ul className="pult-subagents-list pult-details-rows" aria-label={label}>
      {rows.map((row) => {
        const content = (
          <>
            <i className={`codicon codicon-${row.icon}`} aria-hidden />
            <span className="pult-details-row-text">
              <span className="pult-subagent-title">{row.label}</span>
              {row.description === undefined ? null : (
                <span className="pult-details-row-description">{row.description}</span>
              )}
            </span>
            {row.value === undefined ? null : <span className="pult-card-status">{row.value}</span>}
          </>
        );
        const className = `pult-subagent${row.selected === true ? " pult-subagent-selected" : ""}`;
        return (
          <li key={row.key} className="pult-details-row">
            {row.open === undefined ? (
              <div className={className} title={row.title}>
                {content}
              </div>
            ) : (
              <button
                type="button"
                className={className}
                title={row.title}
                aria-current={row.selected === true || undefined}
                onClick={row.open}
              >
                {content}
              </button>
            )}
            {(row.actions ?? []).map((action) => (
              <button
                key={action.label}
                type="button"
                className="pult-details-row-action"
                title={action.title}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

/** A title with the workbench's `$(icon)` marks, as Source Control's button reads it, its marks as codicons. */
export function IconLabel({ text }: { text: string }) {
  // Each part keyed by where it starts in the text.
  let at = 0;
  return text.split(/(\$\([a-z0-9~-]+\))/).flatMap((part) => {
    const start = at;
    at += part.length;
    if (part.trim() === "") return [];
    const icon = /^\$\(([a-z0-9~-]+)\)$/.exec(part)?.[1];
    if (icon === undefined) return [<span key={start}>{part.trim()}</span>];
    const [name, modifier] = icon.split("~");
    return [
      <i
        key={start}
        className={`codicon codicon-${name}${modifier === undefined ? "" : ` codicon-modifier-${modifier}`}`}
        aria-hidden
      />,
    ];
  });
}
