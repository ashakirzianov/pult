import type { StarLook as State } from "../look.ts";

// The flat Star: a mark in a 48-unit box, drawn as SVG in `currentColor`, flat, with no blur, glow or gradient. The disc is wakefulness (solid awake, a dimmed outline asleep), the halo behind it activity, and signs around it what involves someone else. `star.css` beside this is every state's look and motion, keyed on the mark's `data-state`, so setting that attribute moves the mark to another state with its motion carrying on. Nothing here depends on a page: Pult takes this directory as it is.
//
// `flatStar` answers the live mark: a `<span class="flat-star">` holding four SVGs stacked in its box: the halo, the body (the disc, the troubled ring and the brackets), delegating's orbit, and the waiting dot over it. The caller gives the span a width and a height, sets `color` (the mark's colour) and `--err` (the troubled ring's) on it or an ancestor, and moves it to another state by setting its `data-state`; nothing else. The waiting dot's gap is cut out of the mark, so it shows whatever lies behind. `flatStill` answers the same mark as one self-contained SVG, for an image: the caller hands it the stylesheet the image carries, `star.css` (it holds no markup characters) followed by a rule resolving `color` and `--err` on `.flat-star`, and nothing in it moves (the stylesheet pauses a `.still`), each circle of the halo standing where the live mark's stands at rest. Each call answers a mark with ids of its own (the gap's mask), so each mark shown in one document takes a call of its own: two copies of one answer would share the first one's mask, `url(#id)` taking the first in the document.
//
// Why four SVGs: every loop runs on the compositor, with no paint, only for an element whose parent is an `<svg>` root; under a `<g>`, even a plain one, Chromium (152, Electron 44's) animates it on the main thread and repaints the mark every frame. So each moving thing is a root's child carrying all its motion itself (a circle of the halo turns with `rotate` and with `transform`, its pulses added onto the latter through `animation-composition`), and what fades as a whole (the halo, the orbit) is a root of its own, its opacity on the `<svg>`; the waiting dot is one too only to stay over the orbit, as it was.

// Anton's settings, 2026-11-10. The disc is a percentage of the box; the halo's size and its spread, the offsets, the pulse and the troubled ring's gap and weight are percentages of the disc's radius. Thinking's speed is a percentage of the halo's own turn and pulse, which talking shares; talking's of the extra turn and the pulse it adds, so the two differ in intensity alone.
export const defaults = {
  disc: 66,
  circles: 3,
  size: 100,
  spread: 10,
  thinking: 10,
  talking: 15,
  finished: 10,
  breath: 4,
  pulse: 8,
  opacity: 36,
  thinkingSpeed: 150,
  talkingSpeed: 170,
  ringGap: 15,
  ringWeight: 13,
};

export type Settings = typeof defaults;

// The halo's circles, as many as the settings take, in order: each one's own turn (seconds a round, its sign the direction), the extra turn talking adds, its talking pulse (seconds each way), where in its turn it starts, and where it falls in the size spread.
export const circles = [
  { turn: 9, fast: 5, pulse: 0.7, at: 0.1, spread: 0 },
  { turn: -13, fast: -6, pulse: 0.9, at: 0.45, spread: -1 },
  { turn: 17, fast: 7, pulse: 0.55, at: 0.8, spread: 1 },
  { turn: -7, fast: -4.5, pulse: 0.8, at: 0.3, spread: -0.5 },
  { turn: 11, fast: 5.5, pulse: 0.65, at: 0.6, spread: 0.5 },
];

// The halo's own pulse, thinking's, is this many times slower than the one talking adds.
const calm = 3;

const n = (value: number) => value.toFixed(2);

// The marks answered so far, which numbers each one's ids: `url(#id)` takes the first element in the document with that id, and a mark's mask follows its own state.
let made = 0;

// One of the mark's SVGs, filling the box: as a root in the live mark's span, or nested in the still's SVG, where `x`, `y`, `width` and `height` place it.
const layer = (name: string, content: string) => `<svg class="${name}" viewBox="-24 -24 48 48" x="-24" y="-24" width="48" height="48">${content}</svg>`;

