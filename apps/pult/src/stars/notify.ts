// What is asked of the user, told outside the page (xaxis
// `pult/issues/notify-outside-the-page.md`; `pult/decisions`,
// `notifications`): the dock badge, the posted asks the panel shows whoever
// posted them, and a desktop notification for a new one and when a Star
// starts waiting on the user. A thread notifies nothing else; upstream's
// `startThreadNotifications` is not started. The logic is `notices.ts`.
import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { posterName, shownAsks } from "../asks/asks.ts";
import { askStore, asksAnsweredOn } from "../asks/model.ts";
import { connection } from "../connection/index.ts";
import { desktopHost } from "../desktop/host.ts";
import { threadStore } from "../threads/store.ts";
import { starById, starsAnsweredOn, starStore } from "./model.ts";
import {
  NOTHING_SEEN,
  type Notice,
  type NoticeAsks,
  type NoticeStar,
  notices,
  waitingThread,
} from "./notices.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { starName } from "./stars.ts";

let seen = NOTHING_SEEN;
let badge: number | undefined;
let scheduled = false;
/** The notifications shown and not yet gone, by tag. */
const shown = new Map<string, Notification>();

const ready = (environmentId: string) => connection.environment(environmentId)?.phase === "ready";

/** The panel's Stars as the notices read them, each channel's thread from the store's live rows. */
function noticeStars(): NoticeStar[] {
  if (!starSettingKnown() || !starEnabled.get()) return [];
  const { threads, environments } = threadStore.get();
  const current = (environmentId: string) => ready(environmentId) && starsAnsweredOn(environmentId);
  const loaded = (environmentId: string) =>
    environments.some((environment) => environment.id === environmentId && environment.loaded);
  return starStore.get().map((star) => {
    // A home on an environment not ready shows no channel and tells nothing; one connecting waits for its threads and answer.
    const known = star.homes.every(
      (home) =>
        !ready(home.environmentId) || (current(home.environmentId) && loaded(home.environmentId)),
    );
    return {
      id: star.id,
      name: starName(star),
      waitingOn: known ? waitingThread(star, threads) : undefined,
    };
  });
}

/** Each held environment's posted asks the panel shows, a Star's only while Show Star is on, each with its poster's name as its row has it. */
function noticeAsks(): NoticeAsks[] {
  if (!starSettingKnown()) return [];
  const { threads } = threadStore.get();
  const asks = shownAsks(askStore.get(), starEnabled.get());
  return connection.environments.map(({ environmentId }) => ({
    environmentId,
    current: ready(environmentId) && asksAnsweredOn(environmentId),
    posted: asks.flatMap((ask) =>
      ask.environmentId === environmentId && ask.status === "posted"
        ? [
            {
              id: ask.id,
              title: ask.title,
              poster: posterName(
                ask,
                (starId) => {
                  const star = starById(starId);
                  return star === undefined ? undefined : starName(star);
                },
                (threadEnvironment, threadId) =>
                  threads.find(
                    (thread) =>
                      thread.environmentId === threadEnvironment && thread.id === threadId,
                  )?.title,
              ),
            },
          ]
        : [],
    ),
  }));
}

/** Sends the badge, shows what is new while the page is hidden or lacks focus, and closes what has gone. */
function update(): void {
  scheduled = false;
  const next = notices(noticeStars(), noticeAsks(), seen);
  seen = next.seen;
  if (next.badge !== badge) sendBadge(next.badge);
  for (const [tag, notification] of shown) {
    if (next.live.has(tag)) continue;
    notification.close();
    shown.delete(tag);
  }
  // A page loaded while its window is hidden reads as focused until it is next shown.
  const away = document.visibilityState === "hidden" || !document.hasFocus();
  if (away) for (const notice of next.show) show(notice);
}

/** Once per task, after the Stars' model has taken in the store's change. */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(update);
}

/** The count to Pult.app's dock, through upstream's bridge, which shows 0 while a window has focus and clears it on focus. */
function sendBadge(count: number): void {
  badge = count;
  void desktopHost()?.setNotificationBadge({ count, image: null });
}

/** A DOM notification, with the system's sound; where nothing granted the permission (outside Pult.app), none. */
function show(notice: Notice): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  shown.get(notice.tag)?.close();
  const notification = new Notification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    silent: false,
  });
  shown.set(notice.tag, notification);
  notification.addEventListener("close", () => {
    if (shown.get(notice.tag) === notification) shown.delete(notice.tag);
  });
  notification.addEventListener("click", () => {
    notification.close();
    void open(notice);
  });
}

/** The window revealed, then the ask opened or the Star selected. */
async function open(notice: Notice): Promise<void> {
  const host = desktopHost();
  if (host === undefined) window.focus();
  else await host.revealWindow();
  const commands = await getService(ICommandService);
  if (notice.kind === "ask")
    await commands.executeCommand("pult-shell.openAsk", notice.environmentId, notice.ask);
  else await commands.executeCommand("pult-shell.selectStar", notice.starId);
}

/** Starts the notices, after `startStars()` and `startAsks()`: on the Stars, the asks, the threads, Show Star and the connection. */
export function startStarNotices(): void {
  starStore.subscribe(schedule);
  askStore.subscribe(schedule);
  threadStore.subscribe(schedule);
  starEnabled.subscribe(schedule);
  connection.onDidChange(schedule);
  // The bridge clears the badge whenever a window takes focus; leaving it, the count comes back.
  window.addEventListener("blur", () => {
    if (badge !== undefined) sendBadge(badge);
  });
  schedule();
}
