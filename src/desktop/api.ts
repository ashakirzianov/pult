/**
 * `window.pultDesktop`: what the desktop wrapper's preload
 * (`desktop/src/preload.ts`) exposes to the page, and all it exposes. Absent
 * in a browser tab, so the page reads it as `window.pultDesktop?.`.
 */
export interface PultDesktop {
  /** The desktop app's version. */
  readonly version: string;
  /**
   * The workbench's secret storage (`desktopSecrets` in `src/secrets.ts`),
   * kept by the wrapper's main process encrypted with Electron's safeStorage.
   * `set` rejects, with a message for the user, when the OS offers no
   * encryption: the wrapper never stores a secret in plain text.
   */
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /**
   * The window's title bar, where the wrapper draws none: on macOS the
   * traffic lights sit over the page's top-left, centred in `inset` pixels
   * that the page leaves them (`src/desktop/titleBar.ts`), except in full
   * screen, where macOS hides them. `inset` is 0 where the frame is the OS's.
   */
  readonly titleBar: {
    readonly inset: number;
    isFullScreen(): Promise<boolean>;
    onFullScreenChange(listener: (fullScreen: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    readonly pultDesktop?: PultDesktop;
  }
}
