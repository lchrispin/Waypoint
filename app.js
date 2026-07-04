/* ---------- IndexedDB ---------- */
const DB_NAME = 'waypointDB';
const DB_VERSION = 2;
const STORE = 'trips';

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutStore(store, obj) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGetAllStore(store) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteStore(store, id) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const dbPut = (trip) => dbPutStore(STORE, trip);
const dbGetAll = () => dbGetAllStore(STORE).then((rows) => rows.sort((a, b) => b.startTime - a.startTime));
const dbDelete = (id) => dbDeleteStore(STORE, id);

/* ---------- helpers ---------- */
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function pathDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}
function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function fmtDistance(m) {
  if (m < 1000) return Math.round(m) + ' m';
  const km = m / 1000;
  if (km >= 100) return Math.round(km) + ' km';
  if (km >= 10) return km.toFixed(1) + ' km';
  return km.toFixed(2) + ' km';
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
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- view switching ---------- */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

/* ================= HOME ================= */
let selectMode = false;
let selectedTripIds = new Set();
let renameTarget = null;

async function renderHome() {
  const [trips, collections, photos] = await Promise.all([dbGetAll(), dbGetAllStore('collections'), dbGetAllStore('photos')]);
  const tripsById = Object.fromEntries(trips.map((t) => [t.id, t]));
  const photoCountByTrip = {};
  for (const p of photos) photoCountByTrip[p.tripId] = (photoCountByTrip[p.tripId] || 0) + 1;

  const holidayList = document.getElementById('holidayList');
  holidayList.innerHTML = '';
  if (collections.length > 0 && !selectMode) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'Holidays';
    holidayList.appendChild(heading);
    collections
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((c) => {
        const members = c.tripIds.map((id) => tripsById[id]).filter(Boolean);
        const starts = members.map((t) => t.startTime);
        const totalDist = members.reduce((s, t) => s + (t.distance || 0), 0);
        const photoCount = members.reduce((s, t) => s + (photoCountByTrip[t.id] || 0), 0);
        const card = document.createElement('div');
        card.className = 'trip-card';
        card.innerHTML = `
          <div class="trip-name">&#9992;&#65039; ${escapeHtml(c.name)}</div>
          <div class="trip-meta">
            <span>${starts.length ? fmtDate(Math.min(...starts)) : '\u2014'}</span>
            <span>${fmtDistance(totalDist)}</span>
            <span>${members.length} leg${members.length === 1 ? '' : 's'}</span>
            ${photoCount ? `<span>${photoCount} photo${photoCount === 1 ? '' : 's'}</span>` : ''}
          </div>`;
        card.addEventListener('click', () => openHolidayPlayback(c.id));
        holidayList.appendChild(card);
      });
  }

  const list = document.getElementById('tripList');
  list.innerHTML = '';
  if (trips.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="glyph">&#9737;</div>
      <p>No trips yet. Tap "Record trip" and your route will be logged and ready to replay.</p></div>`;
    return;
  }
  if (collections.length > 0 && !selectMode) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'Trips';
    list.appendChild(heading);
  }
  trips.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'trip-card' + (selectMode ? ' selectable' : '');
    const dur = t.endTime ? fmtDuration((t.endTime - t.startTime) / 1000) : '\u2014';
    const photoCount = photoCountByTrip[t.id] || 0;
    card.innerHTML = `
      ${selectMode ? `<input type="checkbox" class="tripSelectCheck" data-id="${t.id}" ${selectedTripIds.has(t.id) ? 'checked' : ''} />` : ''}
      <div>
        <div class="trip-name">${escapeHtml(t.name)}</div>
        <div class="trip-meta">
          <span>${fmtDate(t.startTime)}</span>
          <span>${fmtDistance(t.distance || 0)}</span>
          <span>${dur}</span>
          <span>${(t.points || []).length} pts</span>
          ${photoCount ? `<span>${photoCount} photo${photoCount === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>`;
    if (selectMode) {
      card.addEventListener('click', (e) => {
        const cb = card.querySelector('.tripSelectCheck');
        if (e.target !== cb) cb.checked = !cb.checked;
        toggleTripSelect(t.id, cb.checked);
      });
    } else {
      card.addEventListener('click', () => openPlayback(t.id));
    }
    list.appendChild(card);
  });
}

function toggleTripSelect(id, checked) {
  if (checked) selectedTripIds.add(id);
  else selectedTripIds.delete(id);
  const n = selectedTripIds.size;
  const combineBtn = document.getElementById('fabCombine');
  combineBtn.textContent = `Combine (${n})`;
  combineBtn.disabled = n < 2;
  const mergeBtn = document.getElementById('mergeBtn');
  mergeBtn.textContent = `Merge (${n})`;
  mergeBtn.disabled = n < 2;
  const deleteBtn = document.getElementById('bulkDeleteBtn');
  deleteBtn.textContent = n > 0 ? `Delete (${n})` : 'Delete';
  deleteBtn.disabled = n === 0;
}

function setSelectMode(on) {
  selectMode = on;
  selectedTripIds.clear();
  document.getElementById('selectModeBtn').textContent = selectMode ? 'Cancel' : 'Select';
  document.getElementById('fabRecord').style.display = selectMode ? 'none' : '';
  document.getElementById('selectActionsBar').style.display = selectMode ? 'flex' : 'none';
  document.getElementById('fabCombine').textContent = 'Combine (0)';
  document.getElementById('fabCombine').disabled = true;
  document.getElementById('mergeBtn').textContent = 'Merge (0)';
  document.getElementById('mergeBtn').disabled = true;
  document.getElementById('bulkDeleteBtn').textContent = 'Delete';
  document.getElementById('bulkDeleteBtn').disabled = true;
  renderHome();
}

async function mergeSelectedTrips(name) {
  const ids = [...selectedTripIds];
  if (ids.length < 2) return;
  const trips = await dbGetAll();
  const members = trips.filter((t) => ids.includes(t.id)).sort((a, b) => a.startTime - b.startTime);
  if (members.length < 2) return;

  const points = members.flatMap((t) => t.points || []).sort((a, b) => a.ts - b.ts);
  const newId = 'merge-' + Date.now();
  const lastMember = members[members.length - 1];
  const merged = {
    id: newId,
    name,
    startTime: members[0].startTime,
    endTime: lastMember.endTime || points[points.length - 1].ts,
    points,
    distance: pathDistance(points),
  };
  await dbPut(merged);

  const photos = await dbGetAllStore('photos');
  for (const p of photos) {
    if (ids.includes(p.tripId)) {
      p.tripId = newId;
      await dbPutStore('photos', p);
    }
  }

  const collections = await dbGetAllStore('collections');
  for (const c of collections) {
    if (!c.tripIds.some((id) => ids.includes(id))) continue;
    const newTripIds = [];
    let inserted = false;
    for (const tid of c.tripIds) {
      if (ids.includes(tid)) {
        if (!inserted) { newTripIds.push(newId); inserted = true; }
      } else {
        newTripIds.push(tid);
      }
    }
    c.tripIds = newTripIds;
    await dbPutStore('collections', c);
  }

  for (const id of ids) await dbDelete(id);
  setSelectMode(false);
}

/* ================= RECORDING ================= */
let recordMap, recordLine, recordMarker, watchId, currentTrip, statTimer;

