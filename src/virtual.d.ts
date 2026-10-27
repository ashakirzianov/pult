declare module "virtual:pult-extension" {
  import type { IExtensionManifest } from "@codingame/monaco-vscode-api/extensions";
  export const manifest: IExtensionManifest;
  export const files: ReadonlyArray<string>;
  export const base: string;
  export const extensionDir: string;
}

/**
 * The thread view pult-extension builds for the shell (`webview/shell/main.tsx`
 * there), resolved by `vite/pultExtension.ts`; this is its shape as the shell uses it.
 */
declare module "pult-extension/thread-view" {
  import type * as Context from "effect/Context";

  export interface ThreadViewHost {
    /**
     * The services of the page's connection runtime. The extension's
     * `ShellConnectionServices` names what they must include; across the two
     * repos it is checked when the view's runtime builds, not here.
     */
    readonly connection: () => Promise<Context.Context<never>>;
    readonly environmentId: () => string | null;
    readonly openThread: (threadId: string) => void;
    /** A draft of a new thread the view went to, which it remembered as the project's draft. */
    readonly openDraft: (projectId: string) => void;
    /** A file the view would show in its right panel: relative to the thread's project root, or an absolute host path. */
    readonly openFile: (threadId: string, path: string, line: number | null) => void;
    /** The thread's changes, with a file's path when one was named: the extension's changes view. */
    readonly openChanges: (threadId: string, path: string | null) => void;
    /** Whether threads of the mounted thread's lineage work, and since when, from its projection: its subagents', and its own as a native subagent. */
    readonly reportActivity: (
      activity: ReadonlyArray<{ readonly threadId: string; readonly working: boolean; readonly workingSince: string | null }>,
    ) => void;
  }

  /** The T3 Code commit the view was built against, its checkout's `vendor/t3code/COMMIT`; undefined before the extension exported it. */
  export const VENDORED_COMMIT: string | undefined;

  /** A mounted view; its composer bar, which takes entries of the shell's own, is undefined from a build before it offered one. */
  export interface MountedView {
    dispose(): void;
    readonly bar?: HTMLElement;
  }

  export interface ThreadViewMounts {
    /** The thread's turns and composer. */
    mount(element: HTMLElement, threadId: string): MountedView;
    /**
     * The project's draft of a new thread, upstream's composer, which stays
     * mounted as the thread it creates and names it to `onPromoted`;
     * undefined from a build before drafts.
     */
    readonly mountDraft?: (
      element: HTMLElement,
      projectId: string,
      onPromoted: (threadId: string) => void,
    ) => MountedView;
  }

  export function startThreadView(host: ThreadViewHost, workbench: Element): ThreadViewMounts;
}

declare module "pult-extension/thread-view.css";
