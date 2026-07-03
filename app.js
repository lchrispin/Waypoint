/* ---------- IndexedDB ---------- */
const DB_NAME = 'waypointDB';
const STORE = 'trips';

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(trip) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(trip);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startTime - a.startTime));
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- helpers ---------- */
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function fmtDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---------- view switching ---------- */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

/* ================= HOME ================= */
async function renderHome() {
  const trips = await dbGetAll();
  const list = document.getElementById('tripList');
  list.innerHTML = '';
  if (trips.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="glyph">&#9737;</div>
      <p>No trips yet. Tap "Record trip" and your route will be logged and ready to replay.</p></div>`;
    return;
  }
  trips.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'trip-card';
    const dur = t.endTime ? fmtDuration((t.endTime - t.startTime) / 1000) : '—';
    card.innerHTML = `
      <div class="trip-name">${escapeHtml(t.name)}</div>
      <div class="trip-meta">
        <span>${fmtDate(t.startTime)}</span>
        <span>${fmtDistance(t.distance || 0)}</span>
        <span>${dur}</span>
        <span>${(t.points || []).length} pts</span>
      </div>`;
    card.addEventListener('click', () => openPlayback(t.id));
    list.appendChild(card);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ================= RECORDING ================= */
let recordMap, recordLine, recordMarker, watchId, currentTrip, statTimer;

function openNameModal() {
  document.getElementById('tripNameInput').value = `Trip · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  document.getElementById('nameModal').classList.add('active');
}
function closeNameModal() {
  document.getElementById('nameModal').classList.remove('active');
}

function startRecording() {
  const name = document.getElementById('tripNameInput').value.trim() || 'Untitled trip';
  closeNameModal();

  currentTrip = { id: String(Date.now()), name, startTime: Date.now(), endTime: null, points: [], distance: 0 };

  showView('record');
  setupRecordMap();
  resetStats();

  if (!('geolocation' in navigator)) {
    alert('This browser has no location support.');
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });

  statTimer = setInterval(updateElapsedStat, 1000);
}

function setupRecordMap() {
  if (recordMap) { recordMap.remove(); recordMap = null; }
  recordMap = L.map('recordMap', { zoomControl: false, attributionControl: true }).setView([20, 0], 3);
  recordMap.getContainer().classList.add('map-dark');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(recordMap);
  recordLine = L.polyline([], { color: '#E8934A', weight: 4 }).addTo(recordMap);
  recordMarker = L.circleMarker([0, 0], { radius: 7, color: '#F0EAD8', fillColor: '#E8934A', fillOpacity: 1, weight: 2 }).addTo(recordMap);
}

function onPosition(pos) {
  const p = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    alt: pos.coords.altitude,
    speed: pos.coords.speed,
    acc: pos.coords.accuracy,
    ts: Date.now(),
  };
  const pts = currentTrip.points;
  if (pts.length > 0) {
    const d = haversine(pts[pts.length - 1], p);
    if (d < 1) return; // ignore GPS jitter when stationary
    currentTrip.distance += d;
  }
  pts.push(p);

  recordLine.addLatLng([p.lat, p.lng]);
  recordMarker.setLatLng([p.lat, p.lng]);
  recordMap.setView([p.lat, p.lng], Math.max(recordMap.getZoom(), 16));

  document.getElementById('statDistance').textContent = fmtDistance(currentTrip.distance);
  document.getElementById('statPoints').textContent = pts.length;

  // periodic autosave so a crash doesn't lose the trip
  if (pts.length % 15 === 0) dbPut(currentTrip);
}

function onPositionError(err) {
  document.getElementById('statDistance').title = err.message;
}

function resetStats() {
  document.getElementById('statElapsed').textContent = '0:00';
  document.getElementById('statDistance').textContent = '0 m';
  document.getElementById('statPoints').textContent = '0';
}

function updateElapsedStat() {
  document.getElementById('statElapsed').textContent = fmtDuration((Date.now() - currentTrip.startTime) / 1000);
}

async function stopRecording() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(statTimer);
  currentTrip.endTime = Date.now();
  if (currentTrip.points.length >= 2) {
    await dbPut(currentTrip);
  }
  currentTrip = null;
  showView('home');
  renderHome();
}

