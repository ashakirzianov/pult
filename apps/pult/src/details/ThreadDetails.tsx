import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import {
  checkoutSummary,
  type CheckoutSummary,
  runCheckoutButton,
  subscribeCheckoutSummaries,
} from "../changes/view.ts";
import { isNoRepository, subscribeRepositories } from "../changes/repositories.ts";
import { extensionRows } from "../extensions/index.ts";
import type { PageRow } from "../extensions/ui.ts";
import { keyOf, openShelves } from "../panel/order.ts";
import {
  type Activity,
  age,
  Elapsed,
  Status,
  subagentsByRoot,
  threadActivities,
  useMinuteClock,
} from "../panel/PanelView.tsx";
import { instantText } from "../stars/schedules.ts";
import { scopedKey, type ShellThread, threadStore } from "../threads/store.ts";
import type { DetailsCardsTarget, DetailsViewRows } from "../../view/main.tsx";
import { detailsCards } from "./cards.ts";
import { type DetailsRow, DetailsRows, IconLabel } from "./rows.tsx";
import { DetailsShelf, type DetailsShelfName, detailsShelves, THREAD_SHELVES } from "./shelves.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** What a thread's details are of: a thread, or a project's draft. */
export type ThreadSubject = DetailsCardsTarget;

/** The rows on Inbox the thread posted (`{ thread }` posters), its asks among them. */
function threadRows(rows: ReadonlyArray<PageRow>, environmentId: string, threadId: string) {
  return rows.filter(
    (page) =>
      page.environmentId === environmentId &&
      page.row.shelf === "inbox" &&
      "thread" in page.row.poster &&
      page.row.poster.thread === threadId,
  );
}

/** What a thread's shelves draw from, read live; also the tray's counts (`DetailsTray.tsx`). */
export function useThreadDetails(subject: ThreadSubject) {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const rows = useSyncExternalStore(extensionRows.subscribe, extensionRows.get);
  const thread =
    subject.kind === "thread"
      ? state.threads.find(
          (candidate) =>
            candidate.environmentId === subject.environmentId && candidate.id === subject.threadId,
        )
      : undefined;
  const root = thread?.checkoutRoot ?? null;
  // The bar's Source Control button's test: a checkout unread, or whose last read failed, counts as one.
  const repository = useSyncExternalStore(
    subscribeRepositories,
    () => root !== null && !isNoRepository(subject.environmentId, root),
  );
  const summary = useSyncExternalStore(subscribeCheckoutSummaries, () =>
    root === null ? undefined : checkoutSummary(subject.environmentId, root),
  );
  const project =
    subject.kind === "draft"
      ? threadStore.project(subject.environmentId, subject.projectId)
      : undefined;
  const handed = useSyncExternalStore(detailsCards.subscribeViewRows, detailsCards.viewRows);
  // The view's rows of this thread alone: another's are a moment stale.
  const view =
    thread !== undefined &&
    handed?.environmentId === thread.environmentId &&
    handed.threadId === thread.id
      ? handed
      : null;
  const activities = threadActivities(state.threads);
  const lineage =
    thread === undefined
      ? []
      : (subagentsByRoot(state.threads, activities).get(
          scopedKey(thread.environmentId, thread.rootId),
        ) ?? []);
  return {
    subject,
    thread,
    project,
    environment: state.environments.find((each) => each.id === subject.environmentId),
    severalEnvironments: state.environments.length > 1,
    asks: thread === undefined ? [] : threadRows(rows, thread.environmentId, thread.id),
    /** The Changes shelf's checkout: a started thread's, while it is a repository. */
    changes: thread !== undefined && root !== null && repository ? { thread, root, summary } : null,
    view,
    /** The subagents of its lineage, as its root's card listed them, active first. */
    lineage,
    activities,
  };
}

export type ThreadDetailsState = ReturnType<typeof useThreadDetails>;

