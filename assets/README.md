# Brand assets

Pult's icon sources are in `assets/pult/`; `vp run icons:export` renders every size from them into `assets/pult/{prod,dev}` and `apps/pult/public`, and `vp run icons:check` verifies the renders (see `DECISIONS.md`, `brand-icons`).

`dev/`, `prod/` and `nightly/` are upstream T3 Code's icon sources, kept as copied and read by no build here; `scripts/lib/brand-assets.ts` still names their iOS and Icon Composer paths for the platforms Pult does not ship.
