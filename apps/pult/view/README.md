# The thread view

Upstream's thread view (turns and composer), which the thread pane mounts in the page (`../src/threads/pane.tsx`), built by the page's Vite (`../vite.config.ts`).

- `t3/` is the copy: the fork's `apps/web` at the commit in `t3/UPSTREAM`, as far as `shell/` reaches it (`pult/decisions`, `thread-view-source`). It is upstream's, byte for byte, but for the edits `t3/EDITS.md` lists with their reasons; formatting and lint skip it.
- `shell/` is ours: the entry (`main.tsx`, `startThreadView` and the host interface the pane fills), the app around the view, and the stubs.
- `stubs.ts` maps the upstream modules our files replace; the build resolves every import of one to ours, and the copy keeps the original, so it still typechecks and merges.

What the pane needs from the app around the view goes in `shell/`, or a stub; edit a copied file only when neither can do it, and list the edit in `t3/EDITS.md`.

A PIN bump (`../vendor/t3code/PIN`): `pnpm vendor:sync`, `pnpm i`, then `pnpm vendor:merge`, which merges upstream's change into each copied file three ways, adds the files `shell/` now reaches and drops unedited ones it no longer does, and says when upstream's `apps/web/package.json` changed (the view's dependencies in `../package.json` follow it). A merge that leaves conflicts writes the pin to `t3/MERGING` instead of `t3/UPSTREAM`; resolve the markers and run it again to record it. Then fix what `pnpm typecheck` says. `pnpm vendor:check` fails while the copy is at another commit, holds a conflict marker, or differs from upstream in a file `t3/EDITS.md` does not list.
