// Upstream's preview pane (`PreviewView`) in a workbench tab of Pult's shell:
// its chrome row and its body, the slot a natively hosted tab's `<webview>` is
// placed over (`browserHost.tsx`), or the server's stream of a headless tab,
// or the empty state of a tab with no page yet.
import { AuthPreviewOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { usePreviewAvailable } from "~/browser/previewRuntime";
import { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { PreviewView } from "~/components/preview/PreviewView";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useEnvironmentScope } from "~/state/session";
import { threadViewHost } from "./host.ts";

/** A mounted preview pane. */
export interface MountedPreview {
  /** The pane moved without resizing (a group moved): a hosted tab's webview follows it. */
  layout(): void;
  /** Whether the pane shows: a hidden one parks its webview offscreen and stops its stream's input. */
  setVisible(visible: boolean): void;
  /** Unmounts it; not from inside another React root's render. */
  dispose(): void;
}

interface Presentation {
  readonly tabId: string | null;
  readonly visible: boolean;
  readonly layoutVersion: number;
}

/**
 * Renders the session `tabId` of the thread into `element` until disposed,
 * visible until told otherwise. With a null `tabId` it is a placeholder for a
 * session not opened yet: upstream's empty state, whose URL field and local
 * servers open one; the pane then shows that session, and the shell is told
 * through `openPreview` with `replacePlaceholder`, so the placeholder's tab
 * becomes the session's. Without the preview scope on the environment, or
 * the server browser and the desktop both missing, upstream's notice.
 */
export function mountPreview(
  element: HTMLElement,
  environmentId: string,
  threadId: string,
  tabId: string | null,
): MountedPreview {
  let presentation: Presentation = { tabId, visible: true, layoutVersion: 0 };
  const listeners = new Set<() => void>();
  const update = (change: Partial<Presentation>) => {
    presentation = { ...presentation, ...change };
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const onPlaceholderOpened = (opened: string) => {
    update({ tabId: opened });
    threadViewHost().openPreview(environmentId, threadId, opened, {
      activate: true,
      replacePlaceholder: true,
    });
  };
  const root = document.createElement("div");
  root.className = "pult-preview-view pult-view-theme";
  element.append(root);
  const react = createRoot(root);
  react.render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <Pane
          environmentId={environmentId}
          threadId={threadId}
          presentation={() => presentation}
          subscribe={subscribe}
          onPlaceholderOpened={onPlaceholderOpened}
        />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
  return {
    layout: () => update({ layoutVersion: presentation.layoutVersion + 1 }),
    setVisible: (visible) => {
      if (visible !== presentation.visible) update({ visible });
    },
    dispose: () => {
      listeners.clear();
      react.unmount();
      root.remove();
    },
  };
}

function Pane(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly presentation: () => Presentation;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onPlaceholderOpened: (tabId: string) => void;
}) {
  const { tabId, visible, layoutVersion } = useSyncExternalStore(
    props.subscribe,
    props.presentation,
  );
  const environmentId = EnvironmentId.make(props.environmentId);
  const available = usePreviewAvailable(environmentId);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode="embedded">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {canOperatePreview
              ? "Preview is only available in the T3 Code desktop app."
              : "Pair this client again with preview access to control browser previews."}
          </p>
        </div>
      </PreviewPanelShell>
    );
  }
  return (
    <PreviewPanelShell mode="embedded">
      <PreviewView
        threadRef={scopeThreadRef(environmentId, ThreadId.make(props.threadId))}
        tabId={tabId}
        visible={visible}
        layoutVersion={layoutVersion}
        floatable={false}
        {...(tabId === null ? { onPlaceholderOpened: props.onPlaceholderOpened } : {})}
      />
    </PreviewPanelShell>
  );
}

function SessionSync(props: { readonly environmentId: string; readonly threadId: string }) {
  usePreviewSession(
    scopeThreadRef(EnvironmentId.make(props.environmentId), ThreadId.make(props.threadId)),
  );
  return null;
}

/**
 * Keeps the thread's preview sessions in step with its server, as its pane's
 * view does while mounted, until the returned stop: upstream's sync is a hook,
 * so a React root of its own, on no element of the page.
 */
export function syncPreviewSessions(environmentId: string, threadId: string): () => void {
  const root = createRoot(document.createElement("div"));
  root.render(
    <AppAtomRegistryProvider>
      <SessionSync environmentId={environmentId} threadId={threadId} />
    </AppAtomRegistryProvider>,
  );
  return () => queueMicrotask(() => root.unmount());
}
