/**
 * Lets the thread view in an editor group take files dragged in from outside
 * the page, which it attaches to its composer. The editor part's drop target
 * puts an overlay over the group on a drag's `dragenter`, the tabs' row's
 * included, to open the files as editors, and the drop then lands on that
 * overlay rather than the view; while `shown()`, a file drag's `dragenter`
 * and `dragleave` are stopped at `group`, the group's element, below that
 * listener, so it never sees one there. The tabs' row keeps its own drop,
 * opening the files as tabs, and an editor tab dragged over the group carries
 * no files and still reaches the group's drop zones.
 */
export function allowFileDrops(group: HTMLElement, shown: () => boolean): void {
  for (const type of ["dragenter", "dragleave"] as const) {
    group.addEventListener(type, (event) => {
      if (event.dataTransfer?.types.includes("Files") && shown()) event.stopPropagation();
    });
  }
}
