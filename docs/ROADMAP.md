# Waypoint roadmap

Goal: **maximise the feel and the functionality of the app, without regressions.**

This roadmap is written for a fresh session picking up any single item with zero prior
context. Read [CLAUDE.md](../CLAUDE.md) first (hard invariants), and
[HANDOVER.md](HANDOVER.md) when an item touches the playback engine or data model.

Structure: **Phase 0** (correctness fixes — do these first, they're small and everything
else builds on a reliable core), then two balanced tracks of equal weight — **Track A:
Feel** (polish what exists) and **Track B: Functionality** (new capabilities). Within a
track, items are ordered by impact-per-effort. A sensible cadence is to alternate: one
Track A item, one Track B item.

Every item lists: why, where, how, regression risk, and acceptance criteria. **Every item
must pass the smoke checklist in CLAUDE.md before merge.** File:line anchors were verified
against `main` @ `d6bf3d5`; re-verify before editing.

---

## Phase 0 — Foundations & correctness

> **Status: shipped** (all six items, branch `claude/docs-review-65vvla`). Kept here for
> the rationale and acceptance criteria; the on-device parts of the acceptance tests
> (wake lock on a real phone, an outdoor test walk for the accuracy gate) still deserve a
> pass before relying on them in the field.

### 0.1 Surface geolocation failures during recording

- **Why**: A GPS error mid-recording is invisible today — the error message goes into a
  tooltip nobody hovers (`src/record.js:89-91`). A permission denial or timeout means the
  trip silently stops gaining points while the user keeps walking. This is the app's core
  loop failing without telling anyone.
- **Where**: `src/record.js`, `index.html` (record view), `style.css`.
- **How**: In `onPositionError`, show an in-view banner on the record screen (reuse the
  `leg-banner` visual language from playback, or a variant of `.toast`): distinguish
  `PERMISSION_DENIED` ("Location access is blocked — enable it in your browser settings")
  from `TIMEOUT`/`POSITION_UNAVAILABLE` ("Searching for GPS…", auto-clears on the next good
  fix in `onPosition`). Also fix the unsupported-browser fall-through: `startRecording`
  alerts but doesn't return or tear down when `geolocation` is missing
  (`src/record.js:26-29`) — return to home instead of starting a dead stat timer.
- **Regression risk**: Low. Purely additive UI; don't touch the point pipeline.
- **Accept**: Deny location permission → start recording → visible, accurate banner within
  15 s. Grant it again → banner clears when fixes resume. Points/distance behavior for a
  healthy recording is byte-identical.

### 0.2 Screen Wake Lock while recording

- **Why**: `navigator.wakeLock` is never used (verified: zero references). When the screen
  sleeps, mobile browsers throttle or stop `watchPosition` — long recordings get holes or
  die. This is the single biggest reliability win available.
- **Where**: `src/record.js`.
- **How**: Acquire `navigator.wakeLock.request('screen')` in `startRecording` (after the
  geolocation check), guarded with feature detection and try/catch (it can reject on low
  battery). The platform auto-releases the lock when the page is hidden, so re-acquire on
  `visibilitychange` → `visible` *while a recording is active*. Release in `stopWatching`
  so both stop and discard paths clean up. Optionally show a subtle "screen will stay on"
  note on the record view the first time.
- **Regression risk**: Low. Feature-detected and try/caught; browsers without support
  behave exactly as today.
- **Accept**: Recording on a phone with default screen-timeout: screen stays on. Lock
  released after stop/discard (screen sleeps normally on home). No errors on desktop
  browsers without wake-lock support.

### 0.3 GPS accuracy gating

- **Why**: Every fix is stored regardless of quality — `acc` is captured
  (`src/record.js:65`) but the only filter is "moved ≥ 1 m" (`src/record.js:71`). A bad
  lock (indoors, urban canyon) sprays jitter that inflates distance and wobbles the trace.
  Note `roads.js` already trusts `acc` for its match radius (`src/roads.js:35`) — recording
  should use it too.
