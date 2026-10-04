# Pult's brand assets

The sources, as Anton supplied them:

- `icon.svg`: the app icon, on a 1024 artboard with the macOS margin.
- `small-icon.png`: the icon for small sizes (32 px and below). It has no vector source.
- `logo.svg`: both wordmarks. `logo-white.svg` and `logo-color.svg` are cut from it, each with a tight viewBox.

`vp run icons:export` renders every desktop and web icon from them into `prod/` and `dev/`, and the dev web icons into `apps/pult/public`. `vp run icons:check` fails if a written icon differs from a fresh render. Do not edit the rendered files. Dev is black and white: its icon is `icon.svg` with the four coloured fills set to white, and its small P is solid black.

Upstream's `assets/dev`, `assets/prod` and their Icon Composer projects stay as upstream ships them, and nothing of Pult's reads them. Do not run `scripts/export-brand-icons.ts`: it writes upstream's renders over Pult's paths.