/** Whether a thread's shelf holds anything, which leaves it out while it does not, and its count on the tray. */
export function threadShelf(
  details: ThreadDetailsState,
  name: DetailsShelfName,
): { readonly holds: boolean; readonly count: number } {
  switch (name) {
    case "asks":
      return { holds: details.asks.length > 0, count: details.asks.length };
    case "thread":
      return { holds: details.thread !== undefined || details.project !== undefined, count: 0 };
    case "changes":
      return { holds: details.changes !== null, count: 0 };
    case "actions":
      return { holds: (details.view?.actions.length ?? 0) > 0, count: 0 };
    case "servers":
      return {
        holds: (details.view?.servers.length ?? 0) > 0,
        count: details.view?.servers.length ?? 0,
      };
    case "subagents":
      return {
        holds: details.lineage.length > 0,
        count: details.lineage.filter(
          (subagent) => details.activities.get(keyOf(subagent)) === "working",
        ).length,
      };
    case "schedules": {
      const schedules = details.view?.schedules ?? [];
      return {
        holds: schedules.length > 0,
        count: schedules.filter((schedule) => schedule.once).length,
      };
    }
    case "channels":
    case "channel":
    case "settings":
      return { holds: false, count: 0 };
  }
}

/**
 * A thread's or a draft's details (`pult/decisions`, `view-right-panel`):
 * the thread's shelves of the panel's one order (`detailsShelves`), each
 * closing into the tray and left out while it holds nothing (`threadShelf`):
 * the rows it posted on Inbox (`ThreadAsks`), its folder and environment
 * (`ThreadPlace`), its checkout's changes (`ThreadChanges`), its project's
 * scripts (`ThreadActions`), its local servers (`ThreadServers`), its
 * lineage's subagents (`ThreadSubagents`) and its scheduled tasks
 * (`ThreadSchedules`), the last but one read from the store, the others
 * from its view (`DetailsViewRows`). A draft's is its Folder alone.
 */
export function ThreadDetails({ subject }: { subject: ThreadSubject }) {
  const order = useSyncExternalStore(
    detailsShelves.shelfOrder.subscribe,
    detailsShelves.shelfOrder.get,
  );
  const dragging =
    useSyncExternalStore(detailsShelves.shelfDrag.subscribe, detailsShelves.shelfDrag.get) !== null;
  const details = useThreadDetails(subject);
  const now = useMinuteClock();
  const shelf = (name: DetailsShelfName): React.ReactNode => {
    if (!THREAD_SHELVES.includes(name) || !threadShelf(details, name).holds) return null;
    switch (name) {
      case "asks":
        return <ThreadAsks key={name} asks={details.asks} now={now} />;
      case "thread":
        return <ThreadPlace key={name} details={details} />;
      case "changes":
        return details.changes === null ? null : <ThreadChanges key={name} {...details.changes} />;
      case "actions":
        return details.view === null ? null : <ThreadActions key={name} view={details.view} />;
      case "servers":
        return details.view === null ? null : <ThreadServers key={name} view={details.view} />;
      case "subagents":
        return details.thread === undefined ? null : (
          <ThreadSubagents
            key={name}
            thread={details.thread}
            lineage={details.lineage}
            activities={details.activities}
            stops={details.view?.stops ?? []}
            now={now}
          />
        );
      case "schedules":
        return details.view === null ? null : (
          <ThreadSchedules key={name} view={details.view} now={now} />
        );
      default:
        return null;
    }
  };
  return (
    <ul
      className={`pult-details-shelves${dragging ? " pult-shelf-dragging" : ""}`}
      {...detailsShelves.shelfDropHandlers("open")}
    >
      {[
        ...openShelves(order, "top").map(shelf),
        <li key="gap" className="pult-shelf-gap" aria-hidden />,
        ...openShelves(order, "bottom").map(shelf),
      ]}
      <detailsShelves.ShelfDropLine place="open" />
    </ul>
  );
}