- **Where**: `src/record.js` (`onPosition`).
- **How**: Drop fixes with `pos.coords.accuracy > ACC_MAX` (start at 50 m; make it a named
  constant with a comment). Additionally, require the move distance to exceed the fix's
  accuracy-implied noise floor before accruing distance — e.g.
  `d < Math.max(1, Math.min(p.acc, 25) * 0.5) → return` — so a stationary phone with 20 m
  accuracy doesn't random-walk distance upward. Keep storing `acc` on accepted points.
- **Regression risk**: **Medium** — too aggressive a gate loses real points (dense urban
  recording legitimately runs 20–40 m accuracy). Mitigate: generous default (50 m), never
  gate the *first* fix (the map needs an initial position), and test-walk before merging.
- **Accept**: Stationary indoor phone for 5 min → distance stays ≈ 0 (today it creeps).
  A normal outdoor walk records visually identical to before.

### 0.4 Fix the `Math.min(...starts)` crash on large Timeline files

- **Why**: `setupDateRangeView` spreads every semantic-segment start into
  `Math.min`/`Math.max` (`src/import-google.js:88-90`). A decade of Google history is
  hundreds of thousands of segments — spreading that many arguments throws
  `RangeError: Maximum call stack size exceeded`, killing the import at its first step.
- **Where**: `src/import-google.js:86-105`.
- **How**: Single `for` loop (or `reduce`) computing min and max in one pass.
- **Regression risk**: None — identical output.
- **Accept**: Import with a synthetic Timeline.json containing 500 k segments reaches the
  date-range view. Small files behave identically.

### 0.5 Cache the IndexedDB connection

- **Why**: Every DB call opens a fresh connection (`src/db.js:6`), including the every-15th
  -point autosave during recording (`src/record.js:86`).
- **Where**: `src/db.js`.
- **How**: Memoize the open promise in a module-level variable; reset it on the
  connection's `onclose`/`onversionchange` (so a backup/restore in another tab or a future
  version bump can't deadlock against a held connection). All existing helper signatures
  stay identical.
- **Regression risk**: Low, but handle `onversionchange` (close + null the cache) or a
  second tab could hang on upgrade.
- **Accept**: Full smoke checklist passes; two tabs open simultaneously both read/write.

### 0.6 Guard the SW shell list in CI

- **Why**: `sw.js` SHELL is hand-maintained (`sw.js:2-29`); forgetting to add a new module
  breaks offline silently — nobody notices until they're on a plane.
- **Where**: `.github/workflows/stamp-version.yml` (new job or step).
- **How**: A shell-script step that extracts `./src/*.js` entries from `sw.js` and diffs
  against `ls src/*.js`; also greps that `index.html`'s stylesheet/script names appear.
  Fail the workflow with a message naming the missing file. Pure CI — zero app code.
- **Regression risk**: None (CI-only). Make sure it runs on PR branches too, not just main.
- **Accept**: Deleting a line from SHELL makes CI fail with the filename in the message;
  restoring it passes.

---

## Track A — Feel

### A1. History-API back navigation  — ✅ shipped

- **Why**: The single biggest feel defect. There is zero `pushState`/`popstate`/`hashchange`
  usage (verified), so Android's system back (and browser back) **exits the PWA** instead
  of going record→home, playback→home, or closing an open modal. For an installed app this
  feels broken.
- **Where**: `src/views.js` (the choke point — `showView:2`, `openModal:12`,
  `closeModal:16`), small touches in each view's back-button handler.
- **How**: Keep it tiny and inside `views.js`:
  - `showView(name)` pushes `{view: name}` history state when navigating *away from* home
    (home itself is the root state — never push it, use `replaceState`).
  - `openModal(id)` pushes `{modal: id}`; `closeModal` calls `history.back()` when the top
    state is its own modal (guard against double-pop).
  - One `popstate` listener maps state → `showView`/`closeModal`. Physical back buttons in
    the UI become `history.back()` calls so both paths converge on one handler.
  - **Careful cases**: mid-recording back must still show the discard confirm — intercept
    in the popstate handler by re-pushing state and delegating to the existing confirm flow
    (`src/record.js:130-141`); the import flow's two steps (`daterange` → `import-list`)
    should each be a history entry; `setLoading`/`view-loading` must NOT be a history entry.