// The mark's four SVGs, its custom properties and the gap's id, which `flatStar` and `flatStill` wrap.
function parts(settings: Settings) {
  if (settings.circles > circles.length) throw new Error(`the flat Star has ${circles.length} halo circles, not ${settings.circles}`);
  const R = (settings.disc / 100) * 24;
  const ofRadius = (percent: number) => `${n((percent / 100) * R)}px`;
  const thinking = settings.thinkingSpeed / 100;
  const talking = settings.talkingSpeed / 100;
  // Each circle's four loops, in the order the stylesheet's lists take: its turn, talking's extra turn, its breath and talking's pulse. Only the names, durations, delay and direction are set here: the stylesheet's play states pause them outside the working states, which the `animation` shorthand would override.
  const halo = circles
    .slice(0, settings.circles)
    .map((c) => {
      const r = R * (settings.size / 100) * (1 + (c.spread * settings.spread) / 100);
      const swing = Math.abs(c.turn / thinking);
      const fast = Math.abs(c.fast / talking);
      const direction = (seconds: number) => (seconds < 0 ? "reverse" : "normal");
      const style = [
        "animation-name: flat-star-spin, flat-star-turn, flat-star-breath, flat-star-pulse",
        `animation-duration: ${n(swing)}s, ${n(fast)}s, ${n((c.pulse * calm) / thinking)}s, ${n(c.pulse / talking)}s`,
        `animation-delay: ${n(-c.at * swing)}s, 0s, 0s, 0s`,
        `animation-direction: ${direction(c.turn)}, ${direction(c.fast)}, alternate, alternate`,
      ].join("; ");
      return `<circle class="off" r="${n(r)}" style="${style}"/>`;
    })
    .join("");
  // The signs keep their distance from the disc's edge, held inside the box.
  const ear = Math.min(R + 5.5, 22.5);
  const ex = n(ear * Math.cos(0.61));
  const ey = n(ear * Math.sin(0.61));
  const orbit = Math.min(R + 5.5, 21);
  const badge = n(R * Math.SQRT1_2);
  // Delegating's two satellites, one path so one layer, each a circle of radius 2.5 on the orbit.
  const sat = (x: number) => `M${n(x + 2.5)} 0A2.5 2.5 0 1 1 ${n(x - 2.5)} 0A2.5 2.5 0 1 1 ${n(x + 2.5)} 0`;
  // The waiting dot's gap, a circle in a mask over the still parts, which it alone overlaps; never over anything that moves: Chromium draws a masked group holding an animation, even a paused one, at a lower resolution, blurred.
  const gap = `flat-star-gap-${++made}`;
  const ring = (R * (100 + settings.ringGap + settings.ringWeight / 2)) / 100;
  const properties = {
    "--d-thinking": ofRadius(settings.thinking),
    "--d-talking": ofRadius(settings.talking),
    "--d-finished": ofRadius(settings.finished),
    "--breath": ofRadius(settings.breath),
    "--pulse": ofRadius(settings.pulse),
    "--halo": String(settings.opacity / 100),
    "--ring-w": ofRadius(settings.ringWeight),
  };
  const style = Object.entries(properties)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
  const svgs = [
    layer("part halo", halo),
    layer(
      "body",
      `<mask id="${gap}" maskUnits="userSpaceOnUse" x="-48" y="-48" width="96" height="96"><rect x="-48" y="-48" width="96" height="96" fill="#fff"/><g class="part badge"><circle cx="${badge}" cy="-${badge}" r="6" fill="#000"/></g></mask>` +
        `<g mask="url(#${gap})"><g class="core"><circle class="shell" r="${n(R - 1.25)}"/><circle class="disc" r="${n(R)}"/></g><g class="part tring"><circle class="ering" r="${n(ring)}"/></g><g class="part ears"><path class="line" d="M${ex} -${ey}A${n(ear)} ${n(ear)} 0 0 1 ${ex} ${ey}"/><path class="line" d="M-${ex} -${ey}A${n(ear)} ${n(ear)} 0 0 0 -${ex} ${ey}"/></g></g>`,
    ),
    layer("part orbit", `<circle class="line faint" r="${n(orbit)}"/><path class="dot sats" d="${sat(orbit)}${sat(-orbit)}"/>`),
    layer("over", `<g class="part badge"><circle class="dot" cx="${badge}" cy="-${badge}" r="4.4"/></g>`),
  ].join("");
  return { svgs, style };
}

// The live mark in a state, for a page: a span the caller sizes, its SVGs filling it.
export function flatStar(state: State, settings = defaults) {
  const { svgs, style } = parts(settings);
  return `<span class="flat-star" data-state="${state}" style="${style}">${svgs}</span>`;
}

// The mark in a state as one SVG, still, for an image, carrying `stylesheet`: `star.css` and the colours.
export function flatStill(state: State, stylesheet: string, settings = defaults) {
  const { svgs, style } = parts(settings);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="flat-star still" viewBox="-24 -24 48 48" data-state="${state}" style="${style}"><style>${stylesheet}</style>${svgs}</svg>`;
}
