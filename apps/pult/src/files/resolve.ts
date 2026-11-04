// The rule a path the thread view names opens by (`pult/decisions`,
// `thread-path-resolution`), apart from the workbench so
// `node --test src/files/resolve.test.ts` can run it; `openThreadFile`
// (`src/threads/files.ts`) runs it on the thread's environment.
import { type Checkout, checkoutName } from "../changes/checkouts.ts";
import { joinPath, locate, toUriPath } from "./paths.ts";

/** A file the server's index found for the key: its checkout, its path in it, and its `pult:` URI path. */
export interface Candidate {
  readonly checkout: Checkout;
  readonly relativePath: string;
  readonly path: string;
}

export type Resolution =
  /** The file to open, as a `pult:` URI path. */
  | { readonly kind: "open"; readonly path: string }
  /** Several files end with the key: the user picks, the thread's project's checkouts first. */
  | { readonly kind: "pick"; readonly key: string; readonly candidates: ReadonlyArray<Candidate> }
  /** An absolute path under no checkout of the environment, which its server would not read. */
  | { readonly kind: "outside" }
  /** No file ends with the key; `error` when every search failed, the first one's message. */
  | { readonly kind: "missing"; readonly key: string; readonly error: string | undefined };

export interface ResolveInput {
  /** As the view names it: relative to the thread's checkout, or an absolute host path. */
  readonly path: string;
  /** The thread's checkout as a host path, its worktree else its project's root; null when the store knows neither. */
  readonly checkoutRoot: string | null;
  /** The thread's project, whose checkouts a pick lists first. */
  readonly projectId: string;
  /** Every checkout of the thread's environment (`checkoutsOf`). */
  readonly checkouts: ReadonlyArray<Checkout>;
  /** Whether a `pult:` URI path is there; a failure counts as not. */
  readonly exists: (path: string) => Promise<boolean>;
  /** The server's index of a checkout searched for the key (`projects.searchEntries`): entries' paths relative to its root. */
  readonly search: (checkout: Checkout, key: string) => Promise<ReadonlyArray<string>>;
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

/**
 * Where a path the thread view names opens: the literal path in the thread's
 * checkout when it is there; else the files whose path ends with it, whole
 * segments, in the thread's checkout through the server's index, and only
 * with none there in the environment's other checkouts, one opening, several
 * a pick; an absolute path under no checkout is refused before any of it.
 */
export async function resolveThreadPath(input: ResolveInput): Promise<Resolution> {
  const own = input.checkoutRoot === null ? undefined : toUriPath(input.checkoutRoot);
  const roots = [
    ...input.checkouts.map((checkout) => toUriPath(checkout.root)),
    ...(own === undefined ? [] : [own]),
  ];
  let key: string;
  let literal: string | undefined;
  if (ABSOLUTE.test(input.path)) {
    literal = toUriPath(input.path);
    const located = locate(roots, literal);
    if (located === undefined) return { kind: "outside" };
    key = located.relativePath;
  } else {
    key = input.path.replace(/^(\.\/)+/, "");
    literal = own === undefined ? undefined : joinPath(own, key);
  }
  if (literal !== undefined && (await input.exists(literal)))
    return { kind: "open", path: literal };
  if (key === "") return { kind: "missing", key: input.path, error: undefined };

  const failures: Array<string> = [];
  const searched = async (checkouts: ReadonlyArray<Checkout>) => {
    const found = await Promise.all(
      checkouts.map(async (checkout) => {
        try {
          const entries = await input.search(checkout, key);
          const root = toUriPath(checkout.root);
          return entries
            .filter((entry) => endsWithKey(entry, key))
            .map((relativePath) => ({
              checkout,
              relativePath,
              path: joinPath(root, relativePath),
            }));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
          return [];
        }
      }),
    );
    return found.flat();
  };
  const isOwn = (checkout: Checkout) => own !== undefined && toUriPath(checkout.root) === own;
  const ownCheckout = input.checkouts.find(isOwn);
  let searches = 0;
  if (ownCheckout !== undefined) {
    searches += 1;
    const found = await searched([ownCheckout]);
    if (found.length > 0) return chosen(key, found);
  }
  const others = input.checkouts.filter((checkout) => !isOwn(checkout));
  searches += others.length;
  const found = await searched(others);
  if (found.length > 0) return chosen(key, ordered(found, input.projectId));
  return {
    kind: "missing",
    key,
    error: searches > 0 && failures.length === searches ? failures[0] : undefined,
  };
}

/** Whether an index entry is the key, or ends with it after a `/`: `files/paths.ts` is `src/files/paths.ts`, not `profiles/paths.ts`. */
export function endsWithKey(entry: string, key: string): boolean {
  return entry === key || entry.endsWith(`/${key}`);
}

function chosen(key: string, candidates: ReadonlyArray<Candidate>): Resolution {
  const [only] = candidates;
  return candidates.length === 1 && only !== undefined
    ? { kind: "open", path: only.path }
    : { kind: "pick", key, candidates };
}

/** The thread's project's checkouts first, then the others by name, each checkout's files in the index's order. */
function ordered(
  candidates: ReadonlyArray<Candidate>,
  projectId: string,
): ReadonlyArray<Candidate> {
  const rank = (candidate: Candidate) => (candidate.checkout.projectId === projectId ? 0 : 1);
  return candidates.toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      checkoutName(left.checkout).localeCompare(checkoutName(right.checkout)),
  );
}
