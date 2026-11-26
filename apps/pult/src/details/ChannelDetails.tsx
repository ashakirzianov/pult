import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { onDidChangePluginFeatures, pluginFeatures } from "../stars/about.ts";
import {
  channelSettingsOf,
  followChannelSettings,
  onDidChangeChannelSettings,
  readChannelSettings,
  writeChannelSettings,
} from "../stars/channelSettings.ts";
import {
  CHANNEL_SETTINGS_FEATURE,
  type ChannelSettings,
  parseRotateOnContext,
  type RotateOnContext,
  type RouteChannel,
  rotateOnContextText,
} from "../stars/plugin.ts";
import { scheduleRows } from "../stars/schedules.ts";
import { type CardRows, drawnHome, type Star, type StarHome } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";
import { detailsCards } from "./cards.ts";
import { DetailsShelf } from "./shelves.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** An instant as the shelf says it: `09:12` today, `24 Nov 18:40` on another day. */
function clockText(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** When an awake channel sleeps, as the plugin's `sleeps` reads it, in words. */
function sleepsText(sleeps: RouteChannel["sleeps"] | undefined, now: number): string | null {
  if (sleeps === undefined) return null;
  if ("at" in sleeps) return `Sleeps around ${clockText(sleeps.at, now)}`;
  switch (sleeps.heldBy) {
    case "run":
      return "Sleeps once its run ends and its cache expires";
    case "queued":
      return "Sleeps once its queued message has run";
    case "subagent":
      return "Sleeps once the threads below it finish";
    case "request":
      return "Sleeps once you answer it";
    case "background-work":
      return "Sleeps once its background work ends";
    case "usage-limit":
      return "Held by a usage limit until it resumes or is settled";
    default:
      return `Held by ${sleeps.heldBy}`;
  }
}

const MODEL_FROM: Record<NonNullable<ChannelSettings["modelFrom"]>, string> = {
  channel: "This channel's settings",
  shared: "Every channel's settings",
  conversation: "Its last conversation's",
};

const ROTATE_FROM: Record<ChannelSettings["rotateFrom"], string> = {
  channel: "This channel's settings",
  shared: "Every channel's settings",
  default: "Pult's default",
};

/**
 * The selected channel's details (`pult/decisions`, `view-right-panel`):
 * the channel whose tab is active, the default channel on the Star's own
 * tab, left out on a file's tab, a child's showing the child's own. Its conversation, when it
 * started and when it sleeps, or since when it sleeps; where the home the
 * Star is drawn from serves `star-channel-settings`, the model a fresh
 * conversation takes and when it refreshes its context, each with the file
 * that says so, both written into the channel's own file from here, and the
 * problems the plugin finds in the files; and the schedules that land in it.
 */
export function ChannelDetails({
  star,
  rows,
  now,
}: {
  star: Star;
  rows: CardRows<ShellThread>;
  now: number;
}) {
  const subject = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.subject;
  const slug = subject?.kind === "star" ? subject.channel : null;
  const home = drawnHome(star);
  if (slug === null || home === undefined) return null;
  const thread = rows.channels.find((row) => row.slug === slug)?.thread ?? null;
  return <ChannelShelf key={slug} star={star} home={home} slug={slug} thread={thread} now={now} />;
}

function ChannelShelf({
  star,
  home,
  slug,
  thread,
  now,
}: {
  star: Star;
  home: StarHome;
  slug: string;
  thread: ShellThread | null;
  now: number;
}) {
  const { environmentId } = home;
  const served = useSyncExternalStore(
    onDidChangePluginFeatures,
    () => pluginFeatures(environmentId)?.has(CHANNEL_SETTINGS_FEATURE) === true,
  );
  // Read as the shelf mounts, and again as the channel wakes or sleeps; the watch reads it as its files change.
  useEffect(() => {
    if (!served) return;
    return followChannelSettings(environmentId, star.id, slug);
  }, [served, environmentId, star.id, slug]);
  const threadId = thread?.id ?? null;
  const seenThread = useRef(threadId);
  useEffect(() => {
    if (seenThread.current === threadId) return;
    seenThread.current = threadId;
    if (served) readChannelSettings(environmentId, star.id, slug);
  }, [threadId, served, environmentId, star.id, slug]);
  const settings = useSyncExternalStore(onDidChangeChannelSettings, () =>
    served ? channelSettingsOf(environmentId, star.id, slug) : undefined,
  );
  const sleeps = star.homes
    .flatMap((each) => each.channels)
    .find((channel) => channel.slug === slug && channel.threadId === thread?.id)?.sleeps;
  const asleepSince =
    settings?.asleepSince ?? (slug === star.defaultChannel ? home.asleepSince : null);
  const landing = home.schedules.filter((schedule) => schedule.channel === slug);
  const schedules = scheduleRows(
    landing,
    now,
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const write = (changes: Parameters<typeof writeChannelSettings>[3]) =>
    void writeChannelSettings(environmentId, star.id, slug, changes);
  return (
    <DetailsShelf
      name="channel"
      className="pult-star-settings pult-channel-details"
      status={<span className="pult-card-status">{slug}</span>}
    >
      <div className="pult-settings-group">
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">Conversation</div>
            <div className="pult-settings-row-description">
              {thread === null ? "Wakes for its next message" : sleepsText(sleeps, now)}
            </div>
          </div>
          <div className="pult-channel-value">
            {thread !== null
              ? `Since ${clockText(thread.createdAt, now)}`
              : asleepSince === null
                ? "Asleep"
                : `Asleep since ${clockText(asleepSince, now)}`}
          </div>
        </div>
        {settings === undefined ? null : (
          <>
            <div className="pult-settings-row pult-star-settings-field">
              <div className="pult-settings-row-text">
                <div className="pult-settings-row-label">Model</div>
                <div className="pult-settings-row-description">
                  {settings.modelFrom === null
                    ? "The composer's, until a conversation or a file names one"
                    : MODEL_FROM[settings.modelFrom]}
                </div>
                {thread === null ? null : (
                  <div className="pult-settings-row-description">From its next conversation</div>
                )}
              </div>
              <div className="pult-settings-row-actions pult-channel-model-actions">
                <ModelPickerSlot
                  environmentId={environmentId}
                  projectId={home.projectId}
                  selection={settings.model}
                  onPick={(model) => write({ model })}
                />
                {settings.modelFrom === "channel" ? (
                  <button
                    type="button"
                    className="pult-settings-button"
                    title="Remove this channel's model, so it takes every channel's settings"
                    onClick={() => write({ model: null })}
                  >
                    Every channel's
                  </button>
                ) : null}
              </div>
            </div>
            <RotateField
              value={rotateOnContextText(settings.rotateOnContext)}
              from={ROTATE_FROM[settings.rotateFrom]}
              onSave={(rotateOnContext) => write({ rotateOnContext })}
            />
            {settings.problems.length === 0 ? null : (
              <div className="pult-settings-row pult-channel-problems">
                {settings.problems.map((problem) => (
                  <div key={problem} className="pult-settings-row-error">
                    {problem}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {schedules.length === 0 ? null : (
          <div className="pult-settings-row pult-star-settings-field">
            <div className="pult-settings-row-label">Schedules that land here</div>
            <ul className="pult-subagents-list" aria-label="Schedules that land here">
              {schedules.map((row) => (
                <li key={row.name}>
                  <button
                    type="button"
                    className="pult-subagent"
                    title={row.hover}
                    onClick={() => run("pult-shell.openStarSchedule", star.id, row.name)}
                  >
                    <i
                      className={`codicon codicon-${row.kind === "once" ? "clockface" : "history"}`}
                      aria-hidden
                    />
                    <span className="pult-subagent-title">{row.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </DetailsShelf>
  );
}

/** The composer's model picker, which the thread view draws into this element from its own tree (`view/DetailsModelPicker.tsx`). */
function ModelPickerSlot({
  environmentId,
  projectId,
  selection,
  onPick,
}: {
  environmentId: string;
  projectId: string;
  selection: ChannelSettings["model"];
  onPick: (model: NonNullable<ChannelSettings["model"]>) => void;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const pick = useRef(onPick);
  useLayoutEffect(() => {
    pick.current = onPick;
  });
  const shown = JSON.stringify(selection);
  useEffect(() => {
    if (element === null) return;
    return detailsCards.showModelPicker({
      element,
      environmentId,
      projectId,
      selection: JSON.parse(shown) as ChannelSettings["model"],
      onPick: (model) => pick.current(model),
    });
  }, [element, environmentId, projectId, shown]);
  // The view's own element, where its stylesheet starts again inside the shell's island.
  return <div ref={setElement} className="pult-view-theme pult-channel-model" />;
}

/**
 * Refresh context's field, in the Star settings' look: `400k`, `never`, or
 * empty to remove the channel's own key, written on Enter or leaving it,
 * Escape writing nothing; what the plugin would refuse stays in the field in
 * the error colour, unwritten.
 */
function RotateField({
  value,
  from,
  onSave,
}: {
  value: string;
  from: string;
  onSave: (value: RotateOnContext | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const refused = draft !== null && parseRotateOnContext(draft) === undefined;
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null || draft.trim() === value) return setDraft(null);
    const parsed = parseRotateOnContext(draft);
    if (parsed === undefined) return;
    setDraft(null);
    onSave(parsed);
  };
  return (
    <div className="pult-settings-row pult-star-settings-field">
      <div className="pult-settings-row-text">
        <label className="pult-settings-row-label" htmlFor={id}>
          Refresh context
        </label>
        <div className="pult-settings-row-description">{from}</div>
        {refused ? (
          <div className="pult-settings-row-error">
            Thousands of tokens with a k, as 400k, or never.
          </div>
        ) : null}
      </div>
      <input
        id={id}
        className={`pult-settings-input${refused ? " pult-settings-input-refused" : ""}`}
        type="text"
        spellCheck={false}
        placeholder="250k"
        aria-invalid={refused || undefined}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
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
