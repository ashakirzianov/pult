import { screen, type BrowserWindow, type Rectangle } from "electron";

import { readJson, writeJsonAtomic } from "./files.ts";

const DEFAULT_SIZE = { width: 1440, height: 900 };

/**
 * The window's bounds and maximised state, kept in a JSON file of main's.
 * `restore` gives the `BrowserWindow` options to open with: the saved bounds
 * only while they fit a connected display, the default size otherwise;
 * `track` saves them as the window moves and resizes, and on close.
 */
export function windowState(file: string) {
  return {
    restore() {
      const saved = decode(readJson(file));
      if (saved === undefined || !screen.getAllDisplays().some(({ bounds }) => contains(bounds, saved))) {
        return { ...DEFAULT_SIZE, maximized: false };
      }
      return saved;
    },
    track(window: BrowserWindow) {
      const save = () => {
        clearTimeout(timer);
        if (window.isDestroyed()) return;
        // The normal bounds, so a maximised window restores to where it was before maximising.
        writeJsonAtomic(file, { ...window.getNormalBounds(), maximized: window.isMaximized() });
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const later = () => {
        clearTimeout(timer);
        timer = setTimeout(save, 500);
      };
      window.on("move", later);
      window.on("resize", later);
      window.on("maximize", later);
      window.on("unmaximize", later);
      window.on("close", save);
    },
  };
}

function contains(display: Rectangle, window: Rectangle): boolean {
  return (
    window.x >= display.x &&
    window.y >= display.y &&
    window.x + window.width <= display.x + display.width &&
    window.y + window.height <= display.y + display.height
  );
}

function decode(json: unknown): (Rectangle & { maximized: boolean }) | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const fields: Map<string, unknown> = new Map(Object.entries(json));
  const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => fields.get(key));
  if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height, maximized: fields.get("maximized") === true };
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
