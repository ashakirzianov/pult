// `pult-star`'s bake of Curls, seed 1, amber, curl, bell, uniform, 256 px: the
// rest animation's first frame, its light on transparency.
import amberStill from "../../assets/star/amber.png?no-inline";

import { tintOf } from "./record.ts";

/** The stills `pult-star` has baked, by tint; the others are drawn as a disc in the tint until they are. */
const STILLS: Readonly<Record<string, string>> = { amber: amberStill };

/**
 * A Star's mark, a still in v1 (the playback is
 * `pult/issues/durable-agent-animations`'s), as an image URL: its tint's
 * baked still where `pult-star` has one, else a glowing disc in the tint.
 */
export function starMarkUrl(tint: string): string {
  const still = STILLS[tint];
  if (still !== undefined) return new URL(still, window.location.href).href;
  const { hue } = tintOf(tint);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><radialGradient id="g"><stop offset="0" stop-color="hsl(${hue} 90% 85%)"/><stop offset="0.45" stop-color="hsl(${hue} 85% 62%)" stop-opacity="0.85"/><stop offset="1" stop-color="hsl(${hue} 85% 55%)" stop-opacity="0"/></radialGradient></defs><circle cx="16" cy="16" r="16" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
