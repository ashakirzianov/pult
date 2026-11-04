/**
 * Paths of `pult:` URIs. A URI's authority is the environment id and its path
 * the host's absolute path with forward slashes: `/Users/anton/x.ts` as is, a
 * Windows `C:\Users\x.ts` as `/c:/Users/x.ts` (`pult/decisions`, `pult-uri`).
 * Workspace folders are project and worktree roots, held as URI paths.
 */
export const PULT_SCHEME = "pult";

/**
 * A host path as a `pult:` URI path. A drive letter is lowercased, as VS Code
 * writes it in any URI it saves, so a restored folder or tab still matches.
 */
export function toUriPath(hostPath: string): string {
  const path = /^[A-Za-z]:([\\/]|$)/.test(hostPath)
    ? `/${hostPath.charAt(0).toLowerCase()}${hostPath.slice(1).replaceAll("\\", "/")}`
    : hostPath;
  return path.length > 1 && path.endsWith("/") && !/^\/[A-Za-z]:\/$/.test(path)
    ? path.slice(0, -1)
    : path;
}

/** A `pult:` URI path as the host path the server takes; Windows paths keep forward slashes. */
export function toHostPath(uriPath: string): string {
  return /^\/[A-Za-z]:(\/|$)/.test(uriPath) ? uriPath.slice(1) : uriPath;
}

/** `path` relative to `root`: `""` for the root itself, undefined outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  if (path === root) return "";
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}

export interface Located {
  readonly root: string;
  readonly relativePath: string;
}

/** The innermost of `roots` holding `path`, and the path relative to it. */
export function locate(roots: Iterable<string>, path: string): Located | undefined {
  let found: Located | undefined;
  for (const root of roots) {
    const relativePath = relativeTo(root, path);
    if (relativePath === undefined) continue;
    if (found === undefined || root.length > found.root.length) found = { root, relativePath };
  }
  return found;
}

export function joinPath(root: string, relativePath: string): string {
  if (relativePath === "") return root;
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

/** The parent of a root-relative path, `""` for an entry at the root. */
export function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Whether a URI authority names an environment. VS Code lowercases authorities
 * when it writes a URI out, so a restored folder may differ in case.
 */
export function namesEnvironment(authority: string, environmentId: string): boolean {
  return authority.toLowerCase() === environmentId.toLowerCase();
}

/**
 * The closest directory above every one of `paths`, as an environment's
 * folder is above its projects: `/repos` for `/repos/a` and `/repos/a/b`.
 * Undefined for no paths, or for paths on different Windows drives.
 */
export function commonParent(paths: ReadonlyArray<string>): string | undefined {
  const parents = paths.map((path) =>
    path
      .split("/")
      .filter((segment) => segment !== "")
      .slice(0, -1),
  );
  const [first] = parents;
  if (first === undefined) return undefined;
  let length = 0;
  while (length < first.length && parents.every((parent) => parent[length] === first[length]))
    length += 1;
  const common = first.slice(0, length);
  const drive = /^[a-z]:$/i;
  if (common.length === 0 && paths.some((path) => drive.test(path.split("/")[1] ?? "")))
    return undefined;
  return common.length === 1 && drive.test(common[0] ?? "")
    ? `/${common[0]}/`
    : `/${common.join("/")}`;
}

/**
 * Whether a workspace folder shows `path`, given the environment's project
 * and worktree roots: a folder above some of them, and in none, shows only
 * those roots, what is under them and the directories on the way to them;
 * any other folder, all that is under it.
 */
export function folderShows(
  folder: string,
  knownRoots: ReadonlyArray<string>,
  path: string,
): boolean {
  if (relativeTo(folder, path) === undefined) return false;
  const below = projectsUnder(folder, knownRoots);
  return (
    below.length === 0 ||
    below.some(
      (root) => relativeTo(root, path) !== undefined || relativeTo(path, root) !== undefined,
    )
  );
}

/** The outermost of `knownRoots` strictly under `folder`, or none when `folder` is in one of them, which then shows all that is under it. */
export function projectsUnder(
  folder: string,
  knownRoots: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (knownRoots.some((root) => relativeTo(root, folder) !== undefined)) return [];
  const below = knownRoots.filter((root) => relativeTo(folder, root) !== undefined);
  return below.filter(
    (root) => !below.some((other) => other !== root && relativeTo(other, root) !== undefined),
  );
}
