# The thread view

Upstream's thread view (turns and composer), which the thread pane mounts in the page (`../src/threads/pane.tsx`): the repository's `apps/web`, built in place by the page's Vite (`../vite.config.ts`; `pult/decisions`, `thread-view-source`).

- This directory is ours: the entry (`main.tsx`, `startThreadView` and the host interface the pane fills), the app around the view, and the stubs.
- `stubs.ts` maps the `apps/web` modules our files replace; the build resolves every import of one to ours, and `apps/web` keeps the original, so it still typechecks.
- `tailwind.css` is `apps/web`'s stylesheet with `apps/web/src` added to Tailwind's sources.

What the pane needs from the app around the view goes here, or in a stub. When neither can do it, add a hook point to `apps/web`: a slot or context that leaves the fork's own web app upstream's without it, committed with its reason and a comment at the hook naming Pult's use, so git carries it through upstream's merges.