/** The thread's rows on Inbox, a Star's asks' look: its title and age, opening it as its Inbox row does. */
function ThreadAsks({ asks, now }: { asks: ReadonlyArray<PageRow>; now: number }) {
  return (
    <DetailsShelf name="asks">
      <DetailsRows
        label="Asks"
        rows={asks.map(({ environmentId, extension, row }) => ({
          key: JSON.stringify([environmentId, extension, row.key]),
          icon: "comment-unresolved",
          label: row.title,
          title: row.title,
          value: row.status.time === undefined ? undefined : age(row.status.time.at, now),
          open: () => run("pult-shell.openExtensionRow", environmentId, extension, row.key),
        }))}
      />
    </DetailsShelf>
  );
}

/**
 * Where the thread works: Folder, its project's name over the path, its
 * worktree else its project's root, a click opening the Explorer narrowed to
 * it, and its Environment while several are held. A draft's Folder alone,
 * its project's root.
 */
function ThreadPlace({ details }: { details: ThreadDetailsState }) {
  const { thread, project, environment } = details;
  const name = thread?.projectName ?? project?.name ?? "";
  const path = thread === undefined ? (project?.root ?? null) : thread.checkoutRoot;
  const rows: DetailsRow[] = [
    {
      key: "folder",
      icon: "folder",
      label: name,
      description: path ?? "No project folder",
      ...(path === null
        ? {}
        : {
            title: path,
            open: () => run("pult-shell.openThreadExplorer"),
          }),
    },
  ];
  if (thread !== undefined && details.severalEnvironments && environment !== undefined)
    rows.push({
      key: "environment",
      icon: "vm",
      label: environment.label,
      ...(environment.name === environment.label ? {} : { description: environment.name }),
    });
  return (
    <DetailsShelf name="thread">
      <DetailsRows label="Thread" rows={rows} />
    </DetailsShelf>
  );
}

/** A checkout's changes in words: `3 files · +12 −3`, or `No changes`. */
function changesLine(summary: CheckoutSummary): string {
  if (summary.files === 0) return "No changes";
  return `${summary.files} ${summary.files === 1 ? "file" : "files"} · +${summary.additions} −${summary.deletions}`;
}

/**
 * The thread's checkout, while it is a repository: its header opening the
 * changes view narrowed to the thread (`pult-shell.showChanges`), its Branch
 * as a word, its Changes, a click opening that view too, and the one button
 * Source Control shows for the checkout (`checkoutSummary`), its message the
 * server's.
 */
function ThreadChanges({
  thread,
  root,
  summary,
}: {
  thread: ShellThread;
  root: string;
  summary: CheckoutSummary | undefined;
}) {
  const show = () => run("pult-shell.showChanges", thread.environmentId, thread.id, null);
  const branch = summary?.branch ?? thread.branch;
  const rows: DetailsRow[] = [
    {
      key: "branch",
      icon: "git-branch",
      label: branch ?? "Detached HEAD",
      ...(branch === null ? {} : { title: branch }),
    },
    ...(summary === undefined
      ? []
      : [{ key: "changes", icon: "diff", label: changesLine(summary), open: show }]),
  ];
  return (
    <DetailsShelf name="changes" onOpen={show} openTitle="Show the thread's changes">
      <DetailsRows label="Changes" rows={rows} />
      {summary === undefined ? null : (
        <div className="pult-details-button-row">
          <button
            type="button"
            className="pult-settings-button pult-details-button"
            title={summary.button.tooltip}
            disabled={!summary.button.enabled}
            onClick={() => void runCheckoutButton(thread.environmentId, root)}
          >
            <IconLabel text={summary.button.title} />
          </button>
        </div>
      )}
    </DetailsShelf>
  );
}

/** Upstream's script icons as codicons. */
const SCRIPT_ICONS: Record<string, string> = {
  play: "play",
  test: "beaker",
  lint: "checklist",
  configure: "settings-gear",
  build: "tools",
  debug: "debug-alt",
};

/**
 * The project's scripts, a click running one in the thread's terminal drawer
 * as upstream's row does; beside a file, the thread's tab shown with its
 * drawer open, as Toggle Terminal does. A script the project's `t3.json`
 * defines and the project lacks has Add, which adds it as upstream imports it.
 */
