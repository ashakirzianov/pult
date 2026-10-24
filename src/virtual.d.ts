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
  }

  /** The T3 Code commit the view was built against, its checkout's `vendor/t3code/COMMIT`; undefined before the extension exported it. */
  export const VENDORED_COMMIT: string | undefined;

  export function startThreadView(
    host: ThreadViewHost,
    workbench: Element,
  ): { mount(element: HTMLElement, threadId: string): { dispose(): void } };
}

declare module "pult-extension/thread-view.css";