function openNameModal() {
  document.getElementById('tripNameInput').value = `Trip \u00b7 ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
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
    if (d < 1) return;
    currentTrip.distance += d;
  }
  pts.push(p);

  recordLine.addLatLng([p.lat, p.lng]);
  recordMarker.setLatLng([p.lat, p.lng]);
  recordMap.setView([p.lat, p.lng], Math.max(recordMap.getZoom(), 16));

  document.getElementById('statDistance').textContent = fmtDistance(currentTrip.distance);
  document.getElementById('statPoints').textContent = pts.length;

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
  if (currentTrip.points.length >= 2) await dbPut(currentTrip);
  currentTrip = null;
  showView('home');
  renderHome();
}

/* ================= PLAYBACK (shared: single trip + holiday) ================= */
let playbackMap, ghostLayers, activeLine, playMarker, currentPlayTrip, currentHoliday;
let photoMarkers = [];
let photoEntries = [];
let stayPulseMarker = null;
let memoryShownIds = new Set();
let memoryActive = null;
let memoryTimer = null;
let playbackMode = 'playing'; // 'overview' (atlas: whole path + storyline strip) | 'playing' (ride-along)
let overviewAvailable = false;
let playbackBounds = null;
let momentLayer = null;
let chapterLines = [];
let activeChapterIdx = -1;
let followEnabled = false;
let autoZoomCurrent = null;
let playState = { playing: false, speed: 1, rafId: null, simTime: 0, lastFrameReal: 0, maxMs: 0, renderFn: null };

/* binary search: the interpolators below run per animation frame on merged trips that can carry
 * thousands of points, so a linear scan is the difference between smooth and stuttery */
function lowerBoundIdx(points, target, key) {
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (key(points[mid]) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

function pointAtSimTime(points, simTime) {
  const target = points[0].ts + simTime;
  if (target <= points[0].ts) return { idx: 0, pos: points[0] };
  if (target >= points[points.length - 1].ts) return { idx: points.length - 1, pos: points[points.length - 1] };
  const i = lowerBoundIdx(points, target, (p) => p.ts);
  const a = points[i], b = points[i + 1];
  const span = b.ts - a.ts || 1;
  const f = (target - a.ts) / span;
  return {
    idx: i,
    pos: {
      lat: a.lat + (b.lat - a.lat) * f,
      lng: a.lng + (b.lng - a.lng) * f,
      speed: a.speed,
      ts: target,
      realTs: a.realTs != null ? a.realTs + (b.realTs - a.realTs) * f : target,
    },
  };
}

/* ---- stay/jump detection + compressed display timeline ----
 * A merged trip carries the real hours-long gaps between its original legs, and any trip can
 * contain long stationary stretches (an overnight stop, a parked car). Instead of playing those
 * in proportion, the display timeline compresses each one to a short fixed span and surfaces it
 * as an event ("Stayed here · 2 nights" / "Traveling · +6 h") so playback never idles. */
const STAY_RADIUS_M = 100; // points wandering within this of a running centroid count as one stay
const STAY_MIN_MS = 10 * 60 * 1000;
const GAP_MIN_MS = 5 * 60 * 1000; // a single recording gap this long is a stay or an unrecorded jump
const GAP_STAY_DIST_M = 300;
const EVENT_SYNTH_MS = 50000; // compressed display span of a stay/jump (~2.5 s at the default 20x)

function detectStays(points) {
  const n = points.length;
  const spans = [];

  for (let i = 1; i < n; i++) {
    if (points[i].ts - points[i - 1].ts >= GAP_MIN_MS) spans.push({ startIdx: i - 1, endIdx: i });
  }

  let s = 0, latSum = points[0].lat, lngSum = points[0].lng, count = 1;
  const closeRun = (endIdx) => {
    if (endIdx > s && points[endIdx].ts - points[s].ts >= STAY_MIN_MS) spans.push({ startIdx: s, endIdx });
  };
  for (let i = 1; i < n; i++) {
    if (haversine({ lat: latSum / count, lng: lngSum / count }, points[i]) <= STAY_RADIUS_M) {
      latSum += points[i].lat; lngSum += points[i].lng; count++;
      continue;
    }
    closeRun(i - 1);
    s = i; latSum = points[i].lat; lngSum = points[i].lng; count = 1;
  }
  closeRun(n - 1);

  spans.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.startIdx <= last.endIdx) last.endIdx = Math.max(last.endIdx, sp.endIdx);
    else merged.push({ ...sp });
  }
  for (const sp of merged) {
    sp.kind = haversine(points[sp.startIdx], points[sp.endIdx]) >= GAP_STAY_DIST_M ? 'jump' : 'stay';
  }
  return merged;
}

function buildTripTimeline(points) {
  const spans = detectStays(points);
  const factor = new Array(points.length).fill(1); // per-interval compression, interval i = (i-1 -> i)
  for (const sp of spans) {
    const realSpan = points[sp.endIdx].ts - points[sp.startIdx].ts;
    const f = realSpan > 0 ? Math.min(realSpan, EVENT_SYNTH_MS) / realSpan : 1;
    for (let i = sp.startIdx + 1; i <= sp.endIdx; i++) factor[i] = f;
  }
  const out = [{ lat: points[0].lat, lng: points[0].lng, speed: points[0].speed, ts: 0, realTs: points[0].ts }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    out.push({ lat: p.lat, lng: p.lng, speed: p.speed, ts: out[i - 1].ts + (p.ts - points[i - 1].ts) * factor[i], realTs: p.ts });
  }
  const events = spans.map((sp) => ({
    kind: sp.kind,
    startIdx: sp.startIdx,
    endIdx: sp.endIdx,
    synthStart: out[sp.startIdx].ts,
    synthEnd: out[sp.endIdx].ts,
    realStart: points[sp.startIdx].ts,
    realEnd: points[sp.endIdx].ts,
    realSpanMs: points[sp.endIdx].ts - points[sp.startIdx].ts,
    lat: points[sp.startIdx].lat,
    lng: points[sp.startIdx].lng,
    latEnd: points[sp.endIdx].lat,
    lngEnd: points[sp.endIdx].lng,
  }));
  return { points: out, events, maxMs: out[out.length - 1].ts };
}

function synthTimeForRealTs(points, realTs) {
  const key = (p) => (p.realTs != null ? p.realTs : p.ts);
  if (realTs <= key(points[0])) return points[0].ts;
  const last = points[points.length - 1];
  if (realTs >= key(last)) return last.ts;
  const i = lowerBoundIdx(points, realTs, key);
  const a = points[i], b = points[i + 1];
  const span = key(b) - key(a) || 1;
  return a.ts + (b.ts - a.ts) * ((realTs - key(a)) / span);
}

function eventAtSimTime(simTime) {
  const list = currentHoliday ? currentHoliday.events : playState.events;
  if (!list) return null;
  return list.find((e) => simTime >= e.synthStart && simTime <= e.synthEnd) || null;
}

function nightsBetween(a, b) {
  const d1 = new Date(a); d1.setHours(0, 0, 0, 0);
  const d2 = new Date(b); d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}
function fmtSpanShort(ms) {
  const h = ms / 3600000;
  if (h >= 10) return Math.round(h) + ' h';
  if (h >= 1) return (Math.round(h * 10) / 10) + ' h';
  return Math.max(1, Math.round(ms / 60000)) + ' min';
}
function stayLabel(ev) {
  if (ev.kind === 'jump') {
    const d = ev.latEnd != null ? haversine({ lat: ev.lat, lng: ev.lng }, { lat: ev.latEnd, lng: ev.lngEnd }) : 0;
    const dPart = d >= 1000 ? `${fmtDistance(d)} · ` : '';
    return `Traveling ${dPart}+${fmtSpanShort(ev.realSpanMs)}`;
  }
  const nights = nightsBetween(ev.realStart, ev.realEnd);
  if (nights >= 1 && ev.realSpanMs >= 18 * 3600000) return `Stayed here · ${nights} night${nights === 1 ? '' : 's'}`;
  return `Stayed here · ${fmtSpanShort(ev.realSpanMs)}`;
}

/* ---- adaptive playback pace: slow near photos/turns ----
 * Turns and photos are momentary, so they're stored as smooth time-radius "dips" that ease
 * playback into and out of the moment. (Stationary stretches used to get a flat fast-forward
 * multiplier here; the compressed display timeline above made that redundant.) */
const TURN_RADIUS_MS = 20000;
const PHOTO_RADIUS_MS = 45000;

function buildPaceProfile(points, photosForTrip, simOffset) {
  const n = points.length;
  if (n < 2) return { intervals: [{ start: -Infinity, end: Infinity, base: 1 }], dips: [] };

  const segDist = new Array(n).fill(0);
  const localSpeed = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = (points[i].ts - points[i - 1].ts) / 1000;
    segDist[i] = haversine(points[i - 1], points[i]);
    localSpeed[i] = dt > 0 ? segDist[i] / dt : 0;
  }

  const intervals = [];
  for (let i = 1; i < n; i++) {
    const base = localSpeed[i] > 4 ? 1.15 : 1; // nudge steady, uneventful travel along
    intervals.push({ start: points[i - 1].ts - simOffset, end: points[i].ts - simOffset, base });
  }

  const dips = [];
  for (let i = 1; i < n - 1; i++) {
    // bearing across a near-zero-distance segment is just GPS noise, not a real heading —
    // require real displacement on both sides before trusting the bearing comparison
    if (segDist[i] < 3 || segDist[i + 1] < 3) continue;
    const b1 = bearing(points[i - 1], points[i]);
    const b2 = bearing(points[i], points[i + 1]);
    let diff = Math.abs(b2 - b1) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff > 20) {
      dips.push({ sim: points[i].ts - simOffset, strength: Math.min(1, diff / 90) * 0.3, radius: TURN_RADIUS_MS });
    }
  }
  for (const photo of photosForTrip) {
    // anchor on the matching point's own ts (already in this points array's coordinate domain —
    // absolute epoch for a single trip, synthetic holiday-timeline ms for a leg) rather than the
    // photo's raw real-world timestamp, which lives in a different domain for holiday legs.
    let nearestTs = points[0].ts, best = Infinity;
    for (let i = 0; i < n; i++) {
      const mts = points[i].realTs != null ? points[i].realTs : points[i].ts;
      const diff = Math.abs(mts - photo.ts);
      if (diff < best) { best = diff; nearestTs = points[i].ts; }
    }
    dips.push({ sim: nearestTs - simOffset, strength: 0.35, radius: PHOTO_RADIUS_MS });
  }

  return { intervals, dips };
}

function paceMultiplierAt(profile, simCoord) {
  if (!profile) return 1;
  let base = 1;
  for (const iv of profile.intervals) {
    if (simCoord >= iv.start && simCoord <= iv.end) { base = iv.base; break; }
  }
  let mult = base;
  for (const d of profile.dips) {
    const dist = Math.abs(simCoord - d.sim);
    if (dist >= d.radius) continue;
    const falloff = 1 - dist / d.radius;
    mult = Math.min(mult, 1 - falloff * d.strength);
  }
  return mult;
}

function currentPaceMultiplier(simTime) {
  if (currentHoliday) {
    const leg = legAtSimTime(simTime);
    if (!leg) return 2; // synthetic gap between legs — nothing to see, fast-forward through it
    return paceMultiplierAt(leg.paceProfile, simTime);
  }
  return paceMultiplierAt(playState.paceProfile, simTime);
}

/* ---- story pacing: the viewer's time is the fixed budget, the trip flexes to fit it ----
 * Each chapter gets a display duration on a log curve of its distance, so a 1 km stroll takes
 * ~12 s and a 1,000 km drive ~35 s rather than 1000x. If the whole story would still run long,
 * everything scales down proportionally. Speed is capped so tiles can keep up (a very long leg
 * just runs a bit over its target instead of outrunning the map), and the user's speed buttons
 * are relative nudges (0.5x / 1x / 2x story time) on top. */
const STORY_MAX_SPEED = 150;
const STORY_GAP_SPEED = 20; // through compressed stays/jumps and inter-leg gaps (~2-2.5 s each)
const STORY_TOTAL_BUDGET_S = 150;

function storySecondsForDistance(m) {
  const km = m / 1000;
  return Math.min(35, Math.max(10, 8 + 6 * Math.log(1 + km)));
}

function assignStoryPacing(chapters) {
  let total = 0;
  for (const c of chapters) {
    c.storySec = storySecondsForDistance(c.distance);
    total += c.storySec;
  }
  if (total > STORY_TOTAL_BUDGET_S) {
    const f = STORY_TOTAL_BUDGET_S / total;
    for (const c of chapters) c.storySec *= f;
  }
  for (const c of chapters) {
    const span = c.synthEnd - c.synthStart;
    c.storySpeed = Math.min(STORY_MAX_SPEED, Math.max(1, span / (c.storySec * 1000)));
  }
}

function currentBaseSpeed(simTime) {
  const mult = playState.speed || 1;
  const c = chapterAtSimTime(simTime);
  return (c ? c.storySpeed : STORY_GAP_SPEED) * mult;
}

function setupPlaybackMap(legsForGhost) {
  if (playbackMap) { playbackMap.stop(); playbackMap.remove(); playbackMap = null; }
  playbackMap = L.map('playbackMap', { zoomControl: false }).setView([20, 0], 3);
  playbackMap.getContainer().classList.add('map-dark');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(playbackMap);

  ghostLayers = L.layerGroup().addTo(playbackMap);
  let allBounds = null;
  legsForGhost.forEach((leg) => {
    const latlngs = leg.points.map((p) => [p.lat, p.lng]);
    const line = L.polyline(latlngs, { color: '#3A6B72', weight: 3, opacity: 0.6, dashArray: '1,8' });
    ghostLayers.addLayer(line);
    allBounds = allBounds ? allBounds.extend(line.getBounds()) : line.getBounds();
  });
  activeLine = L.polyline([], { color: '#E8934A', weight: 4 }).addTo(playbackMap);
  const firstPt = legsForGhost[0].points[0];
  playMarker = L.circleMarker([firstPt.lat, firstPt.lng], { radius: 7, color: '#F0EAD8', fillColor: '#E8934A', fillOpacity: 1, weight: 2 }).addTo(playbackMap);
  if (allBounds) playbackMap.fitBounds(allBounds, { padding: [30, 30] });
  playbackBounds = allBounds;
  photoMarkers = [];
  stayPulseMarker = null;
  travelArc = null;
  momentLayer = null;
  chapterLines = [];
  activeChapterIdx = -1;
  followEnabled = false;
  autoZoomCurrent = null;
}

function updateStayPulse(ev) {
  if (!ev) {
    if (stayPulseMarker) { playbackMap.removeLayer(stayPulseMarker); stayPulseMarker = null; }
    return;
  }
  if (!stayPulseMarker) {
    stayPulseMarker = L.marker([ev.lat, ev.lng], {
      icon: L.divIcon({ className: 'stay-pulse', html: '<div class="stay-pulse-ring"></div>', iconSize: [64, 64], iconAnchor: [32, 32] }),
      interactive: false,
    }).addTo(playbackMap);
  } else {
    stayPulseMarker.setLatLng([ev.lat, ev.lng]);
  }
}

/* ---- travel arcs: the "Indiana Jones map" cut for big unrecorded jumps ----
 * When playback crosses a gap whose displacement is flight/long-drive sized, the camera pulls
 * out to frame both endpoints and a dashed arc sweeps across, instead of the dot teleporting. */
const ARC_MIN_DIST_M = 50000;
let travelArc = null;

function travelGapAt(simTime) {
  if (currentHoliday && !legAtSimTime(simTime)) {
    const prev = [...currentHoliday.legs].reverse().find((l) => l.synthEnd <= simTime);
    const next = currentHoliday.legs.find((l) => l.synthStart > simTime);
    if (!prev || !next) return null;
    const from = prev.points[prev.points.length - 1];
    const to = next.points[0];
    return { key: 'gap' + prev.synthEnd, start: prev.synthEnd, end: next.synthStart, from, to };
  }
  const ev = eventAtSimTime(simTime);
  if (ev && ev.kind === 'jump' && ev.latEnd != null) {
    return { key: 'ev' + ev.synthStart, start: ev.synthStart, end: ev.synthEnd, from: { lat: ev.lat, lng: ev.lng }, to: { lat: ev.latEnd, lng: ev.lngEnd } };
  }
  return null;
}

function arcLatLngs(from, to, f) {
  const ctrl = {
    lat: (from.lat + to.lat) / 2 - (to.lng - from.lng) * 0.18,
    lng: (from.lng + to.lng) / 2 + (to.lat - from.lat) * 0.18,
  };
  const steps = 48;
  const upto = Math.max(1, Math.round(f * steps));
  const out = [];
  for (let i = 0; i <= upto; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.push([a * from.lat + b * ctrl.lat + c * to.lat, a * from.lng + b * ctrl.lng + c * to.lng]);
  }
  return out;
}

/* Returns the arc tip position while a big jump is on screen, else null. */
function updateTravelArc(simTime) {
  const gap = travelGapAt(simTime);
  const big = gap && haversine(gap.from, gap.to) >= ARC_MIN_DIST_M ? gap : null;
  if (!big) {
    if (travelArc) {
      playbackMap.removeLayer(travelArc.line);
      travelArc = null;
      autoZoomCurrent = null; // reseed the follow camera after the wide shot
      if (playState.playing) followEnabled = true;
    }
    return null;
  }
  if (!travelArc || travelArc.key !== big.key) {
    if (travelArc) playbackMap.removeLayer(travelArc.line);
    travelArc = { key: big.key, line: L.polyline([], { color: '#E8934A', weight: 3, dashArray: '6,9', opacity: 0.9 }).addTo(playbackMap) };
    followEnabled = false;
    playbackMap.flyToBounds(L.latLngBounds([big.from.lat, big.from.lng], [big.to.lat, big.to.lng]).pad(0.35), { duration: 0.9 });
  }
  const f = Math.max(0, Math.min(1, (simTime - big.start) / Math.max(1, big.end - big.start)));
  const pts = arcLatLngs(big.from, big.to, f);
  travelArc.line.setLatLngs(pts);
  return pts[pts.length - 1];
}

/* ---- chapters: the storyline units a viewer scans and jumps between ----
 * A holiday chapters by leg; a merged/single trip chapters by the movement segments between
 * its stay/jump events. Chapters drive the overview strip, seeking, and (via storySec) pacing. */
function buildChapters() {
  const chapters = [];
  if (currentHoliday) {
    currentHoliday.legs.forEach((leg, i) => {
      chapters.push({
        idx: i,
        title: leg.name,
        dateLabel: fmtDate(leg.realStart),
        synthStart: leg.synthStart,
        synthEnd: leg.synthEnd,
        realStart: leg.points[0].realTs,
        realEnd: leg.points[leg.points.length - 1].realTs,
        distance: leg.distance,
        latlngs: leg.points.map((p) => [p.lat, p.lng]),
      });
    });
    return chapters;
  }

  const pts = playState.displayPoints;
  const segs = [];
  let segStart = 0;
  for (const ev of playState.events) {
    if (ev.startIdx > segStart) segs.push([segStart, ev.startIdx]);
    segStart = ev.endIdx;
  }
  if (segStart < pts.length - 1) segs.push([segStart, pts.length - 1]);

  for (const [a, b] of segs) {
    const slice = pts.slice(a, b + 1);
    const d = pathDistance(slice);
    const last = chapters[chapters.length - 1];
    if (d < 50 && last) {
      // GPS jitter around a stop, not a real movement segment — absorb into the previous chapter
      last.synthEnd = pts[b].ts;
      last.realEnd = pts[b].realTs;
      last.distance += d;
      continue;
    }
    chapters.push({
      synthStart: pts[a].ts,
      synthEnd: pts[b].ts,
      realStart: pts[a].realTs,
      realEnd: pts[b].realTs,
      distance: d,
      latlngs: slice.map((p) => [p.lat, p.lng]),
    });
  }

  const multiDay = nightsBetween(pts[0].realTs, pts[pts.length - 1].realTs) >= 1;
  const dayCounts = {};
  for (const c of chapters) {
    const day = nightsBetween(pts[0].realTs, c.realStart) + 1;
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  chapters.forEach((c, i) => {
    c.idx = i;
    const day = nightsBetween(pts[0].realTs, c.realStart) + 1;
    c.title = multiDay ? `Day ${day}` : `Stage ${i + 1}`;
    // several chapters on one day would be indistinguishable — show the start time instead of the date
    c.dateLabel = multiDay && dayCounts[day] === 1 ? fmtDate(c.realStart) : fmtClock(c.realStart);
  });
  return chapters;
}

function chapterAtSimTime(simTime) {
  if (!playState.chapters) return null;
  return playState.chapters.find((c) => simTime >= c.synthStart && simTime <= c.synthEnd) || null;
}

function photosForChapter(c) {
  return photoEntries.filter((e) => e.synth != null && e.synth >= c.synthStart && e.synth <= c.synthEnd);
}

/* ---- photo moments: photos clustered in space and time, shown as one pin at atlas altitude ----
 * The cluster radius derives from the trip's bounding box so a walking tour clusters per café
 * and a road trip clusters per town. */
function clusterPhotoMoments(entries) {
  let radius = 60;
  if (playbackBounds) {
    const nw = playbackBounds.getNorthWest(), se = playbackBounds.getSouthEast();
    radius = Math.max(60, haversine({ lat: nw.lat, lng: nw.lng }, { lat: se.lat, lng: se.lng }) / 50);
  }
  const clusters = [];
  const sorted = entries.filter((e) => e.synth != null).slice().sort((a, b) => a.photo.ts - b.photo.ts);
  for (const e of sorted) {
    const c = clusters.find(
      (cl) => e.photo.ts - cl.lastTs <= 6 * 3600000 && haversine(cl.center, { lat: e.photo.lat, lng: e.photo.lng }) <= radius
    );
    if (c) {
      c.entries.push(e);
      c.lastTs = e.photo.ts;
      c.center = {
        lat: c.entries.reduce((s, x) => s + x.photo.lat, 0) / c.entries.length,
        lng: c.entries.reduce((s, x) => s + x.photo.lng, 0) / c.entries.length,
      };
    } else {
      clusters.push({ entries: [e], center: { lat: e.photo.lat, lng: e.photo.lng }, lastTs: e.photo.ts });
    }
  }
  return clusters;
}

function buildMomentPins() {
  removeMomentPins();
  momentLayer = L.layerGroup().addTo(playbackMap);
  for (const c of clusterPhotoMoments(photoEntries)) {
    const badge = c.entries.length > 1 ? `<span class="moment-count">${c.entries.length}</span>` : '';
    const icon = L.divIcon({
      className: 'moment-pin-wrap',
      html: `<div class="moment-pin" style="background-image:url('${c.entries[0].url}')">${badge}</div>`,
      iconSize: [46, 46],
    });
    const m = L.marker([c.center.lat, c.center.lng], { icon }).addTo(momentLayer);
    m.on('click', () => openMomentSheet(c));
  }
}
function removeMomentPins() {
  if (momentLayer) { playbackMap.removeLayer(momentLayer); momentLayer = null; }
}

function openMomentSheet(cluster) {
  const title = `${photoCaption(cluster.entries[0].photo)}${cluster.entries.length > 1 ? ` · ${cluster.entries.length} photos` : ''}`;
  document.getElementById('momentSheetTitle').textContent = title;
  const grid = document.getElementById('momentGrid');
  grid.innerHTML = '';
  for (const e of cluster.entries) {
    const cell = document.createElement('div');
    cell.className = 'moment-cell';
    cell.style.backgroundImage = `url('${e.url}')`;
    cell.addEventListener('click', () => openPhotoLightbox(e.photo, e.url));
    grid.appendChild(cell);
  }
  document.getElementById('momentPlayBtn').onclick = () => {
    closeMomentSheet();
    enterPlaying(Math.max(0, cluster.entries[0].synth - 60000), true);
  };
  document.getElementById('momentSheet').classList.add('active');
}
function closeMomentSheet() {
  document.getElementById('momentSheet').classList.remove('active');
}

/* ---- overview (atlas) <-> playing (ride-along) ---- */
function buildChapterLines() {
  removeChapterLines();
  chapterLines = (playState.chapters || []).map((c) =>
    L.polyline(c.latlngs, { color: '#E8934A', weight: 3, opacity: 0.35 }).addTo(playbackMap)
  );
  chapterLines.forEach((line, i) => {
    line.on('click', () => {
      setActiveChapter(i);
      const card = document.querySelector(`.chapter-card[data-idx="${i}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  });
}
function removeChapterLines() {
  chapterLines.forEach((l) => playbackMap.removeLayer(l));
  chapterLines = [];
}

function setActiveChapter(idx) {
  if (idx === activeChapterIdx) return;
  activeChapterIdx = idx;
  document.querySelectorAll('.chapter-card').forEach((el) => el.classList.toggle('active', Number(el.dataset.idx) === idx));
  chapterLines.forEach((line, i) => line.setStyle(i === idx ? { opacity: 0.95, weight: 4 } : { opacity: 0.35, weight: 3 }));
}

function renderStorylineStrip() {
  const chapters = playState.chapters || [];
  const strip = document.getElementById('storylineStrip');
  strip.innerHTML = '';
  chapters.forEach((c) => {
    const thumbs = photosForChapter(c).slice(0, 3);
    const card = document.createElement('div');
    card.className = 'chapter-card';
    card.dataset.idx = c.idx;
    card.innerHTML = `
      <div class="chapter-title">${escapeHtml(c.title)}</div>
      <div class="chapter-meta">${escapeHtml(c.dateLabel)} · ${fmtDistance(c.distance)}</div>
      ${thumbs.length ? `<div class="chapter-thumbs">${thumbs.map((t) => `<div style="background-image:url('${t.url}')"></div>`).join('')}</div>` : ''}`;
    card.addEventListener('click', () => enterPlaying(c.synthStart, true));
    strip.appendChild(card);
  });

  const startReal = tripStartRealTs();
  const endReal = chapters.length ? chapters[chapters.length - 1].realEnd : startReal;
  const days = nightsBetween(startReal, endReal) + 1;
  const dist = chapters.reduce((s, c) => s + c.distance, 0);
  const bits = [`${days} day${days === 1 ? '' : 's'}`, fmtDistance(dist)];
  if (photoEntries.length) bits.push(`${photoEntries.length} photo${photoEntries.length === 1 ? '' : 's'}`);
  document.getElementById('overviewStats').textContent = bits.join(' · ');
}

function highlightCenteredChapter() {
  const strip = document.getElementById('storylineStrip');
  const center = strip.scrollLeft + strip.clientWidth / 2;
  let best = -1, bestDist = Infinity;
  strip.querySelectorAll('.chapter-card').forEach((card) => {
    const mid = card.offsetLeft + card.offsetWidth / 2;
    const d = Math.abs(mid - center);
    if (d < bestDist) { bestDist = d; best = Number(card.dataset.idx); }
  });
  if (best >= 0) setActiveChapter(best);
}

function enterOverview() {
  pausePlayback();
  dismissPhotoMemory();
  hideSummary();
  playbackMode = 'overview';
  document.getElementById('playerPanel').style.display = 'none';
  document.getElementById('overviewPanel').style.display = '';
  document.getElementById('legBanner').classList.remove('active');
  updateStayPulse(null);
  activeLine.setLatLngs([]);
  if (playbackMap.hasLayer(playMarker)) playbackMap.removeLayer(playMarker);
  photoMarkers.forEach((m) => { if (playbackMap.hasLayer(m)) playbackMap.removeLayer(m); });
  buildMomentPins();
  buildChapterLines();
  renderStorylineStrip();
  followEnabled = false;
  activeChapterIdx = -1;
  setActiveChapter(0);
  // flyToBounds rather than fitBounds: its animation is cancellable via map.stop(), so tearing
  // the view down mid-flight (back to home, opening another trip) can't leave a dangling frame
  if (playbackBounds) playbackMap.flyToBounds(playbackBounds, { padding: [30, 30], duration: 0.8 });
}

function enterPlaying(simTime, autoplay) {
  playbackMode = 'playing';
  hideSummary();
  closeMomentSheet();
  document.getElementById('overviewPanel').style.display = 'none';
  document.getElementById('playerPanel').style.display = '';
  removeMomentPins();
  removeChapterLines();
  if (!playbackMap.hasLayer(playMarker)) playMarker.addTo(playbackMap);
  photoMarkers.forEach((m) => { if (!playbackMap.hasLayer(m)) m.addTo(playbackMap); });
  playState.simTime = Math.max(0, Math.min(simTime, playState.maxMs));
  if (playState.simTime === 0) memoryShownIds.clear();
  else rearmMemoriesAfter(playState.simTime);
  autoZoomCurrent = null;
  playState.renderFn(playState.simTime);
  if (autoplay) startPlayback();
  else document.getElementById('playToggle').textContent = '▶';
}

/* ---- segmented story scrubber: one segment per chapter sized by its display time, with photo
 * dots and stay ticks, so the structure of the story is visible before pressing play ---- */
let scrubSegs = [];

function buildScrubber() {
  const el = document.getElementById('storyScrubber');
  el.innerHTML = '';
  scrubSegs = [];
  const chapters = playState.chapters || [];
  const spans = [];
  let cursor = 0;
  for (const c of chapters) {
    if (c.synthStart > cursor + 1) spans.push({ start: cursor, end: c.synthStart, gap: true });
    spans.push({ start: c.synthStart, end: c.synthEnd, gap: false, weight: c.storySec || 1 });
    cursor = c.synthEnd;
  }
  if (cursor < playState.maxMs - 1) spans.push({ start: cursor, end: playState.maxMs, gap: true });

  const events = (currentHoliday ? currentHoliday.events : playState.events) || [];
  for (const sp of spans) {
    const seg = document.createElement('div');
    seg.className = 'scrub-seg' + (sp.gap ? ' gap' : '');
    if (!sp.gap) seg.style.flexGrow = String(sp.weight);
    const fill = document.createElement('div');
    fill.className = 'scrub-fill';
    seg.appendChild(fill);
    if (!sp.gap) {
      const at = (t) => (((t - sp.start) / (sp.end - sp.start)) * 100) + '%';
      for (const e of photoEntries) {
        if (e.synth != null && e.synth >= sp.start && e.synth <= sp.end) {
          const dot = document.createElement('span');
          dot.className = 'scrub-dot';
          dot.style.left = at(e.synth);
          seg.appendChild(dot);
        }
      }
      for (const ev of events) {
        if (ev.synthStart > sp.start && ev.synthEnd < sp.end) {
          const tick = document.createElement('span');
          tick.className = 'scrub-tick';
          tick.style.left = at((ev.synthStart + ev.synthEnd) / 2);
          seg.appendChild(tick);
        }
      }
    }
    el.appendChild(seg);
    scrubSegs.push({ el: seg, fill, start: sp.start, end: sp.end });
  }
}

function updateScrubberValue(sim) {
  for (const s of scrubSegs) {
    const f = s.end > s.start ? Math.max(0, Math.min(1, (sim - s.start) / (s.end - s.start))) : sim >= s.end ? 1 : 0;
    s.fill.style.width = f * 100 + '%';
  }
}

function simFromScrubberX(clientX) {
  for (let i = 0; i < scrubSegs.length; i++) {
    const s = scrubSegs[i];
    const r = s.el.getBoundingClientRect();
    if (clientX <= r.right || i === scrubSegs.length - 1) {
      if (clientX < r.left) return s.start;
      const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return s.start + f * (s.end - s.start);
    }
  }
  return playState.maxMs;
}

/* ---- end-of-story summary ---- */
function showSummary() {
  const chapters = playState.chapters || [];
  const startReal = tripStartRealTs();
  const endReal = chapters.length ? chapters[chapters.length - 1].realEnd : startReal;
  const days = nightsBetween(startReal, endReal) + 1;
  const dist = currentHoliday
    ? currentHoliday.legs.reduce((s, l) => s + l.distance, 0)
    : (currentPlayTrip.distance || chapters.reduce((s, c) => s + c.distance, 0));
  document.getElementById('summaryTitle').textContent = currentHoliday ? currentHoliday.collection.name : currentPlayTrip.name;
  const bits = [`${days} day${days === 1 ? '' : 's'}`, fmtDistance(dist)];
  if (photoEntries.length) bits.push(`${photoEntries.length} photo${photoEntries.length === 1 ? '' : 's'}`);
  document.getElementById('summaryStats').textContent = bits.join(' · ');
  document.getElementById('summaryOverviewBtn').style.display = overviewAvailable ? '' : 'none';
  document.getElementById('summaryOverlay').classList.add('active');
}
function hideSummary() {
  document.getElementById('summaryOverlay').classList.remove('active');
}

/* ---- auto-follow camera: zoom based on how much ground is covered in the next few seconds,
 * so a fast leg (flight/highway) doesn't fly off-screen and a slow one isn't zoomed out to nothing ---- */
const FOLLOW_LOOKAHEAD_MS = 30000;
const FOLLOW_ZOOM_SMOOTHING = 0.025;
const FOLLOW_MAX_ZOOM_STEP = 0.05;

function computeTargetZoom(pos, aheadPos) {
  const spanMeters = Math.max(30, haversine(pos, aheadPos));
  const size = playbackMap.getSize ? playbackMap.getSize() : { x: 360, y: 640 };
  const minDim = Math.max(100, Math.min(size.x, size.y));
  const metersPerPixel = spanMeters / (minDim * 0.22);
  const latRad = (pos.lat * Math.PI) / 180;
  const zoom = Math.log2((156543.03392 * Math.cos(latRad)) / metersPerPixel);
  return Math.min(17, Math.max(4, zoom));
}

function updateAutoFollow(pos, aheadPos) {
  const target = computeTargetZoom(pos, aheadPos);
  if (autoZoomCurrent == null) {
    autoZoomCurrent = target;
  } else {
    const step = (target - autoZoomCurrent) * FOLLOW_ZOOM_SMOOTHING;
    autoZoomCurrent += Math.max(-FOLLOW_MAX_ZOOM_STEP, Math.min(FOLLOW_MAX_ZOOM_STEP, step));
  }
  playbackMap.setView([pos.lat, pos.lng], autoZoomCurrent);
}

/* ---- single trip playback ---- */
async function openPlayback(id) {
  const trips = await dbGetAll();
  currentPlayTrip = trips.find((t) => t.id === id);
  currentHoliday = null;
  if (!currentPlayTrip || currentPlayTrip.points.length < 2) {
    alert('This trip doesn\u2019t have enough GPS points to play back.');
    return;
  }
  document.getElementById('playbackTitle').textContent = currentPlayTrip.name;
  document.getElementById('legBanner').classList.remove('active');
  showView('playback');
  const timeline = buildTripTimeline(currentPlayTrip.points);
  setupPlaybackMap([{ points: timeline.points }]);
  dismissPhotoMemory();
  memoryShownIds = new Set();

  const allPhotos = await dbGetAllStore('photos');
  const tripPhotos = allPhotos.filter((p) => p.tripId === currentPlayTrip.id);
  const paceProfile = buildPaceProfile(timeline.points, tripPhotos, 0);

  const maxMs = timeline.maxMs;
  playState = { playing: false, speed: 1, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderFrame, paceProfile, displayPoints: timeline.points, events: timeline.events };
  setSpeedButtons(1);
  await loadPhotoPins([currentPlayTrip.id], allPhotos);
  playState.chapters = buildChapters();
  assignStoryPacing(playState.chapters);
  buildScrubber();
  overviewAvailable = playState.chapters.length > 1;
  if (overviewAvailable) enterOverview();
  else enterPlaying(0, false);
}

function renderFrame(simTime) {
  const pts = playState.displayPoints;
  const { idx, pos } = pointAtSimTime(pts, simTime);
  const traced = pts.slice(0, idx + 1).map((p) => [p.lat, p.lng]);
  traced.push([pos.lat, pos.lng]);
  activeLine.setLatLngs(traced);
  playMarker.setLatLng([pos.lat, pos.lng]);

  let dist = 0;
  for (let i = 1; i < traced.length; i++) {
    dist += haversine({ lat: traced[i - 1][0], lng: traced[i - 1][1] }, { lat: traced[i][0], lng: traced[i][1] });
  }

  const ev = eventAtSimTime(simTime);
  const banner = document.getElementById('legBanner');
  if (ev) {
    banner.textContent = stayLabel(ev);
    banner.classList.add('active');
  } else {
    banner.classList.remove('active');
  }
  const arcTip = updateTravelArc(simTime);
  if (arcTip) playMarker.setLatLng(arcTip);
  updateStayPulse(travelArc ? null : ev);

  updateScrubberValue(simTime);
  document.getElementById('readoutClock').textContent = fmtClock(pos.realTs ?? pos.ts);
  document.getElementById('readoutDist').textContent = fmtDistance(dist);
  document.getElementById('readoutSpeed').textContent = ev ? '\u2014' : fmtSpeed(computeSpeedKmh(pts, pos.realTs ?? pos.ts));
  updatePaceBadge(simTime);
  if (followEnabled) {
    const aheadPos = pointAtSimTime(pts, Math.min(simTime + FOLLOW_LOOKAHEAD_MS, playState.maxMs)).pos;
    updateAutoFollow(pos, aheadPos);
  }
}

/* ---- human-readable speed: displacement over a \u00b130 s real-time window, since raw GPS speed
 * is null on imported/merged points and too jittery for a readout anyway ---- */
function computeSpeedKmh(points, realTs) {
  const key = (p) => (p.realTs != null ? p.realTs : p.ts);
  const t0 = Math.max(key(points[0]), realTs - 30000);
  const t1 = Math.min(key(points[points.length - 1]), realTs + 30000);
  if (t1 - t0 < 5000) return null;
  const a = interpolateByRealTs(points, t0);
  const b = interpolateByRealTs(points, t1);
  return (haversine(a, b) / ((t1 - t0) / 1000)) * 3.6;
}
function fmtSpeed(kmh) {
  if (kmh == null) return '\u2014';
  return (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))) + ' km/h';
}