function ThreadActions({ view }: { view: DetailsViewRows }) {
  const inFile = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.file === true;
  return (
    <DetailsShelf name="actions">
      <DetailsRows
        label="Actions"
        rows={view.actions.map(({ key, name, icon, run: start, add }) => ({
          key,
          icon: SCRIPT_ICONS[icon] ?? "play",
          label: name,
          title: name,
          ...(start === undefined
            ? {}
            : {
                open: () => {
                  start();
                  if (inFile) run("pult-shell.toggleTerminal");
                },
              }),
          ...(add === undefined
            ? {}
            : { actions: [{ label: "Add", title: `Add ${name} from t3.json`, run: add }] }),
        }))}
      />
    </DetailsShelf>
  );
}

/** The local servers the thread's agent or terminals started: its address and who started it, a click opening it in a preview tab, with Stop. */
function ThreadServers({ view }: { view: DetailsViewRows }) {
  return (
    <DetailsShelf name="servers">
      <DetailsRows
        label="Servers"
        rows={view.servers.map(({ key, address, startedBy, open, stop }) => ({
          key,
          icon: "globe",
          label: address,
          value: startedBy,
          ...(open === undefined ? {} : { open, title: `Open ${address} in a preview tab` }),
          ...(stop === undefined ? {} : { actions: [{ label: "Stop", run: stop }] }),
        }))}
      />
    </DetailsShelf>
  );
}

/**
 * The thread's lineage, as its root's card listed it: each subagent's title
 * and status, Working with its elapsed time, a click selecting its thread,
 * the selected one highlighted, with upstream's Stop where its lineage panel
 * offers it (`stops`, from the view).
 */
function ThreadSubagents({
  thread,
  lineage,
  activities,
  stops,
  now,
}: {
  thread: ShellThread;
  lineage: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  stops: DetailsViewRows["stops"];
  now: number;
}) {
  return (
    <DetailsShelf name="subagents">
      <DetailsRows
        label="Subagents"
        rows={lineage.map((subagent) => {
          const activity = activities.get(keyOf(subagent)) ?? null;
          const stop = stops.find((each) => each.threadId === subagent.id)?.stop;
          return {
            key: keyOf(subagent),
            icon: "hubot",
            label: subagent.title,
            title: subagent.title,
            selected: keyOf(subagent) === keyOf(thread),
            value:
              activity === "working" && subagent.workingSince !== null ? (
                <span className="pult-card-status-working">
                  <Elapsed since={subagent.workingSince} />
                </span>
              ) : (
                <Status thread={subagent} activity={activity} now={now} />
              ),
            open: () => run("pult-shell.selectThread", subagent.environmentId, subagent.id),
            ...(stop === undefined ? {} : { actions: [{ label: "Stop", run: stop }] }),
          };
        })}
      />
    </DetailsShelf>
  );
}

/**
 * The thread's scheduled tasks, a Star's Schedules' name and icons: each
 * its title over its rule in upstream's words, and its next run, in the
 * page's zone as a Star's are (`instantText`), else paused or why it cannot
 * run; with Run now, and Pause or Resume.
 */
function ThreadSchedules({ view, now }: { view: DetailsViewRows; now: number }) {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <DetailsShelf name="schedules">
      <DetailsRows
        label="Schedules"
        rows={view.schedules.map((task) => ({
          key: task.key,
          icon: task.once ? "clockface" : "history",
          label: task.title,
          description: task.rule,
          title: task.title,
          value:
            task.blocked ??
            (!task.enabled
              ? "paused"
              : task.nextRunAt === null
                ? undefined
                : instantText(task.nextRunAt, now, zone)),
          actions: [
            ...(task.runNow === undefined ? [] : [{ label: "Run now", run: task.runNow }]),
            ...(task.setEnabled === undefined
              ? []
              : [
                  {
                    label: task.enabled ? "Pause" : "Resume",
                    run: () => task.setEnabled?.(!task.enabled),
                  },
                ]),
          ],
        }))}
      />
    </DetailsShelf>
  );
}
