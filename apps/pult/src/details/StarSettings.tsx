import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { TINTS, tintOf } from "../stars/mark.ts";
import type { Star } from "../stars/stars.ts";
import {
  setStarOrigin,
  setStarRecord,
  starRepositorySync,
  starSyncStore,
  syncStar,
} from "../stars/syncing.ts";
import { threadStore } from "../threads/store.ts";
import { DetailsShelf } from "./shelves.tsx";

function run(command: string, starId: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, starId));
}

export function StarSettings({ star }: { star: Star }) {
  return (
    <DetailsShelf name="settings" className="pult-star-settings">
      <div className="pult-settings-group">
        <StarRecordField
          label="Name"
          value={star.name}
          placeholder="Star"
          onSave={(name) => void setStarRecord(star.id, { name })}
        />
        <StarRecordField
          label="Description"
          value={star.description}
          onSave={(description) => void setStarRecord(star.id, { description })}
        />
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">Tint</div>
          </div>
          <div className="pult-settings-swatches" role="radiogroup" aria-label="Tint">
            {TINTS.map((tint) => (
              <button
                key={tint.name}
                type="button"
                role="radio"
                className="pult-settings-swatch"
                aria-checked={tint.name === tintOf(star.tint).name}
                title={tint.name[0]?.toUpperCase() + tint.name.slice(1)}
                style={{ background: `hsl(${tint.hue} 80% 60%)` }}
                onClick={() => void setStarRecord(star.id, { tint: tint.name })}
              />
            ))}
          </div>
        </div>
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">Instructions</div>
            <div className="pult-settings-row-description">
              Read at the start of every conversation.
            </div>
          </div>
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => run("pult-shell.editStarInstructions", star.id)}
          >
            Edit…
          </button>
        </div>
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">Folder</div>
            <div className="pult-settings-row-description">
              Where your Star keeps what it needs.
            </div>
          </div>
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => run("pult-shell.openStarFolder", star.id)}
          >
            Open
          </button>
        </div>
        <StarSyncRow star={star} />
      </div>
      <p className="pult-settings-footnote">
        A Git repository this Star's folder syncs with: Pult commits when it connects and each time
        all the Star's conversations there have ended, then pushes, and pulls before the Star wakes.
        Empty, it only commits.
      </p>
    </DetailsShelf>
  );
}

function StarRecordField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <div className="pult-settings-row pult-star-settings-field">
      <label className="pult-settings-row-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pult-settings-input"
        type="text"
        spellCheck
        placeholder={placeholder}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setDraft(null);
          if (!cancelled.current && draft !== null && draft.trim() !== value) onSave(draft.trim());
          cancelled.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/**
 * A Star's Sync (`src/stars/syncing.ts`): the origin of its folder's
 * repository, a Git URL or a repository's path on the environment, written
 * on Enter or leaving the field into its repository on every held home,
 * empty to stop syncing; Sync Now while it is set; a line per home of when
 * it last synced, what failed, and what waits or was handed to the Star.
 */
function StarSyncRow({ star }: { star: Star }) {
  useSyncExternalStore(starSyncStore.subscribe, starSyncStore.get);
  const origin = star.homes.find((home) => home.origin !== undefined)?.origin ?? "";
  const [typed, setTyped] = useState<string | null>(null);
  // Escape leaves the field through its blur, which this tells to write nothing, as the name's does.
  const cancelled = useRef(false);
  const commit = () => {
    setTyped(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (typed !== null && typed.trim() !== origin) void setStarOrigin(star.id, typed.trim());
  };
  const lines = star.homes.flatMap((home) => {
    const state = starRepositorySync(home.environmentId, star.id);
    const where =
      star.homes.length > 1
        ? `${threadStore.environment(home.environmentId)?.name ?? home.environmentId}: `
        : "";
    if (home.origin === undefined)
      return state?.note == null && state?.failure == null
        ? []
        : [{ text: `${where}${state.failure ?? state.note}`, error: state.failure !== null }];
    const last =
      state?.lastSync == null
        ? "Not synced yet."
        : `Last synced ${new Date(state.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    return [
      { text: `${where}${state?.busy ?? last}`, error: false },
      ...(state?.failure == null ? [] : [{ text: `${where}${state.failure}`, error: true }]),
      ...(state?.note == null ? [] : [{ text: `${where}${state.note}`, error: false }]),
    ];
  });
  const id = useId();
  return (
    <div className="pult-settings-row pult-star-settings-field">
      <div className="pult-settings-row-text">
        <label className="pult-settings-row-label" htmlFor={id}>
          Sync
        </label>
        {lines.map((line) => (
          <div
            key={line.text}
            className={line.error ? "pult-settings-row-error" : "pult-settings-row-description"}
          >
            {line.text}
          </div>
        ))}
      </div>
      <div className="pult-settings-row-actions">
        <input
          id={id}
          className="pult-settings-input pult-settings-input-origin"
          type="text"
          placeholder="git@host:you/star.git"
          spellCheck={false}
          value={typed ?? origin}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelled.current = true;
              event.currentTarget.blur();
            }
          }}
        />
        {origin === "" ? null : (
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => void syncStar(star.id)}
          >
            Sync Now
          </button>
        )}
      </div>
    </div>
  );
}
