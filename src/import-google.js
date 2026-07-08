/* Google Timeline import — the front door for most people's first story: drop in the
 * location history you already have and watch a holiday you'd half forgotten. */
import { pathDistance } from './geo.js';
import { fmtDate, fmtClock, fmtDistance, fmtDuration, escapeHtml } from './format.js';
import { dbPutTrip } from './db.js';
import { snapToRoad, ROAD_PROFILES } from './roads.js';
import { autoNameTrip } from './places.js';
import { showView, setLoading, showToast, registerViewExit, uiAlert } from './views.js';
import { renderHome } from './home.js';

let timelineData = null;
let rawPositions = [];
let candidateTrips = [];

const ACTIVITY_LABELS = {
  WALKING: 'Walk', RUNNING: 'Run', ON_BICYCLE: 'Cycle', CYCLING: 'Cycle',
  IN_PASSENGER_VEHICLE: 'Drive', IN_VEHICLE: 'Drive', IN_BUS: 'Bus', IN_TRAIN: 'Train',
  IN_SUBWAY: 'Subway', IN_TRAM: 'Tram', IN_FERRY: 'Ferry', FLYING: 'Flight',
  IN_ROAD_VEHICLE: 'Drive', IN_RAIL_VEHICLE: 'Train', MOTORCYCLING: 'Ride', UNKNOWN: 'Trip',
};

function parseLatLng(str) {
  const nums = String(str).match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 2) return null;
  return { lat: parseFloat(nums[0]), lng: parseFloat(nums[1]) };
}

/* ---- Google export normalisers -------------------------------------------------------
 * Three shapes reach us: the on-device Timeline.json (rawSignals + semanticSegments), the
 * classic Semantic Location History (timelineObjects), and Records.json (locations[]). We
 * normalise the two classic shapes INTO the on-device internal shape ({rawSignals,
 * semanticSegments}) so indexRawSignals / setupDateRangeView / buildCandidatesForRange stay
 * literally unchanged — new shapes are new branches feeding the same structures. */
const e7 = (v) => (typeof v === 'number' ? v / 1e7 : NaN);
const isoOf = (ms) => new Date(ms).toISOString();

// timestamps come as ISO ("...timestamp") or ms-since-epoch strings ("...timestampMs")
function googleTs(obj, isoKey, msKey) {
  if (obj && obj[isoKey]) { const t = Date.parse(obj[isoKey]); if (!isNaN(t)) return t; }
  if (obj && obj[msKey] != null) { const t = Number(obj[msKey]); if (!isNaN(t)) return t; }
  return NaN;
}

function fromTimelineObjects(objs) {
  const segs = [];
  for (const o of objs) {
    const a = o && o.activitySegment;
    if (!a) continue; // placeVisit is a stay, not a trip — story compression handles those
    const startMs = googleTs(a.duration || {}, 'startTimestamp', 'startTimestampMs');
    const endMs = googleTs(a.duration || {}, 'endTimestamp', 'endTimestampMs');
    if (isNaN(startMs) || isNaN(endMs)) continue;

    // path preference: simplifiedRawPath (has timestamps) > waypointPath (interpolate times)
    let timelinePath = null;
    const srp = a.simplifiedRawPath && a.simplifiedRawPath.points;
    if (Array.isArray(srp) && srp.length >= 2) {
      timelinePath = srp
        .map((p) => ({ point: `${e7(p.latE7)}, ${e7(p.lngE7)}`, time: isoOf(googleTs(p, 'timestamp', 'timestampMs')) }))
        .filter((p) => !p.time.startsWith('Invalid') && !/NaN/.test(p.point));
    }
    if (!timelinePath || timelinePath.length < 2) {
      const wps = a.waypointPath && a.waypointPath.waypoints;
      if (Array.isArray(wps) && wps.length >= 2) {
        const n = wps.length;
        timelinePath = wps
          .map((p, i) => ({ point: `${e7(p.latE7)}, ${e7(p.lngE7)}`, time: isoOf(startMs + (endMs - startMs) * (i / (n - 1))) }))
          .filter((p) => !/NaN/.test(p.point));
      } else {
        timelinePath = null;
      }
    }

    const seg = { startTime: isoOf(startMs), endTime: isoOf(endMs), _normType: a.activityType || 'UNKNOWN' };
    if (timelinePath && timelinePath.length >= 2) {
      seg.timelinePath = timelinePath;
    } else {
      const s = a.startLocation, e = a.endLocation;
      if (!s || !e) continue;
      seg.activity = {
        start: { latLng: `${e7(s.latitudeE7)}, ${e7(s.longitudeE7)}` },
        end: { latLng: `${e7(e.latitudeE7)}, ${e7(e.longitudeE7)}` },
        topCandidate: { type: a.activityType || 'UNKNOWN' },
        distanceMeters: a.distance || a.distanceMeters || null,
      };
    }
    segs.push(seg);
  }
  return { rawSignals: [], semanticSegments: segs };
}

