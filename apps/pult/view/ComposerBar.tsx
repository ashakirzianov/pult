// What the composer shows above itself, as entries of Pult's composer bar
// (`ThreadView.tsx`): upstream's notices. Upstream's composer renders them
// here instead of above itself while the app around the view provides the bar
// (`ComposerControlsSlot`). The thread's sync, its background work and its
// goal are upstream's lines at the end of the timeline.
import { ComposerBanner } from "~/components/chat/ComposerBanner";
import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useLayoutEffect, useRef } from "react";

/** Errors and warnings first, then upstream's stack order: the machine's notices, then what needs you. */
function noticeRank(item: ComposerBannerStackItem) {
  if (item.variant === "error" || item.variant === "warning") return 0;
  return (item.group ?? "attention") === "environment" ? 1 : 2;
}

/** One notice in full, as upstream's stack shows it. */
function Notice({ item }: { readonly item: ComposerBannerStackItem }) {
  return (
    <ComposerBanner.Root role="alert" detached variant={item.variant} density="comfortable">
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="block whitespace-normal wrap-anywhere">
          <span className="font-medium">{item.title}</span>
          {item.description ? (
            <span className="block text-muted-foreground">{item.description}</span>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}

/**
 * The notices as one entry: the first by upstream's order, its icon and
 * title, and how many more, a button that opens them all in full above the
 * bar; then the first one's actions and dismissal.
 */
export function ComposerBarNotices({
  items,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}) {
  // The background work notice lists the thread's working subagents, which its card in the shell lists already.
  const ordered = items
    .filter((item) => !item.id.startsWith("background-work:"))
    .toSorted((a, b) => noticeRank(a) - noticeRank(b));
  const front = ordered[0];
  if (front === undefined) return null;
  return (
    <div className="pult-bar-notice" data-variant={front.variant}>
      <Popover>
        <PopoverTrigger
          render={<button type="button" className="pult-bar-notice-summary" />}
          aria-label={ordered.length > 1 ? `${ordered.length} notices` : "Notice details"}
        >
          <span className="pult-bar-notice-icon">{front.icon}</span>
          <span className="pult-bar-notice-title">{front.title}</span>
          {ordered.length > 1 ? (
            <span className="pult-bar-notice-count">+{ordered.length - 1}</span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          aria-label="Notices"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <div className="flex max-h-[min(var(--available-height),28rem)] flex-col gap-2 overflow-y-auto">
            {ordered.map((item) => (
              <Notice key={item.id} item={item} />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      {front.actions || front.onDismiss ? (
        <span className="pult-bar-notice-actions">
          {front.actions}
          {front.onDismiss ? (
            <ComposerBanner.Dismiss
              aria-label={front.dismissLabel ?? "Dismiss warning"}
              onClick={front.onDismiss}
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Where the composer bar sits while a composer is mounted: at the end of the
 * composer's form, under its message, so the buttons in it submit the form
 * as upstream's do. The bar is the shell's element (`ThreadView.tsx`), moved
 * here and back to where it was when the composer goes, as for a thread
 * that mounts none.
 */
export function ComposerBarHost({
  slot,
  draft,
}: {
  readonly slot: HTMLElement;
  readonly draft: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const home = slot.parentElement;
    element.append(slot);
    return () => {
      if (home !== null && slot.parentElement === element) home.append(slot);
    };
  }, [slot]);
  return <div ref={host} data-chat-composer-bar-host={draft ? "draft" : "thread"} />;
}
