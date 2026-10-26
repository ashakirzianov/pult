/** The preload's IPC channels, one per call of `window.pultDesktop` that main answers. */
export const Channel = {
  secretsGet: "pult-desktop:secrets.get",
  secretsSet: "pult-desktop:secrets.set",
  secretsDelete: "pult-desktop:secrets.delete",
  secretsKeys: "pult-desktop:secrets.keys",
} as const;

/**
 * What a handler answers. A failure travels as a message rather than a thrown
 * error, which Electron would wrap in "Error invoking remote method …", so the
 * preload rejects with the message main wrote for the user.
 */
export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** How main hands the preload the app's version: an `additionalArguments` entry, read from the renderer's argv. */
export const VERSION_ARG = "--pult-version=";