function fromRecords(locations) {
  const positions = [];
  for (const p of locations) {
    const lat = e7(p.latitudeE7), lng = e7(p.longitudeE7);
    const ts = googleTs(p, 'timestamp', 'timestampMs');
    if (isNaN(lat) || isNaN(lng) || isNaN(ts)) continue;
    positions.push({ ts, lat, lng });
  }
  positions.sort((a, b) => a.ts - b.ts);
  const rawSignals = positions.map((p) => ({ position: { LatLng: `${p.lat}, ${p.lng}`, timestamp: isoOf(p.ts) } }));

  // Records.json carries no segments — split the position stream on gaps > 25 min so each
  // continuous run becomes a route candidate (short/stationary runs get filtered by distance).
  const segs = [];
  const GAP_MS = 25 * 60000;
  let runStart = 0;
  for (let i = 1; i <= positions.length; i++) {
    const boundary = i === positions.length || positions[i].ts - positions[i - 1].ts > GAP_MS;
    if (boundary) {
      if (i - runStart >= 2) {
        const run = positions.slice(runStart, i);
        segs.push({
          startTime: isoOf(run[0].ts),
          endTime: isoOf(run[run.length - 1].ts),
          timelinePath: run.map((p) => ({ point: `${p.lat}, ${p.lng}`, time: isoOf(p.ts) })),
        });
      }
      runStart = i;
    }
  }
  return { rawSignals, semanticSegments: segs };
}

// Detect the shape and normalise; returns {rawSignals, semanticSegments} or null if unknown.
function normalizeTimeline(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.semanticSegments) || Array.isArray(data.rawSignals)) {
    return { rawSignals: data.rawSignals || [], semanticSegments: data.semanticSegments || [] };
  }
  if (Array.isArray(data.timelineObjects)) return fromTimelineObjects(data.timelineObjects);
  if (Array.isArray(data.locations)) return fromRecords(data.locations);
  return null;
}

async function loadTimelineFiles(files) {
  setLoading('Reading Timeline file…');
  // Merge across files: classic Takeout ships monthly semantic files, often alongside a
  // Records.json, so accept several and concatenate their normalised structures.
  const merged = { rawSignals: [], semanticSegments: [] };
  let unrecognized = 0;
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      unrecognized++;
      continue;
    }
    const norm = normalizeTimeline(parsed);
    if (!norm) { unrecognized++; continue; }
    merged.rawSignals.push(...norm.rawSignals);
    merged.semanticSegments.push(...norm.semanticSegments);
  }

  if (merged.semanticSegments.length === 0) {
    showView('home');
    const body = unrecognized === files.length
      ? 'None of those files look like a Google export — expected Timeline.json, a Semantic Location History file, or Records.json.'
      : 'No trips were found in that export. Try a Semantic Location History file or Records.json.';
    await uiAlert({ title: 'No trips found', body });
    return;
  }

  timelineData = merged;
  setLoading('Indexing GPS pings…');
  setTimeout(() => {
    indexRawSignals();
    setupDateRangeView();
    showView('daterange');
  }, 30);
}

function indexRawSignals() {
  rawPositions = [];
  const signals = timelineData.rawSignals || [];
  for (const s of signals) {
    const pos = s.position;
    if (!pos) continue;
    const latlngStr = pos.LatLng || pos.latLng;
    if (!latlngStr) continue;
    const ll = parseLatLng(latlngStr);
    if (!ll) continue;
    const ts = Date.parse(pos.timestamp);
    if (isNaN(ts)) continue;
    rawPositions.push({ ts, lat: ll.lat, lng: ll.lng });
  }
  rawPositions.sort((a, b) => a.ts - b.ts);
  for (const seg of timelineData.semanticSegments || []) {
    seg._startMs = Date.parse(seg.startTime);
    seg._endMs = Date.parse(seg.endTime);
  }
}