/* ================= PLAYBACK ================= */
let playbackMap, ghostLine, activeLine, playMarker, currentPlayTrip;
let playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0 };

async function openPlayback(id) {
  const trips = await dbGetAll();
  currentPlayTrip = trips.find((t) => t.id === id);
  if (!currentPlayTrip || currentPlayTrip.points.length < 2) {
    alert('This trip doesn\u2019t have enough GPS points to play back.');
    return;
  }
  document.getElementById('playbackTitle').textContent = currentPlayTrip.name;
  showView('playback');
  setupPlaybackMap();
  playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0 };
  setSpeedButtons(20);
  const scrub = document.getElementById('scrubber');
  scrub.max = currentPlayTrip.points[currentPlayTrip.points.length - 1].ts - currentPlayTrip.points[0].ts;
  scrub.value = 0;
  renderFrame(0);
  document.getElementById('playToggle').textContent = '\u25B6';
}

function setupPlaybackMap() {
  if (playbackMap) { playbackMap.remove(); playbackMap = null; }
  playbackMap = L.map('playbackMap', { zoomControl: false }).setView([20, 0], 3);
  playbackMap.getContainer().classList.add('map-dark');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(playbackMap);

  const latlngs = currentPlayTrip.points.map((p) => [p.lat, p.lng]);
  ghostLine = L.polyline(latlngs, { color: '#3A6B72', weight: 3, opacity: 0.6, dashArray: '1,8' }).addTo(playbackMap);
  activeLine = L.polyline([], { color: '#E8934A', weight: 4 }).addTo(playbackMap);
  playMarker = L.circleMarker(latlngs[0], { radius: 7, color: '#F0EAD8', fillColor: '#E8934A', fillOpacity: 1, weight: 2 }).addTo(playbackMap);
  playbackMap.fitBounds(ghostLine.getBounds(), { padding: [30, 30] });
}

function pointAtSimTime(simTime) {
  const pts = currentPlayTrip.points;
  const t0 = pts[0].ts;
  const target = t0 + simTime;
  if (target <= pts[0].ts) return { idx: 0, pos: pts[0] };
  if (target >= pts[pts.length - 1].ts) return { idx: pts.length - 1, pos: pts[pts.length - 1] };
  // linear scan (trip lengths are small enough for this to be cheap)
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].ts <= target && pts[i + 1].ts >= target) {
      const span = pts[i + 1].ts - pts[i].ts || 1;
      const f = (target - pts[i].ts) / span;
      return {
        idx: i,
        pos: {
          lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * f,
          lng: pts[i].lng + (pts[i + 1].lng - pts[i].lng) * f,
          speed: pts[i].speed,
          ts: target,
        },
      };
    }
  }
  return { idx: pts.length - 1, pos: pts[pts.length - 1] };
}

function renderFrame(simTime) {
  const pts = currentPlayTrip.points;
  const { idx, pos } = pointAtSimTime(simTime);
  const traced = pts.slice(0, idx + 1).map((p) => [p.lat, p.lng]);
  traced.push([pos.lat, pos.lng]);
  activeLine.setLatLngs(traced);
  playMarker.setLatLng([pos.lat, pos.lng]);

  // distance so far
  let dist = 0;
  for (let i = 1; i < traced.length; i++) {
    dist += haversine({ lat: traced[i - 1][0], lng: traced[i - 1][1] }, { lat: traced[i][0], lng: traced[i][1] });
  }

  document.getElementById('scrubber').value = simTime;
  document.getElementById('readoutClock').textContent = fmtClock(pos.ts);
  document.getElementById('readoutDist').textContent = fmtDistance(dist);
  document.getElementById('readoutSpeed').textContent = pos.speed ? (pos.speed * 3.6).toFixed(1) + ' km/h' : '—';
}

