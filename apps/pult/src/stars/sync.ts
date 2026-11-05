// How a Star's folder syncs through its origin, apart from the workbench so
// `node --test src/stars/sync.test.ts` can run it: which origins the page
// takes, what each occasion runs, the commits' messages, and the handoff
// that gives the Star a divergence to reconcile (`syncing.ts` runs it).

/** Why the page will not take `url` as an origin, or undefined when it will. */
export function originProblem(url: string): string | undefined {
  const origin = url.trim();
  if (origin === "") return "Give an origin: a Git URL, or a repository's path on the environment.";
  if (/\s/.test(origin)) return "An origin is one URL or path, without spaces.";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(origin)?.[1]?.toLowerCase();
  // Git takes a path as it is, with no shell to expand `~` and no folder of the user's to resolve it against.
  if (scheme === undefined && !/^[^/\\:]+:/.test(origin) && !origin.startsWith("/"))
    return "Give a repository's path in full, from /, or a Git URL.";
  // The origin is kept in AGENTS.md, which the origin itself then holds: no secret goes in it.
  const userinfo = scheme === undefined ? undefined : /^[^:]+:\/\/([^/@]*)@/.exec(origin)?.[1];
  if (userinfo !== undefined && (scheme === "http" || scheme === "https" || userinfo.includes(":")))
    return "Pult keeps the origin in your Star's AGENTS.md, which it pushes, so it takes no token or password in the URL: use an SSH URL, or a credential helper.";
  return undefined;
}

/** Whether two spellings name one origin: as written, but for trailing slashes and a `.git` suffix. */
function sameOrigin(left: string, right: string): boolean {
  const plain = (url: string) =>
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
  return plain(left) === plain(right);
}

/** A remote's URL in a repository's `.git/config`, null where it has none. */
export function remoteUrl(config: string, remote = "origin"): string | null {
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\s\]]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section !== null) {
      inRemote = section[1]?.toLowerCase() === "remote" && section[2] === remote;
      continue;
    }
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (inRemote && entry !== null) return (entry[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
  }
  return null;
}

/** A ref's commit in a repository's `.git`, from its loose file or else its `packed-refs`; null where neither has it. */
export function refCommit(
  loose: string | undefined,
  packed: string | undefined,
  ref: string,
): string | null {
  const fromLoose = loose?.trim();
  if (fromLoose !== undefined && /^[0-9a-f]{40,64}$/.test(fromLoose)) return fromLoose;
  for (const line of (packed ?? "").split(/\r?\n/)) {
    const [commit, name] = line.trim().split(" ");
    if (name === ref && commit !== undefined && /^[0-9a-f]{40,64}$/.test(commit)) return commit;
  }
  return null;
}

/** A home's repository as the server's status reads it, its upstream fetched first. */
export interface HomeStatus {
  /** Whether the folder is a repository's root, not a folder inside another one. */
  readonly ownRepository: boolean;
  /** Its `origin` remote's URL, null without one. */
  readonly remote: string | null;
  readonly branch: string | null;
  readonly hasUpstream: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The uncommitted files, relative to the folder. */
  readonly uncommitted: ReadonlyArray<string>;
}

/**
 * What an occasion runs on a home whose record names `origin`. A folder that
 * is no repository of its own, or whose `origin` is another, is connected
 * first. A branch both ahead and behind has diverged, which runs nothing and
 * goes to the Star. Otherwise a branch with an upstream pulls, a fast-forward
 * the server's pull is, every time, since the counts may be a fetch old; and
 * a full occasion, after a conversation's transcript, on connect and on Sync
 * Star, then commits what the folder holds uncommitted and pushes, which
 * publishes a branch without an upstream.
 */
export type SyncPlan =
  | { readonly kind: "connect" }
  | { readonly kind: "diverged" }
  | {
      readonly kind: "run";
      readonly pull: boolean;
      readonly commit: boolean;
      readonly push: boolean;
    };

export function syncPlan(status: HomeStatus, origin: string, occasion: "pull" | "full"): SyncPlan {
  if (!status.ownRepository || status.remote === null || !sameOrigin(status.remote, origin))
    return { kind: "connect" };
  if (status.hasUpstream && status.ahead > 0 && status.behind > 0) return { kind: "diverged" };
  const full = occasion === "full";
  const commit = full && status.uncommitted.length > 0;
  return {
    kind: "run",
    pull: status.hasUpstream,
    commit,
    push: full && status.branch !== null && (!status.hasUpstream || commit || status.ahead > 0),
  };
}

