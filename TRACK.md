---
track: Pult
slug: pult
---

# Pult

Pult is not a fork: it is a client of T3 Code Extensible, with the fork's protocol packages vendored at a pin. Its server-side needs go to the fork, as RPCs offered upstream when generic (`DECISIONS.md`, `server-side-home`).

Since 2026-10-07 the client direction is a VS Code extension against stock T3 Code servers, with an own shell deferred until a specific need: `docs/pult/rfc-1.md`. The extension is its own repo, `../pult-extension` (tag `pult-extension`); this file is the track's hub, and that repo's `TRACK.md` points back here.

Pult is the sister track of **Bach** (`../bach`), the T3 Code extension the fleet ran on. Bach is parked (`bach/park-the-track`, 2026-10-05): the fleet moved off it, and no work continues on it in parallel.

Start with `docs/pult/rfc-0.md` (Anton's, human-written). Repo conventions: `AGENTS.md`.

The name was used before. Until 2026-10-03 "Pult" was a hard fork that carried Bach's model as a standalone app; that line is archived as `ashakirzianov/bach-app`, and this repo started fresh from upstream that day. A `pult/` issue or note older than that speaks of the old line.