/* ---- holiday (multi-trip) playback ---- */
const GAP_MS = 40000; // synthetic pause between legs, scaled by playback speed like everything else

function buildHolidayTimeline(tripList) {
  let cursor = 0;
  const legs = [];
  const events = [];
  tripList.forEach((trip, i) => {
    const tl = buildTripTimeline(trip.points); // stays inside a leg compress just like in a single trip
    const synthStart = cursor;
    const legPoints = tl.points.map((p) => ({ ...p, ts: synthStart + p.ts }));
    const synthEnd = synthStart + tl.maxMs;
    for (const ev of tl.events) {
      events.push({ ...ev, synthStart: synthStart + ev.synthStart, synthEnd: synthStart + ev.synthEnd });
    }
    legs.push({ tripId: trip.id, name: trip.name, synthStart, synthEnd, distance: trip.distance || pathDistance(legPoints), realStart: trip.startTime, points: legPoints });
    cursor = synthEnd + (i < tripList.length - 1 ? GAP_MS : 0);
  });
  return { legs, events, maxMs: cursor };
}

async function openHolidayPlayback(collectionId) {
  const collections = await dbGetAllStore('collections');
  const collection = collections.find((c) => c.id === collectionId);
  if (!collection) return;
  const allTrips = await dbGetAll();
  const tripsById = Object.fromEntries(allTrips.map((t) => [t.id, t]));
  const tripList = collection.tripIds
    .map((id) => tripsById[id])
    .filter((t) => t && t.points && t.points.length >= 2)
    .sort((a, b) => a.startTime - b.startTime);
  if (tripList.length === 0) {
    alert('None of the trips in this holiday could be found \u2014 they may have been deleted.');
    return;
  }

  const { legs, events, maxMs } = buildHolidayTimeline(tripList);
  currentHoliday = { collection, legs, events };
  currentPlayTrip = null;
  dismissPhotoMemory();
  memoryShownIds = new Set();

  const allPhotos = await dbGetAllStore('photos');
  legs.forEach((leg) => {
    const legPhotos = allPhotos.filter((p) => p.tripId === leg.tripId);
    leg.paceProfile = buildPaceProfile(leg.points, legPhotos, 0);
  });

  document.getElementById('playbackTitle').textContent = collection.name;
  showView('playback');
  setupPlaybackMap(legs);

  playState = { playing: false, speed: 1, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderHolidayFrame };
  setSpeedButtons(1);
  await loadPhotoPins(tripList.map((t) => t.id), allPhotos);
  playState.chapters = buildChapters();
  assignStoryPacing(playState.chapters);
  buildScrubber();
  overviewAvailable = true; // a holiday always has a story worth an overview
  enterOverview();
}