- **Regression risk**: **Medium.** History bugs manifest as double-back, stuck views, or
  broken discard confirms. Mitigate: all logic in `views.js`, an explicit state machine
  (view stack is at most home → X → modal), and manually walk every route: home→record→back,
  home→playback→modal→back→back, import both steps, mid-playback back while playing.
- **Accept**: Android/browser back from every view returns to the previous view; back on
  home exits the app (normal PWA behavior); back with a modal open closes just the modal;
  back mid-recording asks to discard; forward-nav after back doesn't duplicate views.

### A2. Replace `alert()`/`confirm()` with in-theme dialogs  — ✅ shipped

- **Why**: The app has a strong, coherent visual identity, then punctures it with browser
  chrome at the most emotional moments — deleting a trip, discarding a recording, a failed
  import. `confirm()` in `src/record.js:128,131`, `src/playback.js` (delete trip/holiday),
  `src/home.js` (bulk delete); `alert()` in `src/backup.js:61,65`,
  `src/import-google.js:47`, `src/playback.js:119,138`, `src/record.js:27`.
- **Where**: `src/views.js` (new helpers), `index.html` (one generic dialog sheet),
  callers above.
- **How**: One reusable `.modal-sheet` (`#confirmSheet`) + two promise-returning helpers in
  views.js: `uiConfirm({title, body, confirmLabel, danger}) → Promise<boolean>` and
  `uiAlert({title, body})`. Style with existing tokens/classes (`.btn-primary`,
  `.btn-ghost`, `.btn-danger-ghost` — see `index.html:36` for the danger pattern). Swap
  call sites mechanically (`if (confirm(…))` → `if (await uiConfirm(…))`; note some callers
  become async). Destructive confirms get the danger treatment.
- **Regression risk**: Low-medium. The subtlety is that `confirm()` was synchronous and
  modal; the promise version must disable the triggering flow while open (the backdrop
  already blocks pointer events). Do A1 first or coordinate: the new dialogs should
  participate in modal back-button handling.
- **Accept**: No native `alert`/`confirm` remains (grep is clean). Every destructive action
  still requires explicit confirmation. Cancel paths leave state untouched.

### A3. Modal & scrubber accessibility

- **Why**: Modals are plain divs — no `role="dialog"`, no focus trap, no Escape-to-close;
  the story scrubber is pointer-only (`.story-scrubber`, built in `src/playback.js`
  `buildScrubber`). Keyboard/screen-reader users can't operate the app's core surfaces.
- **Where**: `index.html` (attributes), `src/views.js` (`openModal`/`closeModal` gain focus
  management + Escape), `src/playback.js` (scrubber), `style.css` (visible focus ring on
  scrubber thumb).
- **How**:
  - Modals: add `role="dialog"` `aria-modal="true"` and `aria-labelledby` pointing at each
    sheet's `<h2>`. In `openModal`: remember `document.activeElement`, focus the first
    focusable child, trap Tab within the sheet, close on Escape; restore focus in
    `closeModal`. All in views.js so every modal gets it for free.
  - Scrubber: `role="slider"`, `tabindex="0"`, `aria-valuemin/max/now` (percent of story),
    `aria-valuetext` (the readout clock), ArrowLeft/Right seek ±2 % (with Shift ±10 %),
    Home/End to ends. Space on the playback view toggles play (don't steal Space while a
    text input or modal has focus).
- **Regression risk**: Low. Pointer interactions unchanged; keyboard paths are additive.
  Watch for focus-trap fighting with A2's dialogs (share the implementation).
- **Accept**: Tab-only walkthrough: open a trip, play/pause with Space, seek with arrows,
  open and close the moment sheet and lightbox with Enter/Escape, focus returns to the
  invoking element. Pointer behavior unchanged.

### A4. In-place refresh when road alignment lands