function rawPositionsBetween(startMs, endMs) {
  let lo = 0, hi = rawPositions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rawPositions[mid].ts < startMs) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < rawPositions.length && rawPositions[i].ts <= endMs; i++) out.push(rawPositions[i]);
  return out;
}

function setupDateRangeView() {
  const segs = timelineData.semanticSegments || [];
  // Single pass, no spread: a decade of history is hundreds of thousands of segments,
  // and spreading that many arguments into Math.min/max blows the call stack.
  let minMs = Infinity, maxMs = -Infinity;
  for (const s of segs) {
    if (isNaN(s._startMs)) continue;
    if (s._startMs < minMs) minMs = s._startMs;
    if (s._startMs > maxMs) maxMs = s._startMs;
  }
  const min = new Date(minMs);
  const max = new Date(maxMs);
  const toInputDate = (d) => d.toISOString().slice(0, 10);

  document.getElementById('timelineSpan').textContent = `${fmtDate(min.getTime())} – ${fmtDate(max.getTime())}`;
  const startInput = document.getElementById('rangeStart');
  const endInput = document.getElementById('rangeEnd');
  startInput.min = toInputDate(min);
  startInput.max = toInputDate(max);
  endInput.min = toInputDate(min);
  endInput.max = toInputDate(max);

  const defaultEnd = new Date(max);
  const defaultStart = new Date(max.getTime() - 13 * 86400000);
  startInput.value = toInputDate(defaultStart < min ? min : defaultStart);
  endInput.value = toInputDate(defaultEnd);
}

function buildCandidatesForRange(startMs, endMs) {
  const segs = timelineData.semanticSegments || [];
  const candidates = [];

  for (const seg of segs) {
    if (seg._startMs == null || seg._startMs < startMs || seg._startMs > endMs) continue;

    let points = null;
    let typeLabel = 'Route';
    let fallbackDistance = null;
    let needsRoadSnap = false;

    if (seg.timelinePath && seg.timelinePath.length >= 2) {
      points = seg.timelinePath
        .map((p) => {
          const ll = parseLatLng(p.point);
          if (!ll) return null;
          return { lat: ll.lat, lng: ll.lng, ts: Date.parse(p.time) };
        })
        .filter(Boolean);
    } else if (seg.activity) {
      const startLL = parseLatLng(seg.activity.start?.latLng || '');
      const endLL = parseLatLng(seg.activity.end?.latLng || '');
      if (!startLL || !endLL) continue;
      const enriched = rawPositionsBetween(seg._startMs, seg._endMs).map((p) => ({ lat: p.lat, lng: p.lng, ts: p.ts }));
      if (enriched.length >= 2) {
        points = enriched;
      } else {
        points = [
          { lat: startLL.lat, lng: startLL.lng, ts: seg._startMs },
          { lat: endLL.lat, lng: endLL.lng, ts: seg._endMs },
        ];
        needsRoadSnap = true;
      }
      typeLabel = ACTIVITY_LABELS[seg.activity.topCandidate?.type] || 'Trip';
      fallbackDistance = seg.activity.distanceMeters || null;
    } else {
      continue;
    }

    if (!points || points.length < 2) continue;

    // normalised classic segments carry the activity type even on the timelinePath branch
    if (seg._normType && ACTIVITY_LABELS[seg._normType]) typeLabel = ACTIVITY_LABELS[seg._normType];

    let distance = fallbackDistance;
    if (distance == null) distance = pathDistance(points);
    if (distance < 20) continue;

    candidates.push({
      key: `${seg._startMs}-${seg._endMs}`,
      name: `${typeLabel} · ${fmtDate(seg._startMs)}`,
      startTime: seg._startMs,
      endTime: seg._endMs,
      points,
      distance,
      typeLabel,
      needsRoadSnap: needsRoadSnap && !!ROAD_PROFILES[typeLabel],
    });
  }

  candidates.sort((a, b) => b.startTime - a.startTime);
  return candidates;
}

