import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useRef, useState, useSyncExternalStore } from "react";

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
import { DetailsRows } from "./rows.tsx";
import { DetailsShelf } from "./shelves.tsx";

function run(command: string, starId: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, starId));
}

/**
 * A Star's settings, in the panel's rows (`rows.tsx`): its Name and
 * Description, each a field written on Enter or leaving it; its Tint; its
 * Instructions and Folder, each opened by its action; and its Sync.
 */
export function StarSettings({ star }: { star: Star }) {
  useSyncExternalStore(starSyncStore.subscribe, starSyncStore.get);
  const origin = star.homes.find((home) => home.origin !== undefined)?.origin ?? "";
  return (
    <DetailsShelf name="settings" className="pult-star-settings">
      <DetailsRows
        label="Star Settings"
        rows={[
          {
            key: "name",
            icon: "tag",
            label: "Name",
            field: (
              <StarRecordInput
                label="Name"
                value={star.name}
                placeholder="Star"
                onSave={(name) => void setStarRecord(star.id, { name })}
              />
            ),
          },
          {
            key: "description",
            icon: "note",
            label: "Description",
            field: (
              <StarRecordInput
                label="Description"
                value={star.description}
                onSave={(description) => void setStarRecord(star.id, { description })}
              />
            ),
          },
          {
            key: "tint",
            icon: "symbol-color",
            label: "Tint",
            field: (
              <span className="pult-settings-swatches" role="radiogroup" aria-label="Tint">
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
              </span>
            ),
          },
          {
            key: "instructions",
            icon: "book",
            label: "Instructions",
            description: "Read at the start of every conversation.",
            actions: [
              { label: "Edit…", run: () => run("pult-shell.editStarInstructions", star.id) },
            ],
          },
          {
            key: "folder",
            icon: "folder",
            label: "Folder",
            description: "Where your Star keeps what it needs.",
            actions: [{ label: "Open", run: () => run("pult-shell.openStarFolder", star.id) }],
          },
          {
            key: "sync",
            icon: "sync",
            label: "Sync",
            actions:
              origin === "" ? [] : [{ label: "Sync Now", run: () => void syncStar(star.id) }],
            field: (
              <>
                {syncLines(star).map((line) => (
                  <span
                    key={line.text}
                    className={
                      line.error ? "pult-details-row-error" : "pult-details-row-description"
                    }
                  >
                    {line.text}
                  </span>
                ))}
                <StarOriginInput star={star} origin={origin} />
                <span className="pult-details-row-description">
                  A Git repository this Star's folder syncs with: Pult commits when it connects and
                  each time all the Star's conversations there have ended, then pushes, and pulls
                  before the Star wakes. Empty, it only commits.
                </span>
              </>
            ),
          },
        ]}
      />
    </DetailsShelf>
  );
}

/** A field of the Star's record, written trimmed on Enter or leaving it, Escape writing nothing. */
function StarRecordInput({
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
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <input
      className="pult-settings-input"
      type="text"
      aria-label={label}
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
  );
}

/**
 * A Star's Sync (`src/stars/syncing.ts`), a line per home of when it last
 * synced, what failed, and what waits or was handed to the Star.
 */
function syncLines(star: Star): ReadonlyArray<{ readonly text: string; readonly error: boolean }> {
  return star.homes.flatMap((home) => {
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
}

/**
 * The origin of a Star's folder's repository, a Git URL or a repository's
 * path on the environment, written on Enter or leaving the field into its
 * repository on every held home, empty to stop syncing.
 */
function StarOriginInput({ star, origin }: { star: Star; origin: string }) {
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
  return (
    <input
      className="pult-settings-input pult-settings-input-origin"
      type="text"
      aria-label="Sync"
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
  );
}
