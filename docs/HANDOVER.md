# Waypoint — deep reference

Companion to [CLAUDE.md](../CLAUDE.md) (invariants, smoke checklist) and
[ROADMAP.md](ROADMAP.md) (what to build). This file explains how the app works and *why*
it works that way, so solved battles don't get re-fought. Anchors verified against `main`
@ `d6bf3d5`.

## Contents

- [Module map](#module-map)
- [Data model](#data-model)
- [Recording pipeline](#recording-pipeline)
- [Playback engine](#playback-engine) — read before touching camera/story/roads
- [Photos pipeline](#photos-pipeline)
- [Deploy pipeline](#deploy-pipeline)
- [Known fragilities](#known-fragilities)

## Module map

Boot: `index.html` (all views as static divs) → `app.js` (one-line shim) →
`src/main.js:39 initApp()` → each view's `init*()`, then `renderHome()`. Also requests
`navigator.storage.persist()` and registers `sw.js` (`src/main.js:47-54`).

| Module | Role | Key exports |
|---|---|---|
| `src/main.js` | boot + "···" menu sheet wiring | `initApp` |
| `src/views.js` | history-backed "router" + shared UI utils + in-theme dialogs | `showView`, `openModal`, `closeModal`, `registerViewGuard`, `registerViewExit`, `uiConfirm`, `uiAlert`, `setLoading`, `showToast`, `setTextIfChanged` |
| `src/db.js` | promise-wrapped IndexedDB; one cached connection, dropped on `versionchange`/`close` | `dbPutStore`, `dbGetAllStore`, `dbGetStore`, `dbDeleteStore`, trip sugar at end of file |
| `src/geo.js` | pure geodesy/interpolation, no side effects | `haversine:3`, `lowerBoundIdx:27`, `pointAtSimTime:37`, `interpolateByRealTs:57`, `nearestTrackPoint:69`, `downsampleByDistance:78` |
| `src/format.js` | pure display formatters | `fmtDistance`, `fmtDuration`, …, `escapeHtml:45` (the app's only XSS guard) |
| `src/map.js` | MapLibre wrapper; `{lat,lng}`→`[lng,lat]` boundary | `createMap:41`, line/dot/marker helpers, `boundsOf:155` |
| `src/home.js` | home shelf: holidays + trips, sparklines, select mode, merge/combine/bulk-delete | `renderHome:45`, `initHome:206`, `mergeSelectedTrips:158` |
| `src/record.js` | live recording | `initRecord:124`; pipeline below |
| `src/story.js` | **pure** story builder (no DOM, no map) | `buildTripStory:270`, `buildHolidayStory:290`, `detectStays:19`, `movementSegments:95`, accessors `:342-398` |
| `src/playback.js` | renders a story as a film (1107 lines) | `openPlayback:115`, `openHolidayPlayback:127`, `initPlayback:965` |
| `src/camera.js` | damped follow camera | `createCamera:11`, `camStep:44`, `clampToView:74`, `computeTargetZoom:27`, `cameraForPair:93` |
| `src/roads.js` | OSRM map-matching + 2-point routing | `alignTripToRoads:115`, `snapToRoad:182` |
| `src/places.js` | Nominatim reverse geocode, cached + queued | `requestPlaceName:20`, `placeNameSync:16`, `autoNameTrip:57` |
| `src/photos.js` | photo↔trip matching + bulk import | `matchPhotoToTrip:15`, `bulkAddPhotos:61`, `newPhotoId:10` |
| `src/exif.js` | minimal hand-rolled EXIF parser (first 128 KB only, `exif.js:10`) | `readExifGps:3`, `parseExif:14` |
| `src/import-google.js` | Google Timeline.json import flow | `initImport:241`; parses `rawSignals`/`semanticSegments` only |
| `src/backup.js` | export/restore one JSON file, non-destructive union restore | `exportBackup:27`, `restoreBackup:56` |
| `src/gpx.js` | GPX 1.1 export of raw recorded points (trip or holiday) | `downloadGpx`, `buildGpx` |
| `sw.js` | network-first SW, hand-listed shell precache | — |
| `legacy/` | the pre-rewrite monolith, kept runnable, same DB | — |

Navigation (§ updated for A1): views are still toggled divs, but `views.js` now mirrors a
linear nav stack into the History API. `showView`/`openModal` push a `{depth}` entry;
one `popstate` handler unwinds. UI back buttons call `history.back()`, so the OS/browser
back button and on-screen back converge on one path. Views may register a **guard** (veto
or ask-first, e.g. record's discard confirm; playback's playing→overview step) and an
**exit** handler (teardown when the view actually leaves). Guards that must confirm return
a `{confirm, onConfirm}` descriptor so `views.js` opens the in-theme dialog in the correct
history order. There is still no *URL* routing (no paths/hashes); view state (open trip,
etc.) lives in module-level variables.

## Data model

IndexedDB `waypointDB`, version 3 (`src/db.js:3-4`). Four stores, all `keyPath:'id'`, no
indexes. **Upgrades are create-only** (`src/db.js:15-21`) — see invariant #1.

```
trips:        { id,                 // String(Date.now()) | 'merge-'+ts | import ids
                name, autoNamed,    // autoNamed=false ⇒ user-named, never auto-renamed again
                startTime, endTime,
                points: [{ lat, lng, alt, speed, acc, ts }],   // imported points may lack alt/speed/acc
                distance,           // metres, accrued incrementally
                typeLabel?,         // imported activity ("Drive", "Walk", …)
                roadAlign?: { v, count, coords[[lat,lng]], path[{lat,lng,ts,speed?}],
                              partial, fetchedAt } }           // see Road alignment below
collections:  { id: 'col-'+ts, name, tripIds[], createdAt }    // "holidays"
photos:       { id, tripId, blob (Blob), ...meta }             // matched via photos.js
places:       { id: 'lat,lng' @ 3 decimals (~100 m grid), name, fetchedAt }
```

Timestamps: recorded points use wall-clock `Date.now()`. Story display points carry a
**synthetic `ts`** (compressed sim-time, ms from 0) plus `realTs` (the original wall
clock) — `src/story.js:62-66`. Anything reading a story point must know which clock it
wants; `src/geo.js` has interpolators for both (`pointAtSimTime`, `interpolateByRealTs`).

## Recording pipeline

`src/record.js` — FAB starts immediately (no naming modal; the trip names itself later):

1. `startRecording` bails out immediately if the browser lacks geolocation, else creates
   the trip (`id = String(Date.now())`, `autoNamed:true`, placeholder name), shows the
   view, acquires a **screen wake lock** (feature-detected + try/caught; re-acquired on
   `visibilitychange` while a watch is live, since the platform releases it when the page
   hides), builds the map, then
   `watchPosition(…, { enableHighAccuracy:true, maximumAge:1000, timeout:15000 })`.
2. `onPosition` stores `{lat,lng,alt,speed,acc,ts}`. **Filters**: fixes with accuracy
   worse than `ACC_MAX_M` (50 m) are dropped — never the first fix, the map needs an
   initial position — and a move must clear the fix's own noise floor
   (`max(1, min(acc, 25) × 0.5)` m) before it's kept, so a stationary phone with a 20 m
   lock doesn't random-walk distance upward. Distance accrues per accepted point; the map
   line/dot update and `jumpTo` follows at min zoom 16. A good fix also clears the GPS
   status banner.
3. **Autosave every 15th point** — a crash loses ≤ 14 points.
4. `stopRecording` saves if ≥ 2 points, then fires `autoNameTrip` (`src/places.js:57`)
   which reverse-geocodes both endpoints → "Lyon → Annecy" / "Siena loop", persists, and
   toasts. Manual rename sets `autoNamed=false`, after which auto-naming never touches it
   (`src/places.js:63`). Un-named trips retry on next launch (`src/home.js:255-259`).
5. Discard deletes the autosaved partial if one was written. Both stop and discard run
   through `stopWatching`, which releases the wake lock and hides the banner.

GPS failures surface on the record view itself (`#recordBanner`): `PERMISSION_DENIED`
shows a persistent danger banner ("Location access is blocked…"); `TIMEOUT` /
`POSITION_UNAVAILABLE` show "Searching for GPS…", auto-cleared by the next good fix.

## Playback engine

The heart of the app, and the most-iterated code (see commit history). Three layers:

### 1. Story (`src/story.js`) — pure data

`buildTripStory`/`buildHolidayStory` produce `{ kind, title, displayPoints/legs, events,
chapters, maxMs, paceProfile, … }`. No DOM, no map — playback.js renders it.

- **Compression**: stays (≥ 10 min within a 100 m wandering centroid) and recording gaps
  (≥ 5 min) are squeezed to a fixed ~2.5 s display beat (`EVENT_SYNTH_MS`,
  `story.js:13-17`) and surfaced as events — "Stayed in Siena · 2 nights" or, if endpoints
  are ≥ 300 m apart, a "jump". Playback never idles.
- **Chapters**: "Day N" (multi-day) or "Stage N" segments feed the overview strip and
  scrubber.
- **Pacing**: total viewer time is fitted to a ~150 s budget
  (`STORY_TOTAL_BUDGET_S`, `story.js:195`); the pace profile dips (slows) at detected
  turns (bearing change with real displacement) and at photos, and fast-forwards steady
  stretches — the pace badge in the HUD reflects it.
- **Travel arcs**: unrecorded jumps ≥ 50 km (`ARC_MIN_DIST_M`, `playback.js:246`) play as
  a dashed great-circle-ish arc with the camera pulled out ("Indiana Jones" moment,
  `playback.js:248-307`).

### 2. Camera (`src/camera.js`) — why it is the way it is

One exponentially-damped state (centre + zoom), advanced every frame by `camStep:44` via
`jumpTo` (smooth at any rate on a GL map). The four load-bearing decisions:

1. **Centre is damped in screen pixels, not degrees** (`camera.js:38-43,56-61`).
   Geographic-space lag = speed × tau in metres — invisible zoomed out, several screens
   wide zoomed in. That asymmetry is exactly how zoom-ins used to leave the dot behind.
   Pixel-space damping keeps lag a constant fraction of the viewport at every zoom.
2. **Feed-forward lookahead**: the camera aims where the dot will be one time-constant
   ahead (`FOLLOW_REAL_LOOKAHEAD_MS`, `playback.js:47`; target computed in
   `renderFrame:613`), so the marker rides dead-centre instead of trailing.
3. **`clampToView:74` is a hard guarantee**, not a nicety: if any transient (fast leg,
   manual zoom, deep zoom-in) pushes the dot outside the central 40 % box, the map pans
   the minimum distance to put it back. Never weaken this.
4. **Auto-zoom** (`computeTargetZoom:27`) frames the next ~2.5 s of travel at ~30 % of the
   short screen dimension, clamped to z4–16.

**Gesture semantics** (`playback.js:79-89`): a **drag** means "let me look elsewhere" —
following parks until the next play/seek. A **zoom** (wheel, dblclick, 2-finger) means
"look closer at the action" — following continues; auto-zoom stands aside for 5 s
(`manualZoomUntil`). Disabling follow on zoom was the bug that let the dot sail off-screen;
don't reintroduce it.

**Rendering details that fixed visible bugs**: the playhead/record dot is a **GL circle
layer**, not a DOM marker (`map.js:118-129`) — DOM markers update a beat behind the canvas
and snap to whole pixels, so they slide off the line during zoom. DOM *is* used for photo
pins/pulses, with `subpixelPositioning:true` (`map.js:143-153`). `createMap` resolves by
**polling `isStyleLoaded()`** with a 10 s deadline → raster-fallback swap
(`map.js:59-76`) because `load` waits on first tiles (a hung tile hangs the view) and
`styledata` can fire once mid-load and never again (deadlocks an event wait).

### 3. Frame loop (`src/playback.js`)

`playbackTick:716` advances sim-time by `rate` (continuous, from `baseSpeed` × pace
multiplier × user speed 0.5/1/2×), calls `renderFrame:613` (dot, trace via
`updateTrace:591`, HUD via `setTextIfChanged` throttled by `hudShouldUpdate:606`, banner,
arc, camera step), and handles photo-memory holds: when the playhead reaches a photo's
sim-time, playback glides to a stop, a Ken Burns card shows (same-moment photos within a
90 s synth window cycle as a stack — `MEMORY_GROUP_SPAN_MS`, `playback.js:808-810`), then
eases back in. Photos already shown are tracked in `memoryShownIds` and re-armed on seek
(`rearmMemoriesAfter:904`). End of story → summary card (`showSummary:555`) with route
line, stats, replay/overview.

Two modes, one code path: **overview** (atlas: whole route, chapter strip, clustered
photo-moment pins — `enterOverview:439`) and **playing** (ride-along —
`enterPlaying:463`). Holidays and single trips differ only inside the story object.

### Road alignment (`src/roads.js`) — monotonic by design

`alignTripToRoads:115` runs in the background on playback open (`maybeAlignRoads`,
`playback.js:173`), map-matching driving-speed segments (median ≥ 5.5 m/s) against the
OSRM demo server, ≤ 20 requests per run at 1 req/s.

- Every original point is **projected** onto the matched line (advancing-cursor,
  `projectOntoLine:52`, max pull 60 m), then the road's own vertices are **woven** between
  projected points with distance-interpolated timestamps (`densifySegment:82`) so the
  trace hugs curvature instead of cutting chords.
- **Monotonic**: every run seeds from the coords already stored
  (`roads.js:123-124`) — a failed segment keeps its previous snapping; a run can improve
  the trace but never regress it to raw. Incomplete runs persist as `partial:true` and
  retry after a 10 min cooldown (`roads.js:108-120`). Matches whose length differs from
  the raw distance by > 25 % are rejected as suspicious (`roads.js:151`).
- `ALIGN_V` (`roads.js:108`) is the alignment-quality version: bump it to force one re-run
  per trip after improving the algorithm.
- Results persist on the trip (`trip.roadAlign`); `effectivePoints` (`story.js:108`)
  chooses aligned path vs raw points when building stories.

When alignment lands while the user is on the overview (same story, not playing), the view
currently reloads itself wholesale (`playback.js:181-185`) — ROADMAP A4.

## Photos pipeline

Entry: menu → "Add photos" (batch, `bulkAddPhotos`, `photos.js:61`) or playback "+ Photo"
(anchored to the open trip, `resolvePhotoAnchor`, `playback.js:919`). File picker only —
no `capture` attribute, no in-app camera (ROADMAP B3).

Matching (`matchPhotoToTrip:15`): **time is the primary key** — photo `ts` within a trip's
span ± 10 min buffer (`photos.js:16`); if the photo also has GPS, reject when > 2 km from
the track at that time (`PHOTO_TRACK_MAX_M`, `photos.js:7`). GPS-only photos (no usable
timestamp) match by nearest track point within 250 m (`PHOTO_GPS_ONLY_MAX_M:8`).

EXIF (`src/exif.js`): reads only the first 128 KB; extracts GPS lat/lng,
GPSDate/TimeStamp, DateTimeOriginal, OffsetTimeOriginal. Hardened against real-world junk:
**zeroed GPS blocks** (camera wrote the IFD with location off) must not shadow
DateTimeOriginal (`exif.js:102`), NaN timestamps are nulled (`exif.js:120`). Without an
offset tag, wall-clock times assume the *device's* zone (`exif.js:116`) — wrong for
foreign camera photos (ROADMAP B6).

Storage: raw `Blob`s in the photos store. Object URLs are created in `loadPhotoPins` and
revoked before reload and on leaving the view (`playback.js:772,975`) — keep that
discipline when adding new photo renders.

Display: overview clusters photos into moment pins (`clusterPhotoMoments`,
`playback.js:309`, radius derived from trip bbox); moment sheet → grid → lightbox (with
delete); scrubber shows photo dots and stay ticks.

## Deploy pipeline

GitHub Pages serves the repo. On push to `main` touching app files,
`.github/workflows/stamp-version.yml`:

1. sed-replaces `app.js?v=…` / `style.css?v=…` in `index.html` with the 8-char SHA
   (`stamp-version.yml:30-34`); commits as `[auto-stamp]` (a guard prevents
   self-retrigger);
2. explicitly POSTs a Pages build request with retries — `GITHUB_TOKEN` pushes don't
   trigger Pages builds on their own.

Freshness model: HTML stamps bust `app.js`/`style.css`; **`src/` modules and `sw.js` are
not stamped** — they stay fresh because the SW fetches everything network-first with
`cache:'no-cache'` (forces ETag revalidation past the Pages `max-age=600` HTTP cache,
`sw.js:43-60`). The SW `skipWaiting`s + `clients.claim`s (`sw.js:31-41`), so new versions
take over immediately. The `waypoint-v5` cache name is bumped by hand only when the SW
itself changes meaningfully.

**Adding any file the app loads** ⇒ add it to `sw.js` SHELL (`sw.js:2-29`) in the same
commit. **Renaming `app.js`/`style.css`** ⇒ update the workflow's sed patterns in the same
commit.

## Known fragilities

Each row names the fix that addresses it (see [ROADMAP.md](ROADMAP.md)). Shipped so far:
Phase 0 (0.1–0.6); A1 (history-API back navigation — see § Navigation); A2 (in-theme
`uiConfirm`/`uiAlert` dialogs replace every native `alert`/`confirm`); A3 (modals are
`role=dialog` with focus trap + Escape; the scrubber is a keyboard slider); B1 (GPX
export, `src/gpx.js`); B2 (backup export streams photos as Blob parts — no OOM).

| Where | Symptom | Fix |
|---|---|---|
| `src/playback.js:181-185` | alignment refresh reopens the whole view | A4 |
| `src/import-google.js:53-72` | only on-device Timeline.json shape parses; classic Takeout unsupported | B4 |
| `src/exif.js:116` | no-offset photos assume device timezone; foreign camera photos misplace | B6 |
| `src/roads.js:11-12` | OSRM **demo** server: no SLA; whole feature best-effort | B7 |
| `src/places.js:34` | Nominatim without identification (policy asks for it); silent failure | B7 |
| repo-wide | no tests, no linter — correctness rests on inline reasoning + smoke checklist | mitigated by CLAUDE.md checklist |

Non-issues to not "fix": `window.__wpMaps` (`map.js:56-57`) is a deliberate testing hook;
the dark-only theme is identity, not an oversight; the legacy folder is kept runnable on
purpose (rollback + schema contract).
