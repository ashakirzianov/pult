import type { ExtensionShelfRow } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";

import { actOnRow, extensionRows, pendingAction, rowPoster } from "../extensions/index.ts";
import type { PageRow } from "../extensions/ui.ts";
import { showSnoozePresets } from "../threads/park.ts";
import { extensionRowKey } from "./order.ts";
import { age } from "./PanelView.tsx";
import { PosterCard, run } from "./PosterCard.tsx";

const knownIcons = new Set<string>();
const warnedIcons = new Set<string>();

/** Whether the workbench draws the codicon; an unknown one draws nothing and is logged once. */
function known(icon: string): boolean {
  if (knownIcons.has(icon)) return true;
  if (warnedIcons.has(icon)) return false;
  const probe = document.createElement("i");
  probe.className = `codicon codicon-${icon}`;
  document.body.append(probe);
  const drawn = getComputedStyle(probe, "::before").content;
  probe.remove();
  if (drawn !== "" && drawn !== "none") {
    knownIcons.add(icon);
    return true;
  }
  warnedIcons.add(icon);
  console.warn(`[pult-shell] an extension names the icon "${icon}", which is no codicon`);
  return false;
}

function Icon({ icon, spin = false }: { icon: string; spin?: boolean }) {
  return known(icon) ? (
    <i className={`codicon codicon-${icon}${spin ? " codicon-modifier-spin" : ""}`} aria-hidden />
  ) : null;
}

/** When a time comes or came: its time today, else its day and time. */
function clock(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === at.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

function Status({ status, now }: { status: ExtensionShelfRow["status"]; now: number }) {
  const time =
    status.time === undefined
      ? null
      : status.time.as === "age"
        ? age(status.time.at, now)
        : clock(status.time.at, now);
  return (
    <span className="pult-card-status" title={status.label}>
      <Icon icon={status.icon} /> {time ?? status.label}
    </span>
  );
}

/** The row's status, and its actions in its place on hover; the one in flight spinning, the others waiting. */
function Slot({ page, now }: { page: PageRow; now: number }) {
  useSyncExternalStore(extensionRows.subscribe, extensionRows.get);
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = pendingAction(page);
  return (
    <span
      className={`pult-card-slot${menuOpen || pending !== undefined ? " pult-card-slot-open" : ""}`}
    >
      <Status status={page.row.status} now={now} />
      {/* Clicks stop here, short of the row that opens it. None while it is drawn ahead, so its status stays on hover. */}
      {page.row.actions.length === 0 ? null : (
        <span className="pult-card-actions" onClick={(event) => event.stopPropagation()}>
          {page.row.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              title={action.label}
              aria-label={action.label}
              disabled={pending !== undefined}
              {...(action.input === undefined
                ? { onClick: () => void actOnRow(page, action.id) }
                : {
                    "aria-haspopup": "menu" as const,
                    "aria-expanded": menuOpen,
                    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                      setMenuOpen(true);
                      // The instant, Pult's time menu: its presets, then Custom… titled by its label.
                      void showSnoozePresets(
                        event.currentTarget,
                        () => setMenuOpen(false),
                        (until) => void actOnRow(page, action.id, until),
                        undefined,
                        action.input?.label,
                      );
                    },
                  })}
            >
              <Icon
                icon={pending === action.id ? "loading" : action.icon}
                spin={pending === action.id}
              />
              {action.text === true ? action.label : null}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * An extension's row on a thread shelf (`src/extensions/`): a poster's row (`PosterCard.tsx`) with
 * its status, giving way on hover to its actions, and its title. A click opens it
 * (`pult-shell.openExtensionRow`).
 */
export function ExtensionRow({
  page,
  environment,
  now,
}: {
  page: PageRow;
  environment: string | undefined;
  now: number;
}) {
  return (
    <PosterCard
      environmentId={page.environmentId}
      poster={rowPoster(page)}
      environment={environment}
      rowKey={extensionRowKey({ ...page, key: page.row.key })}
      title={page.row.title}
      settled={page.row.shelf === "settled"}
      slot={<Slot page={page} now={now} />}
      onOpen={() =>
        run("pult-shell.openExtensionRow", page.environmentId, page.extension, page.row.key)
      }
    />
  );
}