/**
 * Whether a failed pull or push was git refusing it (local changes a pull
 * would overwrite, a branch it cannot fast-forward, a push the origin
 * rejects), which goes to the Star, rather than a failure to reach the
 * origin, which is told and tried again. The server keeps git's output out
 * of its errors, naming a fixed reason, so a failure naming no trouble
 * reaching the origin is a refusal.
 */
export function refusedByGit(message: string): boolean {
  return !/remote_unreachable|authentication_failed|host_key_unverified|could not read from remote|unable to access|timed out|timeout|not ready|disconnect/i.test(
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
  stop: () => "Star: stop syncing",
};

/** What the handoff says diverged. */
export type Divergence =
  | {
      /** The branch and its upstream both have commits the other lacks. */
      readonly kind: "diverged";
      readonly branch: string;
      readonly ahead: number;
      readonly behind: number;
      readonly uncommitted: ReadonlyArray<string>;
    }
  | {
      /** Git refused a pull from the upstream, its message the server's. */
      readonly kind: "refused";
      readonly branch: string;
      readonly message: string;
      readonly uncommitted: ReadonlyArray<string>;
    }
  | {
      /** The origin rejected the branch's first push: it holds history the folder does not share. */
      readonly kind: "unrelated";
      readonly branch: string;
      readonly message: string;
    };

const commits = (count: number) => (count === 1 ? "1 commit" : `${count} commits`);
const list = (files: ReadonlyArray<string>) => files.map((file) => `- \`${file}\``).join("\n");
// The server names its operation and the folder before git's reason; the Star knows its folder.
const reason = (message: string) =>
  message.trim().replace(/^Git command failed in \S+ \([^)]*\): /, "");

/**
 * The first message of the conversation a divergence wakes the Star with,
 * built deterministically from what the server's status tells: what
 * diverged, the files involved, and the ask to reconcile it in its folder
 * with git and push, which Pult does not do itself.
 */
export function handoffMessage(input: {
  readonly environmentName: string;
  readonly folder: string;
  readonly divergence: Divergence;
}): string {
  const { divergence } = input;
  const upstream = `origin/${divergence.branch}`;
  const where = `your folder, \`${input.folder}\` on ${input.environmentName}`;
  const what = (() => {
    switch (divergence.kind) {
      case "diverged":
        return `The branch \`${divergence.branch}\` of ${where}, and \`${upstream}\` have diverged: ${commits(divergence.ahead)} here ${divergence.ahead === 1 ? "is" : "are"} not on the origin, and ${commits(divergence.behind)} there ${divergence.behind === 1 ? "is" : "are"} not here. \`git fetch origin\`, then \`git log --stat HEAD...${upstream}\` shows them.`;
      case "refused":
        return `Git refused to pull \`${upstream}\` into ${where}: ${reason(divergence.message)}`;
      case "unrelated":
        return `The origin rejected the first push of \`${divergence.branch}\` from ${where}: \`${upstream}\` holds history your folder does not share (${reason(divergence.message)}). \`git fetch origin\`, then \`git log --stat ${upstream}\` shows it; merging it takes \`--allow-unrelated-histories\`.`;
    }
  })();
  const uncommitted = divergence.kind === "unrelated" ? [] : divergence.uncommitted;
  return [
    "Pult could not sync your folder with its origin, and hands it to you to reconcile.",
    what,
    uncommitted.length === 0 ? "" : `Files changed here and not committed:\n${list(uncommitted)}`,
    `Reconcile it in your folder with git, keeping what both sides know (your memory, and the conversations, which do not conflict since each environment writes its own folder), commit, and push to \`${upstream}\`. Pult does not resolve it itself; it syncs again when you next fall asleep.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The title of the conversation a handoff wakes, which the server keeps until the Star's first reply retitles it. */
export const HANDOFF_TITLE = "Reconcile your folder";

/**
 * The handoff's thread id, deterministic from the home and what the origin
 * holds (its branch's commit, or with none read the divergence's kind and
 * branch), so a divergence is handed to the Star once, whichever page sees
 * it and however often: the folder's own side grows with each sleep's
 * commit, which must not hand the same divergence over again.
 */
export async function handoffThreadId(input: {
  readonly environmentId: string;
  readonly root: string;
  readonly divergence: Divergence;
  readonly originCommit: string | null;
}): Promise<string> {
  const key = [
    "pult-star-handoff",
    input.environmentId,
    input.root,
    input.divergence.kind,
    input.divergence.branch,
    input.originCommit ?? "",
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