function legAtSimTime(simTime) {
  return currentHoliday.legs.find((l) => simTime >= l.synthStart && simTime <= l.synthEnd) || null;
}

function renderHolidayFrame(simTime) {
  const banner = document.getElementById('legBanner');
  const leg = legAtSimTime(simTime);
  const ev = eventAtSimTime(simTime);
  let pos, partialDist = 0;

  if (leg) {
    const local = pointAtSimTime(leg.points, simTime - leg.synthStart);
    pos = local.pos;
    const traced = leg.points.slice(0, local.idx + 1);
    activeLine.setLatLngs(traced.concat([pos]).map((p) => [p.lat, p.lng]));
    partialDist = pathDistance(traced.concat([pos]));
    banner.textContent = ev ? stayLabel(ev) : `${leg.name} \u00b7 ${fmtDate(leg.realStart)}`;
  } else {
    const prevLeg = [...currentHoliday.legs].reverse().find((l) => l.synthEnd <= simTime);
    const nextLeg = currentHoliday.legs.find((l) => l.synthStart > simTime);
    pos = prevLeg ? prevLeg.points[prevLeg.points.length - 1] : currentHoliday.legs[0].points[0];
    activeLine.setLatLngs([]);
    banner.textContent = nextLeg ? `Traveling to ${nextLeg.name}\u2026` : 'Holiday complete';
  }
  banner.classList.add('active');
  playMarker.setLatLng([pos.lat, pos.lng]);
  const arcTip = updateTravelArc(simTime);
  if (arcTip) playMarker.setLatLng(arcTip);
  updateStayPulse(travelArc ? null : ev);

  let completedDist = 0;
  for (const l of currentHoliday.legs) {
    if (l.synthEnd <= simTime && l !== leg) completedDist += l.distance;
  }
  const totalDist = completedDist + partialDist;

  updateScrubberValue(simTime);
  document.getElementById('readoutClock').textContent = fmtClock(pos.realTs ?? pos.ts);
  document.getElementById('readoutDist').textContent = fmtDistance(totalDist);
  document.getElementById('readoutSpeed').textContent = ev || !leg ? '\u2014' : fmtSpeed(computeSpeedKmh(leg.points, pos.realTs ?? pos.ts));
  updatePaceBadge(simTime);
  if (followEnabled) {
    let aheadPos = pos;
    if (leg) aheadPos = pointAtSimTime(leg.points, Math.min(simTime + FOLLOW_LOOKAHEAD_MS, leg.synthEnd) - leg.synthStart).pos;
    updateAutoFollow(pos, aheadPos);
  }
}