- **Why**: When background alignment finishes while the user is browsing the overview, the
  app re-runs the whole `openPlayback`/`openHolidayPlayback` (`src/playback.js:181-185`) —
  re-reading the DB, rebuilding the story, resetting layers, refitting bounds. It's a
  visible blink and it discards scroll/selection state in the chapter strip.
- **Where**: `src/playback.js` (`maybeAlignRoads` and a new narrow refresh path).
- **How**: Rebuild only what alignment changes: re-run `buildTripStory`/`buildHolidayStory`
  on the updated trips, then update the `ghost`/`chapters` line sources via
  `setMultiLine`/`setFeatures`, rebuild the scrubber, and re-render the storyline strip —
  without `showView`, `fitBounds`, or camera reset. Keep the existing guard (only when
  `sameView && overview && !playing`, `src/playback.js:181-182`); never swap the path
  mid-ride.
- **Regression risk**: Medium — `story` is shared mutable state read by the render loop.
  Mitigate by keeping the swap synchronous (build the new story fully, then assign) and by
  leaving the current "reopen" as the fallback if anything in the narrow path can't
  reconcile (e.g. active chapter index out of range).
- **Accept**: Open an unaligned trip, wait for alignment on the overview: the trace
  visibly improves with no view blink, no camera jump, no strip scroll reset. Playing
  during alignment: nothing changes until the next open (existing behavior).

### A5. Desktop & tablet layout

- **Why**: The app is mobile-first and looks it on a laptop — the only media query is
  `prefers-reduced-motion` (`style.css:795`). Wide screens get a stretched phone layout.
  Trips are lovely to rewatch at a desk; this is cheap delight.
- **Where**: `style.css` only (plus `map.resize()` calls already exist where needed).
- **How**: One breakpoint (`@media (min-width: 900px)`): home becomes a centered
  max-width column or two-column card grid; playback puts the map full-bleed with the
  player panel as a floating card (it's already absolutely positioned — mostly max-width
  and inset changes); modals get a max-width and centered position (already close). Do not
  change any DOM. Verify the map still resizes correctly when the panel geometry changes.
- **Regression risk**: Low if strictly additive under the media query — the mobile
  stylesheet path must not change at all. Diff-review that every rule is inside the query.
- **Accept**: At 1280×800: no stretched full-width buttons, playback readable with map
  dominant. At 390×844 (phone): pixel-identical to before (screenshot compare).

### A6. Self-host the fonts

- **Why**: Space Grotesk + Space Mono load from fonts.googleapis.com
  (`index.html:12-13`) — the one remaining third-party, render-blocking dependency, and a
  hole in the offline story (offline first-paint falls back to system fonts and the app
  looks different).
