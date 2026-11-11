// The projects the page draws as no project, by environment, as the Pult
// plugin's `stars` route lists them (`hidden`): every Star's, and any other
// project of that server in a folder of a `.pult/stars` directory. The
// Stars' model sets them (`model.ts`); the thread model holds an
// environment's threads back until they are known, so a Star's threads never
// flash as cards, and the panel, the picks and the changes view leave those
// projects out.

/** By environment: the hidden projects' ids, once the page knows them; none where the server has no plugin or its answer failed. */
const hidden = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const NONE: ReadonlySet<string> = new Set();

/** Sets the environment's hidden projects, or with undefined forgets them, as it is let go of. */
export function setHiddenProjects(
  environmentId: string,
  projectIds: ReadonlySet<string> | undefined,
): void {
  const known = hidden.get(environmentId);
  if (
    known !== undefined &&
    projectIds !== undefined &&
    known.size === projectIds.size &&
    [...known].every((id) => projectIds.has(id))
  )
    return;
  if (known === undefined && projectIds === undefined) return;
  if (projectIds === undefined) hidden.delete(environmentId);
  else hidden.set(environmentId, projectIds.size === 0 ? NONE : projectIds);
  for (const listener of listeners) listener();
}

/** The environment's hidden projects; undefined until its plugin's `about`, and where it lists `stars` its first Stars answer, are in. */
export function hiddenProjects(environmentId: string): ReadonlySet<string> | undefined {
  return hidden.get(environmentId);
}

/** Whether the project is one the page draws as no project. */
export function isHiddenProject(environmentId: string, projectId: string): boolean {
  return hidden.get(environmentId)?.has(projectId) === true;
}

/** Calls `listener` whenever an environment's hidden projects change. */
export function onDidChangeHiddenProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