function playbackTick(nowReal) {
  if (!playState.playing) return;
  const dtReal = nowReal - playState.lastFrameReal;
  playState.lastFrameReal = nowReal;
  playState.simTime += dtReal * playState.speed;
  const max = Number(document.getElementById('scrubber').max);
  if (playState.simTime >= max) {
    playState.simTime = max;
    renderFrame(playState.simTime);
    pausePlayback();
    return;
  }
  renderFrame(playState.simTime);
  playState.rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
  playState.playing = true;
  document.getElementById('playToggle').textContent = '\u23F8';
  playState.lastFrameReal = performance.now();
  playState.rafId = requestAnimationFrame(playbackTick);
}
function pausePlayback() {
  playState.playing = false;
  document.getElementById('playToggle').textContent = '\u25B6';
  if (playState.rafId) cancelAnimationFrame(playState.rafId);
}

function setSpeedButtons(speed) {
  playState.speed = speed;
  document.querySelectorAll('.speed-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  });
}

/* ================= GOOGLE TIMELINE IMPORT ================= */
let timelineData = null;   // parsed Timeline.json
let rawPositions = [];     // sorted [{ts,lat,lng}] from rawSignals, for enriching activity-only segments
let candidateTrips = [];   // built after "Find trips"

const ACTIVITY_LABELS = {
  WALKING: 'Walk', RUNNING: 'Run', ON_BICYCLE: 'Cycle',
  IN_PASSENGER_VEHICLE: 'Drive', IN_BUS: 'Bus', IN_TRAIN: 'Train',
  IN_SUBWAY: 'Subway', IN_FERRY: 'Ferry', FLYING: 'Flight',
  IN_ROAD_VEHICLE: 'Drive', IN_RAIL_VEHICLE: 'Train', UNKNOWN: 'Trip',
};

function parseLatLng(str) {
  const nums = str.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 2) return null;
  return { lat: parseFloat(nums[0]), lng: parseFloat(nums[1]) };
}

function loadTimelineFile(file) {
  showView('loading');
  document.getElementById('loadingMessage').textContent = 'Reading Timeline file\u2026';
  const reader = new FileReader();
  reader.onload = () => {
    try {
      timelineData = JSON.parse(reader.result);
    } catch (err) {
      alert('Could not read that file — is it the Timeline.json export?');
      showView('home');
      return;
    }
    document.getElementById('loadingMessage').textContent = 'Indexing GPS pings\u2026';
    // defer so the loading view can paint before the heavier work runs
    setTimeout(() => {
      indexRawSignals();
      setupDateRangeView();
      showView('daterange');
    }, 30);
  };
  reader.onerror = () => {
    alert('Could not read that file.');
    showView('home');
  };
  reader.readAsText(file);
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

  // precompute parsed start/end ms on each semantic segment once
  for (const seg of timelineData.semanticSegments || []) {
    seg._startMs = Date.parse(seg.startTime);
    seg._endMs = Date.parse(seg.endTime);
  }
}