/* ---- shared playback controls ---- */
function playbackTick(nowReal) {
  if (!playState.playing || playState.holding) return;
  const dtReal = nowReal - playState.lastFrameReal;
  playState.lastFrameReal = nowReal;
  const pace = currentPaceMultiplier(playState.simTime);
  const base = currentBaseSpeed(playState.simTime);
  const nextSim = playState.simTime + dtReal * base * pace;
  const photoHit = nextUnshownPhotoBetween(playState.simTime, nextSim);
  if (photoHit) {
    // land exactly on the photo's moment and hold there while the memory card shows
    playState.simTime = Math.min(photoHit.synth, playState.maxMs);
    playState.renderFn(playState.simTime);
    showPhotoMemory(photoHit);
    return;
  }
  playState.simTime = nextSim;
  if (playState.simTime >= playState.maxMs) {
    playState.simTime = playState.maxMs;
    playState.renderFn(playState.simTime);
    pausePlayback();
    showSummary();
    return;
  }
  playState.renderFn(playState.simTime);
  playState.rafId = requestAnimationFrame(playbackTick);
}
function startPlayback() {
  if (playState.holding) dismissPhotoMemory();
  playState.playing = true;
  followEnabled = true;
  document.getElementById('playToggle').textContent = '\u23F8';
  preloadNextPhoto(playState.simTime);
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
  document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}