- **Where**: `vendor/fonts/` (new), `style.css` (`@font-face`), `index.html` (drop the two
  `<link>`s), `sw.js` SHELL (add the font files — invariant #3).
- **How**: Download the woff2 files for the used weights (Grotesk 500/700, Mono 400),
  `@font-face` with `font-display: swap`, preload the two most-used files. Subset to
  latin if size matters.
- **Regression risk**: Low. Visual check that weights map correctly (500 vs 700).
- **Accept**: No requests to fonts.googleapis/gstatic; offline reload renders the correct
  faces; Lighthouse shows no render-blocking font CSS.

### A7. (Optional, flagged) Intent-based auto-zoom resume

- **Why**: After a manual zoom during playback, auto-zoom resumes on a fixed 5 s timer
  (`manualZoomUntil`, `src/playback.js:84`) regardless of what the user wanted. Sometimes
  it yanks the zoom back while they're still looking.
- **Honest note**: this is the most-iterated code in the app (see commit history: "Follow
  camera: damp in screen space…", "Lock the dot to the line through zooms"). The current
  behavior is *good*. Only attempt with a device in hand and time to feel-test; sliding
  the timeout to ~8 s or resetting it on further zoom activity may be the entire fix.
- **Regression risk**: **High** relative to its payoff. Read HANDOVER.md § Playback engine
  first. If in doubt, skip — nothing else depends on this.
- **Accept**: Pinch-zoom during play → camera keeps following at the user's zoom; zoom
  doesn't snap back while the user is still interacting; the dot still never leaves the
  screen (that guarantee lives in `clampToView`, `src/camera.js:74` — do not weaken it).

---

## Track B — Functionality

### B1. GPX export (trip and holiday)  — ✅ shipped

- **Why**: The data is locked in. GPX is the lingua franca — one export unlocks Strava,
  Garmin, Google Earth, and peace of mind. Pure client-side, zero regression surface,
  high perceived value.
- **Where**: new `src/gpx.js`; menu entries in the playback topbar (next to
  Rename/Delete, `index.html:73-76`) and/or the home menu sheet.
- **How**: Build a GPX 1.1 `<trk>` per trip, one `<trkseg>` per movement segment (reuse
  `movementSegments` from `src/story.js`, already exported — `src/roads.js:8` imports it),
  `<trkpt lat lon><ele><time>` from each point's `alt`/`ts`. Export the **raw recorded
  points**, not the road-aligned path (the aligned path has synthetic timestamps and is a
  presentation artifact; a comment should say so). Holiday export = one GPX with one `<trk>`
  per trip. Reuse the download pattern from `src/backup.js:45-52`. Photos as `<wpt>`
  entries with name + time for photos that have GPS.
- **Regression risk**: None — additive, read-only over the DB.
- **Accept**: An exported trip opens in gpx.studio / Google Earth with correct route,
  times, and elevations; a holiday exports all member trips; filenames are the trip name,
  sanitized.

### B2. Backup format v2 — chunk-safe export

- **Why**: Export base64-encodes every photo blob and serializes the *entire* dataset into
  one in-memory JSON string (`src/backup.js:31-45`). A few hundred photos → hundreds of MB
  of string → mobile tab OOM. The safety net fails exactly when it matters (big libraries).
- **Where**: `src/backup.js`.
- **How**: Keep JSON, assemble incrementally: build the backup as an **array of parts**
  passed to `new Blob([...parts])` — metadata header, then each photo as its own
  pre-stringified chunk (base64 per photo is fine; the killer is one giant string, not
  base64 itself). Never hold more than one photo's encoding in memory at a time (encode →
  push part → release). Bump `BACKUP_VERSION` to 2 only if the *shape* changes; if the
  on-disk shape stays `{app, version, trips, collections, photos, places}` this is purely
  an internal streaming change and the version stays 1. **Restore must read every version
  ever shipped, forever** — add a version switch even if both paths currently converge.
  Consider `showToast` progress ("Packing photo 40/200…") via the existing loading view.
- **Regression risk**: Medium — this is the user's disaster-recovery path. Mitigate: after
  writing the new export, restore it in the same session and diff counts; keep a copy of a
  v1 file in your test flow to prove old backups still restore.
- **Accept**: Export with 200+ photos (synthesize blobs in a test page) completes without
  a memory spike; the file restores on a fresh profile; a pre-change v1 backup file still
  restores correctly.

### B3. Native camera capture

- **Why**: Photos are file-picker-only (`index.html:41,108` — no `capture` attribute, no
  in-app camera). Mid-trip, "take a photo now and pin it here" is the natural gesture.
- **Where**: `index.html`, `src/photos.js` / `src/playback.js` (+ `src/record.js` for a
  capture button while recording).
- **How**: Two steps, ship the first alone if needed:
  1. Add a second hidden input with `capture="environment"` and a "Take photo" option
     beside "Add photos" (menu + playback `+ Photo`). On capture during an active
     recording, geotag from `currentTrip`'s latest point and stamp `ts = Date.now()` so
     matching is exact even though the camera app writes no EXIF GPS.
  2. (Later, optional) `getUserMedia` in-app viewfinder — only if the capture-attribute
     flow proves too clunky; it drags in permissions and lifecycle complexity.
- **Regression risk**: Low for step 1 — additive input path into the existing
  `bulkAddPhotos`/photo pipeline.
- **Accept**: On Android/iOS, "Take photo" opens the camera directly; the shot lands on
  the active recording (or matches by time to the open trip) at the right map position.

### B4. Broader Google import (classic Takeout formats)

- **Why**: The importer parses only the on-device Timeline.json shape — `rawSignals[]`
  and `semanticSegments[]` (`src/import-google.js:53-72`). Users arriving with classic
  Takeout archives (`Semantic Location History/*.json` monthly files, `Records.json`) hit
  "no trips found" with no explanation.
- **Where**: `src/import-google.js` (parsing layer only — candidate list, range view, and
  import flow are format-agnostic once data is normalized).
- **How**: Detect the shape after JSON.parse: `timelineObjects` → classic semantic history
  (`activitySegment` with `startLocation`/`waypointPath`/`simplifiedRawPath`,
  `placeVisit` for stays); `locations[]` → Records.json (E7 coords, timestamps; becomes
  rawPositions equivalent). Normalize each into the existing internal candidates
  (`{ts, lat, lng}` positions + segments with start/end/type) so everything downstream is
  untouched. Multi-file: accept multiple selected files and concatenate (monthly files are
  per-month). Show a friendly error naming what the file *is* when unrecognized.
- **Regression risk**: Low-medium — keep the current shape's code path literally unchanged;
  new shapes are new branches feeding the same normalized structures.
- **Accept**: All three shapes import: current Timeline.json (unchanged behavior),
  a classic monthly semantic file, and a Records.json slice. Unrecognized JSON produces a
  named, in-theme error (pairs with A2), not a dead end.

### B5. Elevation & speed profile in the overview

- **Why**: `alt` and `speed` are recorded on every point (`src/record.js:63-64`) and never
  shown anywhere. A profile strip turns dead data into one of the most-loved tracker
  features (that climb, that descent, that fast stretch).
- **Where**: `src/playback.js` (overview panel, `#overviewPanel` `index.html:100-106`),
  possibly a small pure helper in `src/story.js`; `style.css`.
- **How**: An inline SVG strip (follow the `sparklineSvg` pattern, `src/home.js:15`) under
  the storyline strip: elevation area fill + speed line, x = story time so it aligns with
  the scrubber/chapters. Downsample via `downsampleByDistance` (`src/geo.js`). Handle nulls
  (imported Google points have no `alt`/`speed` — hide the strip when < 50 % of points have
  data). Tapping the profile seeks playback (reuse scrubber seek logic).
- **Regression risk**: Low — additive render in the overview; no playback-loop changes.
- **Accept**: A recorded hilly trip shows a sensible profile aligned with the scrubber;
  a Google-imported trip without altitude shows no broken/empty strip; tap-to-seek works.

### B6. EXIF timezone from GPS position

- **Why**: A photo with `DateTimeOriginal` but no `OffsetTimeOriginal` is assumed to be in
  the *device's current* timezone (`src/exif.js:116`). Photos from a standalone camera
  used abroad land hours off and match the wrong trip moment — the failure is silent and
  confusing.
- **Where**: `src/photos.js` (matching layer — keep `src/exif.js` a pure parser).
- **How**: When a photo has GPS + a no-offset wall-clock time, estimate the zone from
  longitude (`round(lng/15)` hours) and use that instead of the device zone; better, when
  matching against a specific trip, derive the trip's own UTC offset by comparing its
  points' `ts` to the photo cluster and prefer consistency. Keep the ±10 min buffer
  (`src/photos.js:16`) as the tolerance. Flag low-confidence matches in the toast
  ("2 matched by location — check their timing").
- **Regression risk**: Medium — photo matching already handles several tricky cases
  (zeroed GPS blocks, NaN timestamps — see `src/exif.js:102,120`). Only change the
  *no-offset-tag* branch; photos with an offset tag or GPS timestamps must take exactly
  the current path.
- **Accept**: A test photo with GPS in Italy, wall-clock time, no offset tag, imported on
  a UTC-5 device, matches the Italian trip at the correct moment. Phone photos with offset
  tags match exactly as before.

### B7. Service endpoint configuration + Nominatim identification

- **Why**: Road alignment and 2-point routing ride the **OSRM demo server**
  (`src/roads.js:11-12`, explicitly no-SLA) and reverse geocoding hits Nominatim without
  the identification its usage policy asks for (`src/places.js:34` — browsers can't set
  User-Agent, so an `email=` query param is the sanctioned alternative). If either service
  blocks the app, features degrade permanently and silently.
- **Where**: new `src/config.js` (a dozen lines), `src/roads.js`, `src/places.js`,
  `src/map.js` (style URL too, while at it).
- **How**: A single `config.js` exporting the four endpoint constants + optional
  `NOMINATIM_EMAIL`, reading overrides from `localStorage('waypoint-config')` so a
  self-hosted OSRM/Nominatim can be pointed at without code changes. Append
  `&email=…` to the Nominatim URL when configured. Document self-hosting pointers in
  HANDOVER.md. No settings UI needed yet — localStorage is fine for a power-user escape
  hatch.
- **Regression risk**: Low — same URLs by default; pure indirection.
- **Accept**: Default behavior identical (diff the request URLs); setting a localStorage
  override redirects roads/places calls; malformed overrides fall back to defaults.

### B8. Ambitious / later

Parked deliberately — each needs design time and carries real risk; none should be picked
up before the tracks above are substantially done:

- **Battery-aware recording profile**: drop to lower-accuracy watch settings on low
  battery (Battery Status API is Chrome-only; feature-detect). Touches the core recording
  loop — pair with 0.3 and test on-device.
- **Shareable trip film**: render playback to a video (WebCodecs/MediaRecorder capturing
  the GL canvas + photo overlays). Big feature, big payoff — a trip you can send to the
  group chat. Needs a design pass on framing, duration, and audio.
- **GPX/KML import**: complements B1; normalizes into the same trip shape as B4.
- **Light theme / auto theme**: the dark "field atlas" is identity — only with real design
  intent, never as a mechanical inversion.

---

## Anti-regression appendix

The invariants live in [CLAUDE.md](../CLAUDE.md); this is the per-area "how you'd break it
without noticing" list. Check the relevant row before merging each item.

| Area | You break it by… | Guard |
|---|---|---|
| DB schema (`src/db.js`) | renaming/transforming stores or fields; writes legacy can't read | Create-only upgrades; new fields optional; smoke-test in `legacy/` after schema-adjacent changes |
| SW shell (`sw.js:2-29`) | adding a file (module, font) without listing it | 0.6 CI guard; offline smoke step |
| Version stamping | hand-editing `?v=`, renaming `app.js`/`style.css`, breaking the sed patterns in `stamp-version.yml:30-34` | never touch stamps by hand; if renaming assets, update the workflow in the same commit |
| Follow camera & playhead | damping in degrees, DOM-marker playhead, disabling follow on zoom, waiting on map `load` | Read HANDOVER.md § Playback engine; the four invariants are commented at `src/camera.js:38-43`, `src/map.js:118-122`, `src/playback.js:79-89`, `src/map.js:59-63` |
| Road alignment monotonicity | starting a re-run from raw coords instead of seeding from `trip.roadAlign.coords` (`src/roads.js:123-124`); dropping the `partial` retry state | a failed run must never make a trace worse; keep the 0.75–1.25× distance sanity check (`src/roads.js:151`) |
| Graceful degradation | any new fetch without timeout/catch/fallback; any feature that hangs offline | copy the patterns: `src/map.js:25-27` (abort timer), `src/roads.js:44-46` (null on failure), `src/places.js:44-46` (silent retry-later) |
| Rate limits | parallelizing OSRM/Nominatim calls | keep the 1.1 s serializers (`src/roads.js:37`, `src/places.js:42`) |
| XSS | interpolating user text into `innerHTML` without `escapeHtml` | it's the only free text: trip/holiday names; grep new `innerHTML` sinks |
| Reduced motion | new animations outside the `style.css:795` block | add every new animation to the reduced-motion reset |
| Mobile layout | desktop styles leaking outside the A5 media query | phone-width screenshot compare |

**Merge bar for every item**: the CLAUDE.md smoke checklist passes, the relevant guard row
above is checked, and — for anything touching playback/camera — a real-device feel test.
