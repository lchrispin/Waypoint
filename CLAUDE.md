# Waypoint — session handover

Waypoint is a **trip tracker that plays your travels back as a film**: record GPS trips,
replay them as an animated story on a map, import Google Timeline history, attach photos,
and group trips into holidays. It is a vanilla-JS PWA — **no build step, no framework, no
tests** — deployed on GitHub Pages.

Deeper reference: **[docs/HANDOVER.md](docs/HANDOVER.md)** (module map, data model, playback
engine internals). What to build next: **[docs/ROADMAP.md](docs/ROADMAP.md)**.

## Architecture in one breath

`index.html` holds every view as a static `<div class="view">`; `app.js` is a one-line shim
re-exporting `src/main.js`, which wires 15 ES modules over a vendored MapLibre GL
(`vendor/`). All data lives in IndexedDB (`waypointDB` v3). The pre-rewrite monolith is
preserved in `legacy/` and **shares the same DB schema**. "Routing" is just
`showView(name)` toggling `.active` (`src/views.js:2`) — there is no URL router.

## Hard invariants — do not break these

1. **DB schema is shared with `legacy/`** (`src/db.js:1-2`). `onupgradeneeded` is
   create-only (`src/db.js:15-21`); never transform, rename, or drop stores/fields. Rolling
   back to legacy must never strand data. New fields on existing records are fine; readers
   must tolerate their absence.
2. **No build step.** Plain ES modules loaded directly. Never introduce a bundler,
   transpiler, or npm dependency for app code.
3. **`sw.js` SHELL list is hand-maintained** (`sw.js:2-29`). Any new file the app loads
   MUST be added there or offline breaks silently — CI enforces this
   (`.github/workflows/shell-guard.yml`). Bump the `waypoint-v5` cache name
   (`sw.js:1`) when changing the SW itself.
4. **Version stamping is automated.** `.github/workflows/stamp-version.yml` rewrites the
   `?v=` queries on `style.css`/`app.js` in `index.html` on every push to main and commits
   as `[auto-stamp]`. Never hand-edit the stamps; never remove the `?v=` queries. Module
   files under `src/` are *not* stamped — their freshness relies on the SW's
   network-first + `cache:'no-cache'` fetch (`sw.js:43-60`).
5. **Coordinates are `{lat, lng}` app-wide**; only `src/map.js` converts to MapLibre's
   `[lng, lat]` at the boundary (`src/map.js:39`).
6. **The camera/playback tuning constants encode hard-won behavior.** The follow camera
   damps the centre in *screen pixels, not degrees* (`src/camera.js:38-43`); drag parks
   follow, zoom does not (`src/playback.js:79-89`); the playhead is a GL circle layer, not
   a DOM marker (`src/map.js:118-122`); `createMap` polls `isStyleLoaded()` instead of
   waiting on `load` (`src/map.js:59-63`). Each of these replaced a visible bug — see
   docs/HANDOVER.md § Playback engine before touching them, and never retune without
   on-device verification.
7. **Every network path must degrade gracefully.** Tiles fall back to raster
   (`src/map.js:7-19,64-76`), road alignment falls back to the raw trace and is monotonic
   (`src/roads.js:111-120`), geocoding falls back to generic names. No feature may hang or
   hard-fail offline.
8. **Design intent:** dark-only "field atlas" theme (tokens at the top of `style.css`);
   `prefers-reduced-motion` stays honored (`style.css:795`); user-entered text goes through
   `escapeHtml` (`src/format.js`) before any `innerHTML` sink.

## External services (all keyless, all no-SLA)

| Service | URL | Used by | Offline/failure behavior |
|---|---|---|---|
| Vector tiles | tiles.openfreemap.org (positron) | `src/map.js:5` | 5 s timeout → raster fallback |
| Raster fallback | tile.openstreetmap.org | `src/map.js:7` | inline style, always loads |
| Map matching + routing | router.project-osrm.org (demo) | `src/roads.js:11-12` | raw trace / straight line kept |
| Reverse geocoding | nominatim.openstreetmap.org | `src/places.js:34` | generic names, retried later |
| Fonts | fonts.googleapis.com | `index.html:12-13` | system font fallback |

Both OSM community services are throttled in code to 1 req/s — keep it that way.

## Running & verifying

Any static server from the repo root, e.g. `python3 -m http.server 8000`, then
`http://localhost:8000`. Playwright + Chromium work here; every live map registers itself
at `window.__wpMaps[containerId]` as a driving hook (`src/map.js:56-57`).

No test suite exists. Before merging anything, run the manual smoke checklist:

1. **Record**: FAB → points accrue → Stop & save → trip appears, auto-renames itself
   ("A → B") within ~30 s online.
2. **Playback**: open a trip → overview (if multi-chapter) → play → follow camera tracks
   the dot; drag parks follow; pinch/wheel zoom does not; dot never leaves the screen.
3. **Photos**: menu → Add photos → batch matches to the right trips; photo memory card
   appears during playback at the right moment.
4. **Backup roundtrip**: Export backup → Restore it → counts match, photos intact.
5. **Import**: a Google Timeline.json → date range → candidates → import → plays back.
6. **Offline**: with the server stopped / network off, reload — the shell loads from the
   SW cache and existing trips still play (over the raster/no-tile map).

## Deploy pipeline

Push to `main` → `stamp-version.yml` rewrites `?v=` stamps, commits `[auto-stamp]`, and
explicitly requests a GitHub Pages build (token pushes don't trigger one). Users get the
new version on next load thanks to network-first SW. **When adding a file:** add it to
`sw.js` SHELL, and that's all — stamping handles the rest.