function updatePaceBadge(simTime) {
  const pace = currentPaceMultiplier(simTime);
  const badge = document.getElementById('paceBadge');
  if (pace < 0.85) {
    badge.textContent = 'Slowing · photo/turn';
    badge.className = 'pace-badge slow';
  } else if (pace > 1.2) {
    badge.textContent = 'Fast-forwarding';
    badge.className = 'pace-badge fast';
  } else {
    badge.textContent = '';
    badge.className = 'pace-badge';
  }
}

/* ---- photos ---- */
function photoSimTime(photo) {
  if (currentHoliday) {
    const leg = currentHoliday.legs.find((l) => l.tripId === photo.tripId);
    if (!leg) return null;
    return synthTimeForRealTs(leg.points, photo.ts); // leg points carry compressed synthetic ts
  }
  if (currentPlayTrip) return synthTimeForRealTs(playState.displayPoints, photo.ts);
  return null;
}

async function loadPhotoPins(tripIds, preloaded) {
  photoMarkers.forEach((m) => playbackMap.removeLayer(m));
  photoMarkers = [];
  photoEntries.forEach((e) => URL.revokeObjectURL(e.url)); // blobs re-read below; free the old URLs
  photoEntries = [];
  const all = preloaded || (await dbGetAllStore('photos'));
  const mine = all.filter((p) => tripIds.includes(p.tripId));
  for (const photo of mine) {
    const url = URL.createObjectURL(photo.blob);
    photoEntries.push({ photo, url, synth: photoSimTime(photo) });
    const icon = L.divIcon({
      className: 'photo-pin',
      html: `<div class="photo-pin-thumb" style="background-image:url('${url}')"></div>`,
      iconSize: [34, 34],
    });
    const marker = L.marker([photo.lat, photo.lng], { icon }).addTo(playbackMap);
    marker.on('click', () => {
      const simTime = photoSimTime(photo);
      if (simTime != null) {
        pausePlayback();
        dismissPhotoMemory();
        playState.simTime = Math.max(0, Math.min(simTime, playState.maxMs));
        rearmMemoriesAfter(playState.simTime);
        playState.renderFn(playState.simTime);
      }
      openPhotoLightbox(photo, url);
    });
    photoMarkers.push(marker);
  }
}

/* ---- photo memory card: when playback reaches a photo's moment, glide to a stop and show it
 * big with its date/time, Google Photos memory style, then resume automatically. Photos taken
 * around the same moment share one hold and cycle as a stack instead of stop-starting playback
 * once per photo. ---- */
const MEMORY_HOLD_MS = 2600; // a single photo
const MEMORY_GROUP_HOLD_MS = 1900; // per photo while cycling a stack
const MEMORY_GROUP_SPAN_MS = 90000; // synth window binding photos into one held moment

function nextUnshownPhotoBetween(fromSim, toSim) {
  let best = null;
  for (const entry of photoEntries) {
    if (entry.synth == null || memoryShownIds.has(entry.photo.id)) continue;
    if (entry.synth > fromSim && entry.synth <= toSim && (!best || entry.synth < best.synth)) best = entry;
  }
  return best;
}

function tripStartRealTs() {
  if (currentHoliday) return currentHoliday.legs[0].points[0].realTs;
  if (currentPlayTrip && playState.displayPoints) return playState.displayPoints[0].realTs;
  return null;
}

function photoCaption(photo) {
  const datePart = new Date(photo.ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  let caption = `${datePart} · ${fmtClock(photo.ts)}`;
  const start = tripStartRealTs();
  if (start != null) {
    const day = nightsBetween(start, photo.ts) + 1;
    if (day > 1) caption += ` · Day ${day}`;
  }
  return caption;
}

function collectMemoryGroup(entry) {
  return photoEntries
    .filter((e) => e.synth != null && !memoryShownIds.has(e.photo.id) && Math.abs(e.synth - entry.synth) <= MEMORY_GROUP_SPAN_MS)
    .sort((a, b) => a.synth - b.synth);
}

function preloadNextPhoto(afterSynth) {
  let next = null;
  for (const e of photoEntries) {
    if (e.synth != null && e.synth > afterSynth && (!next || e.synth < next.synth)) next = e;
  }
  if (next) new Image().src = next.url; // decode before its card fades in
}

function renderMemoryPhoto() {
  const { group, index } = memoryActive;
  const entry = group[index];
  const img = document.getElementById('photoMemoryImg');
  img.src = entry.url;
  img.classList.remove('kenburns');
  void img.offsetWidth; // restart the drift for each photo
  img.classList.add('kenburns');
  document.getElementById('photoMemoryCaption').textContent = photoCaption(entry.photo);
  const dots = document.getElementById('photoMemoryDots');
  dots.innerHTML = group.length > 1 ? group.map((_, i) => `<span class="${i === index ? 'on' : ''}"></span>`).join('') : '';
  preloadNextPhoto(entry.synth);
}

function showPhotoMemory(entry) {
  const group = collectMemoryGroup(entry);
  if (group.length === 0) return;
  memoryActive = { group, index: 0 };
  group.forEach((e) => memoryShownIds.add(e.photo.id));
  renderMemoryPhoto();
  document.getElementById('photoMemory').classList.add('active');
  playState.holding = true;
  scheduleMemoryStep();
}

function scheduleMemoryStep() {
  const hold = memoryActive.group.length > 1 ? MEMORY_GROUP_HOLD_MS : MEMORY_HOLD_MS;
  memoryTimer = setTimeout(() => {
    memoryTimer = null;
    if (!memoryActive) return;
    if (memoryActive.index < memoryActive.group.length - 1) {
      memoryActive.index++;
      const entry = memoryActive.group[memoryActive.index];
      playState.simTime = Math.max(0, Math.min(entry.synth, playState.maxMs)); // marker hops along with the stack
      playState.renderFn(playState.simTime);
      renderMemoryPhoto();
      scheduleMemoryStep();
      return;
    }
    dismissPhotoMemory();
    if (playState.playing) {
      playState.lastFrameReal = performance.now();
      playState.rafId = requestAnimationFrame(playbackTick);
    }
  }, hold);
}

function dismissPhotoMemory() {
  if (memoryTimer) { clearTimeout(memoryTimer); memoryTimer = null; }
  memoryActive = null;
  playState.holding = false;
  document.getElementById('photoMemory').classList.remove('active');
}

/* photos ahead of this point may fire again — used after seeking backwards */
function rearmMemoriesAfter(simTime) {
  for (const entry of photoEntries) {
    if (entry.synth != null && entry.synth > simTime) memoryShownIds.delete(entry.photo.id);
  }
}

function currentPlaybackPosition() {
  if (currentHoliday) {
    const leg = legAtSimTime(playState.simTime) || currentHoliday.legs[0];
    const clamped = Math.min(Math.max(playState.simTime, leg.synthStart), leg.synthEnd);
    const { pos } = pointAtSimTime(leg.points, clamped - leg.synthStart);
    return { lat: pos.lat, lng: pos.lng, ts: pos.realTs ?? leg.realStart, tripId: leg.tripId };
  }
  const { pos } = pointAtSimTime(playState.displayPoints, playState.simTime);
  return { lat: pos.lat, lng: pos.lng, ts: pos.realTs ?? pos.ts, tripId: currentPlayTrip.id };
}

/* ---- EXIF: place a photo by its own GPS/timestamp instead of the scrubber position ---- */
function readExifGps(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(parseExif(reader.result)); } catch (e) { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 128 * 1024)); // EXIF lives in the first few KB
  });
}

