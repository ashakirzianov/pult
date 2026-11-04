/** The preload's IPC channels, one per call of `window.pultDesktop` that main answers. */
export const Channel = {
  secretsGet: "pult-desktop:secrets.get",
  secretsSet: "pult-desktop:secrets.set",
  secretsDelete: "pult-desktop:secrets.delete",
  secretsKeys: "pult-desktop:secrets.keys",
  windowTitleBarLayout: "pult-desktop:window.titleBarLayout",
  /** Main to the page, on every change: the window entered (`true`) or left full screen. */
  windowFullScreen: "pult-desktop:window.fullScreen",
} as const;

/**
 * On macOS the window draws no title bar: its traffic lights sit over the
 * page's top-left, in the page's top row (`TOP_ROW_HEIGHT` CSS pixels, the
 * left panel's header and the editor's tabs row). The lights are drawn in
 * the screen's points whatever the page's zoom, so main places them for the
 * zoom (`titleBarLayout`), as macOS 27 draws them: 14pt circles 9pt apart.
 */
export const TOP_ROW_HEIGHT = 35;
const LIGHTS_X = 12;
const LIGHT_SIZE = 14;
const LIGHTS_GAP = 9;
const LIGHTS_END = LIGHTS_X + 3 * LIGHT_SIZE + 2 * LIGHTS_GAP;
/**
 * The page's room for the lights past their end, in CSS pixels: with it the
 * header's Collapse Panel glyph sits as far after the lights as Pult's logo
 * sits after the glyph (`src/panel/panel.css`).
 */
const ROOM_PAST_LIGHTS = 4;

/**
 * Where the lights go for the page's `zoom`, their top centred on the top
 * row's middle, and the room the page leaves them at the row's start in its
 * own pixels (`titleBar.layout` in `src/desktop/api.ts`). No room in full
 * screen, where macOS hides them, or off macOS, where the frame is the OS's.
 */
export function titleBarLayout(zoom: number, fullScreen: boolean) {
  const position = { x: LIGHTS_X, y: Math.round((TOP_ROW_HEIGHT * zoom - LIGHT_SIZE) / 2) };
  const room =
    process.platform !== "darwin" || fullScreen ? 0 : LIGHTS_END / zoom + ROOM_PAST_LIGHTS;
  return { position, room };
}

/**
 * What a handler answers. A failure travels as a message rather than a thrown
 * error, which Electron would wrap in "Error invoking remote method …", so the
 * preload rejects with the message main wrote for the user.
 */
export type Reply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** How main hands the preload the app's version: an `additionalArguments` entry, read from the renderer's argv. */
export const VERSION_ARG = "--pult-version=";