function rawPositionsBetween(startMs, endMs) {
  // binary search for the first index >= startMs
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
  const starts = segs.map((s) => s._startMs).filter((n) => !isNaN(n));
  const min = new Date(Math.min(...starts));
  const max = new Date(Math.max(...starts));
  const toInputDate = (d) => d.toISOString().slice(0, 10);

  document.getElementById('timelineSpan').textContent = `${fmtDate(min.getTime())} \u2013 ${fmtDate(max.getTime())}`;
  const startInput = document.getElementById('rangeStart');
  const endInput = document.getElementById('rangeEnd');
  startInput.min = toInputDate(min);
  startInput.max = toInputDate(max);
  endInput.min = toInputDate(min);
  endInput.max = toInputDate(max);

  // default: most recent 14 days of data, a manageable first look
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
      const enriched = rawPositionsBetween(seg._startMs, seg._endMs)
        .map((p) => ({ lat: p.lat, lng: p.lng, ts: p.ts }));
      if (enriched.length >= 2) {
        points = enriched;
      } else {
        points = [
          { lat: startLL.lat, lng: startLL.lng, ts: seg._startMs },
          { lat: endLL.lat, lng: endLL.lng, ts: seg._endMs },
        ];
      }
      typeLabel = ACTIVITY_LABELS[seg.activity.topCandidate?.type] || 'Trip';
      fallbackDistance = seg.activity.distanceMeters || null;
    } else {
      continue; // visit / timelineMemory — not a route
    }

    if (!points || points.length < 2) continue;

    let distance = fallbackDistance;
    if (distance == null) {
      distance = 0;
      for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
    }
    if (distance < 20) continue; // skip negligible noise

    candidates.push({
      key: `${seg._startMs}-${seg._endMs}`,
      name: `${typeLabel} \u00b7 ${fmtDate(seg._startMs)}`,
      startTime: seg._startMs,
      endTime: seg._endMs,
      points,
      distance,
      typeLabel,
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
        <div class="c-name">${escapeHtml(c.name)}</div>
        <div class="c-meta">
          <span>${fmtClock(c.startTime)}\u2013${fmtClock(c.endTime)}</span>
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
  const checks = document.querySelectorAll('.candidateCheck:checked');
  if (checks.length === 0) return;
  showView('loading');
  document.getElementById('loadingMessage').textContent = `Saving ${checks.length} trip${checks.length > 1 ? 's' : ''}\u2026`;
  await new Promise((r) => setTimeout(r, 20));

  for (const chk of checks) {
    const c = candidateTrips[Number(chk.dataset.idx)];
    const trip = {
      id: 'tl-' + c.key,
      name: c.name,
      startTime: c.startTime,
      endTime: c.endTime,
      points: c.points,
      distance: c.distance,
    };
    await dbPut(trip);
  }
  showView('home');
  renderHome();
}

/* ================= wire up UI ================= */
window.addEventListener('DOMContentLoaded', () => {
  renderHome();

  document.getElementById('fabRecord').addEventListener('click', openNameModal);
  document.getElementById('cancelName').addEventListener('click', closeNameModal);
  document.getElementById('confirmName').addEventListener('click', startRecording);

  document.getElementById('stopRecordBtn').addEventListener('click', () => {
    if (confirm('Stop and save this trip?')) stopRecording();
  });
  document.getElementById('recordBackBtn').addEventListener('click', () => {
    if (confirm('Discard this in-progress trip?')) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      clearInterval(statTimer);
      currentTrip = null;
      showView('home');
    }
  });

  document.getElementById('playbackBackBtn').addEventListener('click', () => {
    pausePlayback();
    showView('home');
    renderHome();
  });

  document.getElementById('playToggle').addEventListener('click', () => {
    if (playState.playing) pausePlayback();
    else {
      playState.lastFrameReal = performance.now();
      startPlayback();
    }
  });

  document.getElementById('scrubber').addEventListener('input', (e) => {
    pausePlayback();
    playState.simTime = Number(e.target.value);
    renderFrame(playState.simTime);
  });

  document.querySelectorAll('.speed-btn').forEach((b) => {
    b.addEventListener('click', () => setSpeedButtons(Number(b.dataset.speed)));
  });

  document.getElementById('deleteTripBtn').addEventListener('click', async () => {
    if (currentPlayTrip && confirm('Delete this trip permanently?')) {
      await dbDelete(currentPlayTrip.id);
      pausePlayback();
      showView('home');
      renderHome();
    }
  });

  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('timelineFileInput').click();
  });
  document.getElementById('timelineFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (file) loadTimelineFile(file);
  });

  document.getElementById('dateRangeBackBtn').addEventListener('click', () => {
    timelineData = null;
    showView('home');
  });

  document.getElementById('findTripsBtn').addEventListener('click', () => {
    const startVal = document.getElementById('rangeStart').value;
    const endVal = document.getElementById('rangeEnd').value;
    if (!startVal || !endVal) { alert('Pick both a start and end date.'); return; }
    const startMs = new Date(startVal + 'T00:00:00').getTime();
    const endMs = new Date(endVal + 'T23:59:59').getTime();
    if (endMs < startMs) { alert('End date is before start date.'); return; }

    showView('loading');
    document.getElementById('loadingMessage').textContent = 'Finding trips\u2026';
    setTimeout(() => {
      candidateTrips = buildCandidatesForRange(startMs, endMs);
      renderCandidateList();
      showView('import-list');
    }, 20);
  });

  document.getElementById('importListBackBtn').addEventListener('click', () => showView('daterange'));

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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