function parseExif(buf) {
  const view = new DataView(buf);
  if (view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xffe1) {
      const exifStart = offset + 4;
      if (view.getUint32(exifStart) !== 0x45786966) { offset += 2 + view.getUint16(offset + 2); continue; }
      return parseTiff(view, exifStart + 6);
    }
    if ((marker & 0xff00) !== 0xff00) break;
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function parseTiff(view, tiffStart) {
  const little = view.getUint16(tiffStart) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  const typeSize = (t) => ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[t] || 1);

  function readIfd(ifdOffset) {
    const count = u16(ifdOffset);
    const entries = {};
    for (let i = 0; i < count; i++) {
      const eo = ifdOffset + 2 + i * 12;
      entries[u16(eo)] = { type: u16(eo + 2), numValues: u32(eo + 4), valueOffset: eo + 8 };
    }
    return entries;
  }
  function readValue(entry) {
    const size = typeSize(entry.type) * entry.numValues;
    const base = size > 4 ? tiffStart + u32(entry.valueOffset) : entry.valueOffset;
    if (entry.type === 2) {
      let s = '';
      for (let i = 0; i < entry.numValues - 1; i++) s += String.fromCharCode(view.getUint8(base + i));
      return s;
    }
    if (entry.type === 5) {
      const out = [];
      for (let i = 0; i < entry.numValues; i++) {
        const num = u32(base + i * 8), den = u32(base + i * 8 + 4);
        out.push(den ? num / den : 0);
      }
      return out;
    }
    if (entry.type === 3) return u16(base);
    if (entry.type === 4) return u32(base);
    return null;
  }

  const ifd0 = readIfd(tiffStart + u32(tiffStart + 4));
  let dateTimeOriginal = null;
  if (ifd0[0x0132]) dateTimeOriginal = readValue(ifd0[0x0132]);
  if (ifd0[0x8769]) {
    const subIfd = readIfd(tiffStart + readValue(ifd0[0x8769]));
    if (subIfd[0x9003]) dateTimeOriginal = readValue(subIfd[0x9003]);
  }

  let lat = null, lng = null, gpsTs = null;
  if (ifd0[0x8825]) {
    const gps = readIfd(tiffStart + readValue(ifd0[0x8825]));
    if (gps[1] && gps[2] && gps[3] && gps[4]) {
      const latRef = readValue(gps[1]), latDms = readValue(gps[2]);
      const lngRef = readValue(gps[3]), lngDms = readValue(gps[4]);
      lat = (latDms[0] + latDms[1] / 60 + latDms[2] / 3600) * (latRef === 'S' ? -1 : 1);
      lng = (lngDms[0] + lngDms[1] / 60 + lngDms[2] / 3600) * (lngRef === 'W' ? -1 : 1);
    }
    if (gps[29] && gps[7]) {
      const dateStr = readValue(gps[29]);
      const time = readValue(gps[7]);
      const [y, mo, d] = dateStr.split(':').map(Number);
      gpsTs = Date.UTC(y, mo - 1, d, time[0], time[1], Math.floor(time[2]));
    }
  }

  let ts = gpsTs;
  if (ts == null && dateTimeOriginal) {
    const m = dateTimeOriginal.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  if (lat == null && ts == null) return null;
  return { lat, lng, ts };
}

function interpolateByRealTs(points, targetTs) {
  const key = (p) => (p.realTs != null ? p.realTs : p.ts);
  if (targetTs <= key(points[0])) return points[0];
  const last = points[points.length - 1];
  if (targetTs >= key(last)) return last;
  const i = lowerBoundIdx(points, targetTs, key);
  const a = points[i], b = points[i + 1];
  const span = key(b) - key(a) || 1;
  const f = (targetTs - key(a)) / span;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

async function resolvePhotoAnchor(file) {
  const fallback = currentPlaybackPosition();
  const exif = await readExifGps(file);
  if (!exif || (exif.lat == null && exif.ts == null)) return fallback;

  let tripId = fallback.tripId;
  let points = currentHoliday ? null : currentPlayTrip.points;

  if (exif.ts == null && exif.lat != null) {
    // no timestamp — snap to the nearest track point by location and take its time
    const candidates = currentHoliday
      ? currentHoliday.legs.map((l) => ({ id: l.tripId, pts: l.points }))
      : [{ id: tripId, pts: points }];
    let bestTrip = tripId, bestDist = Infinity, bestPoint = null;
    for (const c of candidates) {
      const { point, dist } = nearestTrackPoint(c.pts, exif);
      if (dist < bestDist) { bestDist = dist; bestPoint = point; bestTrip = c.id; }
    }
    if (bestPoint && bestDist <= PHOTO_GPS_ONLY_MAX_M) {
      return { tripId: bestTrip, lat: exif.lat, lng: exif.lng, ts: bestPoint.realTs != null ? bestPoint.realTs : bestPoint.ts };
    }
    return { tripId, lat: exif.lat, lng: exif.lng, ts: fallback.ts };
  }

  if (currentHoliday && exif.ts != null) {
    const BUFFER_MS = 10 * 60 * 1000;
    const match = currentHoliday.legs.find((l) => {
      const first = l.points[0].realTs, last = l.points[l.points.length - 1].realTs;
      return exif.ts >= first - BUFFER_MS && exif.ts <= last + BUFFER_MS;
    });
    if (match) { tripId = match.tripId; points = match.points; }
  }

  let lat = exif.lat, lng = exif.lng;
  if (lat == null && exif.ts != null && points) {
    const pos = interpolateByRealTs(points, exif.ts);
    lat = pos.lat;
    lng = pos.lng;
  }
  if (lat == null) { lat = fallback.lat; lng = fallback.lng; }

  const ts = exif.ts != null ? exif.ts : fallback.ts;
  return { tripId, lat, lng, ts };
}

/* ---- home-screen bulk photo add: auto-match a whole batch to the right trip by EXIF time + GPS ---- */
const PHOTO_TRACK_MAX_M = 2000; // a photo whose GPS is further than this from the track at its time isn't from that trip
const PHOTO_GPS_ONLY_MAX_M = 250; // matching by location alone needs to be much tighter

function nearestTrackPoint(points, loc) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = haversine(p, loc);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { point: best, dist: bestD };
}

/* Returns { trip, lat, lng, ts } or null. Time is the primary key, validated/refined by GPS when
 * present; photos with GPS but no timestamp match by location and take their time from the track. */
function matchPhotoToTrip(trips, exif) {
  const BUFFER_MS = 10 * 60 * 1000;
  const usable = trips.filter((t) => t.points && t.points.length >= 2);

  if (exif.ts != null) {
    let best = null, bestScore = Infinity;
    for (const t of usable) {
      const start = t.points[0].ts - BUFFER_MS;
      const end = (t.endTime || t.points[t.points.length - 1].ts) + BUFFER_MS;
      if (exif.ts < start || exif.ts > end) continue;
      let score;
      if (exif.lat != null) {
        const d = haversine(interpolateByRealTs(t.points, exif.ts), exif);
        if (d > PHOTO_TRACK_MAX_M) continue;
        score = d;
      } else {
        const center = (t.points[0].ts + (t.endTime || t.points[t.points.length - 1].ts)) / 2;
        score = Math.abs(exif.ts - center);
      }
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (!best) return null;
    let lat = exif.lat, lng = exif.lng;
    if (lat == null) {
      const pos = interpolateByRealTs(best.points, exif.ts);
      lat = pos.lat;
      lng = pos.lng;
    }
    return { trip: best, lat, lng, ts: exif.ts };
  }

  if (exif.lat != null) {
    let best = null, bestDist = Infinity, bestPoint = null;
    for (const t of usable) {
      const { point, dist } = nearestTrackPoint(t.points, exif);
      if (dist < bestDist) { bestDist = dist; best = t; bestPoint = point; }
    }
    if (!best || bestDist > PHOTO_GPS_ONLY_MAX_M) return null;
    return { trip: best, lat: exif.lat, lng: exif.lng, ts: bestPoint.ts };
  }

  return null;
}

async function bulkAddPhotos(files) {
  const trips = await dbGetAll();
  let matched = 0, skipped = 0;
  for (const file of files) {
    const exif = await readExifGps(file);
    const match = exif ? matchPhotoToTrip(trips, exif) : null;
    if (!match) { skipped++; continue; }
    await dbPutStore('photos', {
      id: 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      tripId: match.trip.id, lat: match.lat, lng: match.lng, ts: match.ts, blob: file,
    });
    matched++;
  }
  await renderHome();
  const skippedMsg = skipped
    ? ` ${skipped} couldn’t be matched (no GPS/time metadata, or no saved trip covers that time and place) and ${skipped === 1 ? 'was' : 'were'} skipped.`
    : '';
  alert(`${matched} photo${matched === 1 ? '' : 's'} added to your trips.${skippedMsg}`);
}

let lightboxPhoto = null;
function openPhotoLightbox(photo, url) {
  lightboxPhoto = photo;
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightboxMeta').textContent = `${fmtDate(photo.ts)} \u00b7 ${fmtClock(photo.ts)}`;
  document.getElementById('photoLightbox').classList.add('active');
}

/* ================= GOOGLE TIMELINE IMPORT ================= */
let timelineData = null;
let rawPositions = [];
let candidateTrips = [];

const ACTIVITY_LABELS = {
  WALKING: 'Walk', RUNNING: 'Run', ON_BICYCLE: 'Cycle',
  IN_PASSENGER_VEHICLE: 'Drive', IN_BUS: 'Bus', IN_TRAIN: 'Train',
  IN_SUBWAY: 'Subway', IN_FERRY: 'Ferry', FLYING: 'Flight',
  IN_ROAD_VEHICLE: 'Drive', IN_RAIL_VEHICLE: 'Train', UNKNOWN: 'Trip',
};
const ROAD_PROFILES = { Walk: 'walking', Run: 'walking', Cycle: 'cycling', Drive: 'driving', Bus: 'driving' };
const OSRM_BASE = 'https://router.project-osrm.org/route/v1';

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
      alert('Could not read that file \u2014 is it the Timeline.json export?');
      showView('home');
      return;
    }
    document.getElementById('loadingMessage').textContent = 'Indexing GPS pings\u2026';
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

    let distance = fallbackDistance;
    if (distance == null) distance = pathDistance(points);
    if (distance < 20) continue;

    candidates.push({
      key: `${seg._startMs}-${seg._endMs}`,
      name: `${typeLabel} \u00b7 ${fmtDate(seg._startMs)}`,
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

async function snapToRoad(points, typeLabel) {
  const profile = ROAD_PROFILES[typeLabel];
  if (!profile || points.length !== 2) return points;
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${OSRM_BASE}/${profile}/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return points;
    const data = await res.json();
    const coordsOut = data.routes?.[0]?.geometry?.coordinates;
    if (!coordsOut || coordsOut.length < 2) return points;
    const t0 = points[0].ts, t1 = points[1].ts;
    const totalDist = data.routes[0].distance || 1;
    let acc = 0;
    const out = [];
    for (let i = 0; i < coordsOut.length; i++) {
      const [lng, lat] = coordsOut[i];
      if (i > 0) acc += haversine({ lat: coordsOut[i - 1][1], lng: coordsOut[i - 1][0] }, { lat, lng });
      const f = totalDist > 0 ? acc / totalDist : i / (coordsOut.length - 1);
      out.push({ lat, lng, ts: t0 + (t1 - t0) * Math.min(1, f) });
    }
    return out;
  } catch (e) {
    return points; // offline or the free demo server is unavailable — keep the straight line
  }
}

async function importSelectedCandidates() {
  const checks = [...document.querySelectorAll('.candidateCheck:checked')];
  if (checks.length === 0) return;
  showView('loading');
  let done = 0;
  for (const chk of checks) {
    const c = candidateTrips[Number(chk.dataset.idx)];
    let points = c.points;
    let distance = c.distance;
    if (c.needsRoadSnap) {
      document.getElementById('loadingMessage').textContent = `Snapping to roads (${done + 1}/${checks.length})\u2026`;
      const snapped = await snapToRoad(points, c.typeLabel);
      if (snapped !== points) {
        points = snapped;
        distance = pathDistance(points);
        await new Promise((r) => setTimeout(r, 1100)); // respect the free OSRM demo server's 1 req/sec limit
      }
    } else {
      document.getElementById('loadingMessage').textContent = `Saving trips (${done + 1}/${checks.length})\u2026`;
    }
    await dbPut({ id: 'tl-' + c.key, name: c.name, startTime: c.startTime, endTime: c.endTime, points, distance });
    done++;
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
    if (playbackMode === 'playing' && overviewAvailable) {
      enterOverview();
      return;
    }
    pausePlayback();
    dismissPhotoMemory();
    hideSummary();
    if (playbackMap) playbackMap.stop(); // kill any in-flight camera animation before the view goes away
    photoEntries.forEach((e) => URL.revokeObjectURL(e.url));
    photoEntries = [];
    currentHoliday = null;
    showView('home');
    renderHome();
  });

  document.getElementById('overviewPlayBtn').addEventListener('click', () => enterPlaying(0, true));
  document.getElementById('storylineStrip').addEventListener('scroll', () => requestAnimationFrame(highlightCenteredChapter));
  document.getElementById('momentCloseBtn').addEventListener('click', closeMomentSheet);
  document.getElementById('summaryReplayBtn').addEventListener('click', () => {
    hideSummary();
    enterPlaying(0, true);
  });
  document.getElementById('summaryOverviewBtn').addEventListener('click', () => {
    hideSummary();
    enterOverview();
  });
  document.getElementById('summaryOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideSummary();
  });

  document.getElementById('playToggle').addEventListener('click', () => {
    if (playState.playing) pausePlayback();
    else { playState.lastFrameReal = performance.now(); startPlayback(); }
  });

  const scrubEl = document.getElementById('storyScrubber');
  let scrubbing = false;
  const doScrub = (e) => {
    pausePlayback();
    dismissPhotoMemory();
    followEnabled = true;
    playState.simTime = Math.max(0, Math.min(simFromScrubberX(e.clientX), playState.maxMs));
    rearmMemoriesAfter(playState.simTime);
    playState.renderFn(playState.simTime);
  };
  scrubEl.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrubEl.setPointerCapture(e.pointerId);
    doScrub(e);
  });
  scrubEl.addEventListener('pointermove', (e) => { if (scrubbing) doScrub(e); });
  scrubEl.addEventListener('pointerup', () => { scrubbing = false; });

  document.getElementById('photoMemory').addEventListener('click', () => {
    const active = memoryActive;
    dismissPhotoMemory();
    pausePlayback();
    if (active) {
      const entry = active.group[active.index];
      openPhotoLightbox(entry.photo, entry.url);
    }
  });

  document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => {
    b.addEventListener('click', () => setSpeedButtons(Number(b.dataset.speed)));
  });

  document.getElementById('deleteTripBtn').addEventListener('click', async () => {
    if (currentHoliday) {
      if (confirm('Delete this holiday? The individual trips inside it will stay saved.')) {
        await dbDeleteStore('collections', currentHoliday.collection.id);
        currentHoliday = null;
        pausePlayback();
        showView('home');
        renderHome();
      }
    } else if (currentPlayTrip) {
      if (confirm('Delete this trip permanently?')) {
        await dbDelete(currentPlayTrip.id);
        pausePlayback();
        showView('home');
        renderHome();
      }
    }
  });

  document.getElementById('renameTripBtn').addEventListener('click', () => {
    const isHoliday = !!currentHoliday;
    renameTarget = isHoliday ? { type: 'holiday', id: currentHoliday.collection.id } : { type: 'trip', id: currentPlayTrip.id };
    document.getElementById('renameModalTitle').textContent = isHoliday ? 'Rename holiday' : 'Rename trip';
    document.getElementById('renameInput').value = isHoliday ? currentHoliday.collection.name : currentPlayTrip.name;
    document.getElementById('renameModal').classList.add('active');
  });
  document.getElementById('cancelRename').addEventListener('click', () => {
    document.getElementById('renameModal').classList.remove('active');
  });
  document.getElementById('confirmRename').addEventListener('click', async () => {
    const val = document.getElementById('renameInput').value.trim();
    if (!val || !renameTarget) { document.getElementById('renameModal').classList.remove('active'); return; }
    document.getElementById('renameModal').classList.remove('active');
    if (renameTarget.type === 'holiday') {
      currentHoliday.collection.name = val;
      await dbPutStore('collections', currentHoliday.collection);
    } else {
      currentPlayTrip.name = val;
      await dbPut(currentPlayTrip);
    }
    document.getElementById('playbackTitle').textContent = val;
    renameTarget = null;
  });

  document.getElementById('selectModeBtn').addEventListener('click', () => setSelectMode(!selectMode));
  document.getElementById('addPhotosHomeBtn').addEventListener('click', () => document.getElementById('homePhotoFileInput').click());
  document.getElementById('homePhotoFileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    await bulkAddPhotos(files);
  });
  document.getElementById('fabCombine').addEventListener('click', () => {
    if (selectedTripIds.size < 2) return;
    document.getElementById('holidayNameInput').value = `Holiday \u00b7 ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
    document.getElementById('holidayNameModal').classList.add('active');
  });
  document.getElementById('cancelHolidayName').addEventListener('click', () => {
    document.getElementById('holidayNameModal').classList.remove('active');
  });
  document.getElementById('confirmHolidayName').addEventListener('click', async () => {
    const name = document.getElementById('holidayNameInput').value.trim() || 'Untitled holiday';
    document.getElementById('holidayNameModal').classList.remove('active');
    await dbPutStore('collections', { id: 'col-' + Date.now(), name, tripIds: [...selectedTripIds], createdAt: Date.now() });
    setSelectMode(false);
  });

  document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
    const n = selectedTripIds.size;
    if (n === 0) return;
    if (!confirm(`Delete ${n} trip${n === 1 ? '' : 's'} permanently? This can't be undone.`)) return;
    for (const id of selectedTripIds) await dbDelete(id);
    setSelectMode(false);
  });
  document.getElementById('mergeBtn').addEventListener('click', () => {
    if (selectedTripIds.size < 2) return;
    document.getElementById('mergeNameInput').value = `Trip \u00b7 ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    document.getElementById('mergeNameModal').classList.add('active');
  });
  document.getElementById('cancelMergeName').addEventListener('click', () => {
    document.getElementById('mergeNameModal').classList.remove('active');
  });
  document.getElementById('confirmMergeName').addEventListener('click', async () => {
    const name = document.getElementById('mergeNameInput').value.trim() || 'Merged trip';
    document.getElementById('mergeNameModal').classList.remove('active');
    await mergeSelectedTrips(name);
  });

  document.getElementById('addPhotoBtn').addEventListener('click', () => document.getElementById('photoFileInput').click());
  document.getElementById('photoFileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    for (const file of files) {
      const anchor = await resolvePhotoAnchor(file);
      await dbPutStore('photos', {
        id: 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        tripId: anchor.tripId, lat: anchor.lat, lng: anchor.lng, ts: anchor.ts, blob: file,
      });
    }
    const ids = currentHoliday ? currentHoliday.legs.map((l) => l.tripId) : [currentPlayTrip.id];
    await loadPhotoPins(ids);
  });
  document.getElementById('lightboxCloseBtn').addEventListener('click', () => {
    document.getElementById('photoLightbox').classList.remove('active');
  });
  document.getElementById('lightboxDeleteBtn').addEventListener('click', async () => {
    if (lightboxPhoto && confirm('Delete this photo?')) {
      await dbDeleteStore('photos', lightboxPhoto.id);
      document.getElementById('photoLightbox').classList.remove('active');
      closeMomentSheet();
      const ids = currentHoliday ? currentHoliday.legs.map((l) => l.tripId) : [currentPlayTrip.id];
      await loadPhotoPins(ids);
      if (playbackMode === 'overview') enterOverview(); // re-cluster moments and refresh the strip
    }
  });

  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('timelineFileInput').click());
  document.getElementById('timelineFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
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
