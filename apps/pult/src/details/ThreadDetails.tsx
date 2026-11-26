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
import { openShelves } from "../panel/order.ts";
import { age, useMinuteClock } from "../panel/PanelView.tsx";
import { type ShellThread, threadStore } from "../threads/store.ts";
import type { DetailsCardsTarget } from "../../view/main.tsx";
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
  return {
    subject,
    thread,
    project,
    environment: state.environments.find((each) => each.id === subject.environmentId),
    severalEnvironments: state.environments.length > 1,
    asks: thread === undefined ? [] : threadRows(rows, thread.environmentId, thread.id),
    /** The Changes shelf's checkout: a started thread's, while it is a repository. */
    changes: thread !== undefined && root !== null && repository ? { thread, root, summary } : null,
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
    case "servers":
    case "subagents":
    case "schedules":
      return { holds: false, count: 0 };
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
 * (`ThreadPlace`), and its checkout's changes (`ThreadChanges`). A draft's is
 * its Folder alone.
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
