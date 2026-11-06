// How the Stars' repository syncs through its origin, apart from the
// workbench so `node --test src/stars/sync.test.ts` can run it: which
// origins the page takes, where it reads the repository's, what each
// occasion runs, the commits' messages, and the handoff that gives a Star a
// divergence to reconcile (`syncing.ts` runs it).

/** Why the page will not take `url` as an origin, or undefined when it will. */
export function originProblem(url: string): string | undefined {
  const origin = url.trim();
  if (origin === "") return "Give an origin: a Git URL, or a repository's path on the environment.";
  if (/\s/.test(origin)) return "An origin is one URL or path, without spaces.";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(origin)?.[1]?.toLowerCase();
  // Git takes a path as it is, with no shell to expand `~` and no folder of the user's to resolve it against.
  if (scheme === undefined && !/^[^/\\:]+:/.test(origin) && !origin.startsWith("/"))
    return "Give a repository's path in full, from /, or a Git URL.";
  return undefined;
}

/**
 * The URL of `origin` in a repository's `.git/config`, the one place the
 * Stars' origin is kept; undefined where it has none.
 */
export function originOf(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line)?.[1];
    if (section !== undefined) {
      inOrigin = /^remote\s+"origin"$/.test(section.trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.*?)\s*$/.exec(line)?.[1] : undefined;
    if (url !== undefined && url !== "") return url.replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

/** The Stars' repository as the server's status reads it, after its origin was fetched. */
export interface HomeStatus {
  /** Whether the folder is a repository's root, not a folder inside another one. */
  readonly ownRepository: boolean;
  readonly branch: string | null;
  /** The commit HEAD is at, null before the first one. */
  readonly head: string | null;
  readonly hasUpstream: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The uncommitted files, relative to the folder. */
  readonly uncommitted: ReadonlyArray<string>;
}

/**
 * What an occasion runs on the repository, by the ahead and behind counts
 * alone. A full occasion (after a conversation's transcript, on connect, on
 * Sync Star, or a change of a record, `writes`) commits what the repository
 * holds uncommitted, origin or none. With an origin (`remote`): a branch
 * both ahead and behind has diverged, which runs nothing and goes to a
 * Star; otherwise a branch with an upstream the origin has (`published`,
 * which a new origin may not be) pulls, a fast-forward the server's pull
 * is, every time; and a full occasion then pushes, which publishes a branch
 * the origin lacks.
 */
export type SyncPlan =
  | { readonly kind: "diverged" }
  | {
      readonly kind: "run";
      readonly pull: boolean;
      readonly commit: boolean;
      readonly push: boolean;
    };

export function syncPlan(
  status: HomeStatus,
  occasion: "pull" | "full",
  {
    writes = false,
    published = true,
    remote = true,
  }: { readonly writes?: boolean; readonly published?: boolean; readonly remote?: boolean },
): SyncPlan {
  const tracked = remote && status.hasUpstream && published;
  if (tracked && status.ahead > 0 && status.behind > 0) return { kind: "diverged" };
  const full = occasion === "full";
  const commit = full && (writes || status.uncommitted.length > 0);
  return {
    kind: "run",
    pull: tracked,
    commit,
    push: remote && full && status.branch !== null && (!tracked || commit || status.ahead > 0),
  };
}

/**
 * Whether a failed pull or push was git refusing it, which goes to the Star:
 * a pull that cannot fast-forward or would overwrite the folder's changes,
 * or a push the origin rejects for history the folder lacks. The server
 * names these reasons; any other failure, a lock or the origin out of reach,
 * is told and tried again.
 */
export function refusedByGit(message: string): boolean {
  return /\((?:pull_not_fast_forward|pull_would_overwrite_changes|push_rejected_non_fast_forward)\)/.test(
    message,
  );
}

const day = (iso: string) =>
  Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toISOString().slice(0, 10);

/** The commits' messages, deterministic. */
export const commitMessages = {
  conversation: (title: string, endedAt: string) =>
    `Star: ${title.trim() === "" ? "conversation" : title.trim()}, ${day(endedAt)}`,
  sync: (environmentName: string) => `Star: sync from ${environmentName}`,
  settings: () => "Star: settings",
};

/**
 * The first message of the conversation a divergence wakes a Star with,
 * built deterministically: what diverged, the files uncommitted, and the
 * ask to reconcile the Stars' repository with git and push, which Pult does
 * not do itself.
 */
export function handoffMessage(input: {
  readonly environmentName: string;
  readonly repository: string;
  readonly branch: string;
  readonly uncommitted: ReadonlyArray<string>;
}): string {
  const upstream = `origin/${input.branch}`;
  return [
    `Pult could not sync the Stars' repository, \`${input.repository}\` on ${input.environmentName}, with its origin, and hands it to you to reconcile: \`${input.branch}\` and \`${upstream}\` have diverged, or git refused to bring \`${upstream}\` in over the changes here. \`git fetch origin\`, then \`git status\` and \`git log --stat HEAD...${upstream}\` show what differs.`,
    input.uncommitted.length === 0
      ? ""
      : `Files changed here and not committed:\n${input.uncommitted.map((file) => `- \`${file}\``).join("\n")}`,
    `Reconcile it with git, keeping what both sides know (the transcripts do not conflict, since each environment writes its own folder of them), commit, and push to \`${upstream}\`. Pult does not resolve it itself; it syncs again when you next fall asleep.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The title of the conversation a handoff wakes, which the server keeps until the Star's first reply retitles it. */
export const HANDOFF_TITLE = "Reconcile the Stars' repository";

/**
 * The handoff's thread id, deterministic from the repository, the commit its
 * branch is at and how far behind the origin it is, so a divergence is
 * handed to the Star once, whichever page sees it and however often, and
 * again only when either side moves: Pult commits nothing on a diverged
 * home, and the origin's new commits raise the count.
 */
export async function handoffThreadId(input: {
  readonly environmentId: string;
  /** The repository's root, `~/.pult/stars`. */
  readonly root: string;
  readonly branch: string;
  readonly head: string | null;
  readonly behind: number;
}): Promise<string> {
  const key = [
    "pult-star-handoff",
    input.environmentId,
    input.root,
    input.branch,
    input.head ?? "",
    String(input.behind),
  ].join("\n");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  // A UUID's shape, version 5's bits, as the server's ids are UUIDs.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