function renderCandidateList() {
  const list = document.getElementById('candidateList');
  list.innerHTML = '';
  if (candidateTrips.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="glyph">&#9737;</div><p>No trips found in that date range. Try widening it.</p></div>`;
  }
  candidateTrips.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = 'candidate-card';
    row.innerHTML = `
      <input type="checkbox" data-idx="${i}" class="candidateCheck" />
      <div>
        <div class="c-name">${escapeHtml(c.name)}${c.needsRoadSnap ? ' <span class="road-tag">will snap to roads</span>' : ''}</div>
        <div class="c-meta">
          <span>${fmtClock(c.startTime)}–${fmtClock(c.endTime)}</span>
          <span>${fmtDistance(c.distance)}</span>
          <span>${fmtDuration((c.endTime - c.startTime) / 1000)}</span>
          <span>${c.points.length} pts</span>
        </div>
      </div>`;
    list.appendChild(row);
  });
  updateImportButtonCount();
}

function updateImportButtonCount() {
  const n = document.querySelectorAll('.candidateCheck:checked').length;
  document.getElementById('importSelectedBtn').textContent = `Import selected (${n})`;
}

async function importSelectedCandidates() {
  const checks = [...document.querySelectorAll('.candidateCheck:checked')];
  if (checks.length === 0) return;
  setLoading('Saving trips…');
  let done = 0;
  const saved = [];
  for (const chk of checks) {
    const c = candidateTrips[Number(chk.dataset.idx)];
    let points = c.points;
    let distance = c.distance;
    if (c.needsRoadSnap) {
      setLoading(`Snapping to roads (${done + 1}/${checks.length})…`);
      const snapped = await snapToRoad(points, c.typeLabel);
      if (snapped !== points) {
        points = snapped;
        distance = pathDistance(points);
        await new Promise((r) => setTimeout(r, 1100)); // respect the free OSRM demo server's 1 req/sec limit
      }
    } else {
      setLoading(`Saving trips (${done + 1}/${checks.length})…`);
    }
    const trip = {
      id: 'tl-' + c.key,
      name: c.name,
      autoNamed: true,
      typeLabel: c.typeLabel,
      startTime: c.startTime,
      endTime: c.endTime,
      points,
      distance,
    };
    await dbPutTrip(trip);
    saved.push(trip);
    done++;
  }
  showView('home');
  renderHome();
  // names resolve in the background: "Drive · Jul 3" becomes "Drive · Lyon → Annecy"
  for (const t of saved) autoNameTrip(t, () => renderHome());
  if (saved.length) showToast(`${saved.length} trip${saved.length === 1 ? '' : 's'} imported.`);
}

export function initImport() {
  document.getElementById('timelineFileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) loadTimelineFiles(files);
  });
  // Back buttons defer to history so the OS back button walks the same two-step flow
  document.getElementById('dateRangeBackBtn').addEventListener('click', () => history.back());
  registerViewExit('daterange', () => { timelineData = null; });
  document.getElementById('findTripsBtn').addEventListener('click', () => {
    const startVal = document.getElementById('rangeStart').value;
    const endVal = document.getElementById('rangeEnd').value;
    if (!startVal || !endVal) { uiAlert({ title: 'Pick a date range', body: 'Choose both a start and end date.' }); return; }
    const startMs = new Date(startVal + 'T00:00:00').getTime();
    const endMs = new Date(endVal + 'T23:59:59').getTime();
    if (endMs < startMs) { uiAlert({ title: 'Check the dates', body: 'The end date is before the start date.' }); return; }
    setLoading('Finding trips…');
    setTimeout(() => {
      candidateTrips = buildCandidatesForRange(startMs, endMs);
      renderCandidateList();
      showView('import-list');
    }, 20);
  });
  document.getElementById('importListBackBtn').addEventListener('click', () => history.back());
  document.getElementById('selectAllBtn').addEventListener('click', (e) => {
    const boxes = document.querySelectorAll('.candidateCheck');
    const allChecked = [...boxes].every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !allChecked));
    e.target.textContent = allChecked ? 'Select all' : 'Deselect all';
    updateImportButtonCount();
  });
  document.getElementById('candidateList').addEventListener('change', (e) => {
    if (e.target.classList.contains('candidateCheck')) updateImportButtonCount();
  });
  document.getElementById('importSelectedBtn').addEventListener('click', importSelectedCandidates);
}
