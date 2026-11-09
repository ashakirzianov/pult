// A checkout's commit history as VS Code's Graph takes it, after the git
// extension's history provider, apart from the workbench so
// `node --test src/changes/history.test.ts` can run it.
import type {
  ISCMHistoryItem,
  ISCMHistoryItemRef,
  ISCMHistoryItemRefsChangeEvent,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/history";
import type { ReviewLogCommit, ReviewRefsResult } from "@t3tools/contracts";

/** The Graph's colours, which its own module registers. */
const CURRENT_COLOR = "scmGraph.historyItemRefColor";
const REMOTE_COLOR = "scmGraph.historyItemRemoteRefColor";
const BASE_COLOR = "scmGraph.historyItemBaseRefColor";

const KINDS = [
  { prefix: "refs/heads/", category: "branches", icon: "git-branch" },
  { prefix: "refs/remotes/", category: "remote branches", icon: "cloud" },
  { prefix: "refs/tags/", category: "tags", icon: "tag" },
] as const;

/** What the Graph's default filter walks and colours: the checkout's branch, its upstream and its base; and every ref for the others. */
export interface HistoryRefs {
  readonly current: ISCMHistoryItemRef | undefined;
  readonly remote: ISCMHistoryItemRef | undefined;
  readonly base: ISCMHistoryItemRef | undefined;
  readonly all: ReadonlyArray<ISCMHistoryItemRef>;
}

/** A branch, remote branch or tag by its full name, as the git extension lists it. */
function refOf(name: string, sha: string): ISCMHistoryItemRef {
  const kind = KINDS.find(({ prefix }) => name.startsWith(prefix));
  return {
    id: name,
    name: kind === undefined ? name : name.slice(kind.prefix.length),
    revision: sha,
    ...(kind === undefined ? {} : { category: kind.category, icon: { id: kind.icon } }),
  };
}

/**
 * The server's refs as the Graph's: HEAD's branch (or its commit while
 * detached) in the current ref's colour with the target icon, its upstream in
 * the remote's, and the base the server diffs the branch against (`baseRef`,
 * as the branch range names it, `main` or `origin/main`) in the base's,
 * left out where it is the branch or its upstream.
 */
export function historyRefs(result: ReviewRefsResult, baseRef: string | null): HistoryRefs {
  const all = result.refs.map((ref) => refOf(ref.name, ref.sha));
  const byName = new Map(all.map((ref) => [ref.id, ref]));
  const { head } = result;
  // Before the first commit the branch is at none, and the Graph has nothing to walk.
  const current =
    head.sha === null
      ? undefined
      : {
          id: head.ref ?? head.sha,
          name: head.ref === null ? head.sha.slice(0, 8) : refOf(head.ref, "").name,
          revision: head.sha,
          color: CURRENT_COLOR,
          icon: { id: "target" },
        };
  const upstream = result.refs.find((ref) => ref.name === head.ref)?.upstream ?? null;
  const remoteRef = upstream === null ? undefined : byName.get(upstream);
  const remote = remoteRef === undefined ? undefined : { ...remoteRef, color: REMOTE_COLOR };
  const baseName =
    baseRef === null
      ? undefined
      : [baseRef, ...KINDS.map(({ prefix }) => `${prefix}${baseRef}`)].find((name) =>
          byName.has(name),
        );
  const base =
    baseName === undefined || baseName === current?.id || baseName === remote?.id
      ? undefined
      : { ...byName.get(baseName)!, color: BASE_COLOR };
  return { current, remote, base, all };
}

/** A commit as the Graph's item: its refs the current, remote and base ones first, in their colours, then by kind and name. */
export function historyItem(
  commit: ReviewLogCommit,
  refs: HistoryRefs | undefined,
): ISCMHistoryItem {
  const coloured = [refs?.current, refs?.remote, refs?.base];
  const references = commit.refs
    .map((name) => coloured.find((ref) => ref?.id === name) ?? refOf(name, commit.sha))
    .sort((left, right) => rank(left, coloured) - rank(right, coloured) || compare(left, right));
  const timestamp = Date.parse(commit.authoredAt);
  return {
    id: commit.sha,
    parentIds: [...commit.parents],
    subject: commit.subject,
    message: commit.message,
    displayId: commit.sha.slice(0, 7),
    author: commit.authorName,
    authorEmail: commit.authorEmail,
    ...(Number.isNaN(timestamp) ? {} : { timestamp }),
    references,
  };
}

function rank(
  ref: ISCMHistoryItemRef,
  coloured: ReadonlyArray<ISCMHistoryItemRef | undefined>,
): number {
  const index = coloured.findIndex((candidate) => candidate?.id === ref.id);
  return index < 0 ? coloured.length : index;
}

function compare(left: ISCMHistoryItemRef, right: ISCMHistoryItemRef): number {
  const kind = (ref: ISCMHistoryItemRef) =>
    KINDS.findIndex(({ prefix }) => ref.id.startsWith(prefix));
  return kind(left) - kind(right) || left.name.localeCompare(right.name);
}

/**
 * How the refs moved between two reads, for the Graph: undefined when none
 * did; silent, which refreshes the Graph only while scrolled to its top,
 * unless the current ref moved.
 */
export function refsChange(
  before: HistoryRefs | undefined,
  after: HistoryRefs,
): ISCMHistoryItemRefsChangeEvent | undefined {
  const previous = new Map((before?.all ?? []).map((ref) => [ref.id, ref]));
  const next = new Map(after.all.map((ref) => [ref.id, ref]));
  const added = after.all.filter((ref) => !previous.has(ref.id));
  const removed = [...previous.values()].filter((ref) => !next.has(ref.id));
  const modified = after.all.filter((ref) => {
    const old = previous.get(ref.id);
    return old !== undefined && old.revision !== ref.revision;
  });
  const currentMoved =
    before?.current?.id !== after.current?.id ||
    before?.current?.revision !== after.current?.revision;
  if (added.length === 0 && removed.length === 0 && modified.length === 0 && !currentMoved)
    return undefined;
  return { added, removed, modified, silent: !currentMoved };
}
