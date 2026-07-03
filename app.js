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
let liveThumbMarker = null;
let liveThumbPhotoId = null;
let uniformModeEnabled = false;
let followEnabled = false;
let autoZoomCurrent = null;
let playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0, maxMs: 0, renderFn: null };

function pointAtSimTime(points, simTime) {
  const t0 = points[0].ts;
  const target = t0 + simTime;
  if (target <= points[0].ts) return { idx: 0, pos: points[0] };
  if (target >= points[points.length - 1].ts) return { idx: points.length - 1, pos: points[points.length - 1] };
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].ts <= target && points[i + 1].ts >= target) {
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
  }
  return { idx: points.length - 1, pos: points[points.length - 1] };
}

/* ---- adaptive playback pace: slow near photos/turns, fast through stationary or steady stretches ----
 * Local speed describes a whole point-to-point interval, so it's stored as a flat "base" multiplier
 * spanning that interval (a stop is fast-forwarded evenly for its whole duration, however long).
 * Turns and photos are momentary, so they're stored as smooth time-radius "dips" layered on top. */
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
    let base = 1;
    if (localSpeed[i] < 0.3) base = 3; // stationary/parked — fast-forward through it
    else if (localSpeed[i] > 4) base = 1.4; // steady, uneventful travel
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
      dips.push({ sim: points[i].ts - simOffset, strength: Math.min(1, diff / 90) * 0.6, radius: TURN_RADIUS_MS });
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
    dips.push({ sim: nearestTs - simOffset, strength: 0.65, radius: PHOTO_RADIUS_MS });
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
    if (!leg) return 3.5; // synthetic gap between legs — nothing to see, fast-forward through it
    return paceMultiplierAt(leg.paceProfile, simTime);
  }
  return paceMultiplierAt(playState.paceProfile, simTime);
}

/* ---- uniform stage duration: normalize a leg's (or a whole single trip's) real length to one target wall-clock duration ---- */
const UNIFORM_TARGET_MS = 20000;
function clampSpeed(v) {
  return Math.min(5000, Math.max(1, v));
}
function currentBaseSpeed(simTime) {
  if (!uniformModeEnabled) return playState.speed;
  if (currentHoliday) {
    const leg = legAtSimTime(simTime);
    if (leg) return clampSpeed((leg.synthEnd - leg.synthStart) / UNIFORM_TARGET_MS);
    return playState.speed; // in the gap between legs — no single stage to normalize to
  }
  return clampSpeed(playState.maxMs / UNIFORM_TARGET_MS);
}

function setupPlaybackMap(legsForGhost) {
  if (playbackMap) { playbackMap.remove(); playbackMap = null; }
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
  photoMarkers = [];
  liveThumbMarker = null;
  liveThumbPhotoId = null;
  followEnabled = false;
  autoZoomCurrent = null;
}

/* ---- auto-follow camera: zoom based on how much ground is covered in the next few seconds,
 * so a fast leg (flight/highway) doesn't fly off-screen and a slow one isn't zoomed out to nothing ---- */
const FOLLOW_LOOKAHEAD_MS = 15000;
const FOLLOW_ZOOM_SMOOTHING = 0.08;

function computeTargetZoom(pos, aheadPos) {
  const spanMeters = Math.max(30, haversine(pos, aheadPos));
  const size = playbackMap.getSize ? playbackMap.getSize() : { x: 360, y: 640 };
  const minDim = Math.max(100, Math.min(size.x, size.y));
  const metersPerPixel = spanMeters / (minDim * 0.45);
  const latRad = (pos.lat * Math.PI) / 180;
  const zoom = Math.log2((156543.03392 * Math.cos(latRad)) / metersPerPixel);
  return Math.min(18, Math.max(3, zoom));
}

function updateAutoFollow(pos, aheadPos) {
  const target = computeTargetZoom(pos, aheadPos);
  autoZoomCurrent = autoZoomCurrent == null ? target : autoZoomCurrent + (target - autoZoomCurrent) * FOLLOW_ZOOM_SMOOTHING;
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
  setupPlaybackMap([{ points: currentPlayTrip.points }]);

  const allPhotos = await dbGetAllStore('photos');
  const tripPhotos = allPhotos.filter((p) => p.tripId === currentPlayTrip.id);
  const paceProfile = buildPaceProfile(currentPlayTrip.points, tripPhotos, currentPlayTrip.points[0].ts);

  const maxMs = currentPlayTrip.points[currentPlayTrip.points.length - 1].ts - currentPlayTrip.points[0].ts;
  playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderFrame, paceProfile };
  setSpeedButtons(20);
  setUniformMode(uniformModeEnabled);
  document.getElementById('scrubber').max = maxMs;
  document.getElementById('scrubber').value = 0;
  renderFrame(0);
  document.getElementById('playToggle').textContent = '\u25B6';
  await loadPhotoPins([currentPlayTrip.id], allPhotos);
}

function renderFrame(simTime) {
  const pts = currentPlayTrip.points;
  const { idx, pos } = pointAtSimTime(pts, simTime);
  const traced = pts.slice(0, idx + 1).map((p) => [p.lat, p.lng]);
  traced.push([pos.lat, pos.lng]);
  activeLine.setLatLngs(traced);
  playMarker.setLatLng([pos.lat, pos.lng]);

  let dist = 0;
  for (let i = 1; i < traced.length; i++) {
    dist += haversine({ lat: traced[i - 1][0], lng: traced[i - 1][1] }, { lat: traced[i][0], lng: traced[i][1] });
  }

  document.getElementById('scrubber').value = simTime;
  document.getElementById('readoutClock').textContent = fmtClock(pos.ts);
  document.getElementById('readoutDist').textContent = fmtDistance(dist);
  document.getElementById('readoutSpeed').textContent = pos.speed ? (pos.speed * 3.6).toFixed(1) + ' km/h' : '\u2014';
  updatePaceBadge(simTime);
  updateLivePhotoThumb(pos, simTime);
  if (followEnabled) {
    const aheadPos = pointAtSimTime(pts, Math.min(simTime + FOLLOW_LOOKAHEAD_MS, playState.maxMs)).pos;
    updateAutoFollow(pos, aheadPos);
  }
}

/* ---- holiday (multi-trip) playback ---- */
const GAP_MS = 40000; // synthetic pause between legs, scaled by playback speed like everything else

function buildHolidayTimeline(tripList) {
  let cursor = 0;
  const legs = [];
  tripList.forEach((trip, i) => {
    const pts = trip.points;
    const origStart = pts[0].ts;
    const synthStart = cursor;
    const legPoints = pts.map((p) => ({
      lat: p.lat, lng: p.lng, speed: p.speed,
      ts: synthStart + (p.ts - origStart),
      realTs: p.ts,
    }));
    const synthEnd = legPoints[legPoints.length - 1].ts;
    legs.push({ tripId: trip.id, name: trip.name, synthStart, synthEnd, distance: trip.distance || pathDistance(legPoints), realStart: trip.startTime, points: legPoints });
    cursor = synthEnd + (i < tripList.length - 1 ? GAP_MS : 0);
  });
  return { legs, maxMs: cursor };
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

  const { legs, maxMs } = buildHolidayTimeline(tripList);
  currentHoliday = { collection, legs };
  currentPlayTrip = null;

  const allPhotos = await dbGetAllStore('photos');
  legs.forEach((leg) => {
    const legPhotos = allPhotos.filter((p) => p.tripId === leg.tripId);
    leg.paceProfile = buildPaceProfile(leg.points, legPhotos, 0);
  });

  document.getElementById('playbackTitle').textContent = collection.name;
  showView('playback');
  setupPlaybackMap(legs);

  playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderHolidayFrame };
  setSpeedButtons(20);
  setUniformMode(uniformModeEnabled);
  document.getElementById('scrubber').max = maxMs;
  document.getElementById('scrubber').value = 0;
  renderHolidayFrame(0);
  document.getElementById('playToggle').textContent = '\u25B6';
  await loadPhotoPins(tripList.map((t) => t.id), allPhotos);
}

function legAtSimTime(simTime) {
  return currentHoliday.legs.find((l) => simTime >= l.synthStart && simTime <= l.synthEnd) || null;
}

function renderHolidayFrame(simTime) {
  const banner = document.getElementById('legBanner');
  const leg = legAtSimTime(simTime);
  let pos, partialDist = 0;

  if (leg) {
    const local = pointAtSimTime(leg.points, simTime - leg.synthStart);
    pos = local.pos;
    const traced = leg.points.slice(0, local.idx + 1);
    activeLine.setLatLngs(traced.concat([pos]).map((p) => [p.lat, p.lng]));
    partialDist = pathDistance(traced.concat([pos]));
    banner.textContent = `${leg.name} \u00b7 ${fmtDate(leg.realStart)}`;
  } else {
    const prevLeg = [...currentHoliday.legs].reverse().find((l) => l.synthEnd <= simTime);
    const nextLeg = currentHoliday.legs.find((l) => l.synthStart > simTime);
    pos = prevLeg ? prevLeg.points[prevLeg.points.length - 1] : currentHoliday.legs[0].points[0];
    activeLine.setLatLngs([]);
    banner.textContent = nextLeg ? `Traveling to ${nextLeg.name}\u2026` : 'Holiday complete';
  }
  banner.classList.add('active');
  playMarker.setLatLng([pos.lat, pos.lng]);

  let completedDist = 0;
  for (const l of currentHoliday.legs) {
    if (l.synthEnd <= simTime && l !== leg) completedDist += l.distance;
  }
  const totalDist = completedDist + partialDist;

  document.getElementById('scrubber').value = simTime;
  document.getElementById('readoutClock').textContent = fmtClock(pos.realTs ?? pos.ts);
  document.getElementById('readoutDist').textContent = fmtDistance(totalDist);
  document.getElementById('readoutSpeed').textContent = pos.speed ? (pos.speed * 3.6).toFixed(1) + ' km/h' : '\u2014';
  updatePaceBadge(simTime);
  updateLivePhotoThumb(pos, simTime);
  if (followEnabled) {
    let aheadPos = pos;
    if (leg) aheadPos = pointAtSimTime(leg.points, Math.min(simTime + FOLLOW_LOOKAHEAD_MS, leg.synthEnd) - leg.synthStart).pos;
    updateAutoFollow(pos, aheadPos);
  }
}

/* ---- shared playback controls ---- */
function playbackTick(nowReal) {
  if (!playState.playing) return;
  const dtReal = nowReal - playState.lastFrameReal;
  playState.lastFrameReal = nowReal;
  const pace = currentPaceMultiplier(playState.simTime);
  const base = currentBaseSpeed(playState.simTime);
  playState.simTime += dtReal * base * pace;
  if (playState.simTime >= playState.maxMs) {
    playState.simTime = playState.maxMs;
    playState.renderFn(playState.simTime);
    pausePlayback();
    return;
  }
  playState.renderFn(playState.simTime);
  playState.rafId = requestAnimationFrame(playbackTick);
}
function startPlayback() {
  playState.playing = true;
  followEnabled = true;
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
  document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}

function setUniformMode(on) {
  uniformModeEnabled = on;
  document.getElementById('uniformSpeedBtn').classList.toggle('active', on);
  if (on) document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => b.classList.remove('active'));
  else setSpeedButtons(playState.speed);
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
    const origStart = leg.points[0].realTs;
    return leg.synthStart + (photo.ts - origStart);
  }
  if (currentPlayTrip) return photo.ts - currentPlayTrip.points[0].ts;
  return null;
}

async function loadPhotoPins(tripIds, preloaded) {
  photoMarkers.forEach((m) => playbackMap.removeLayer(m));
  photoMarkers = [];
  photoEntries = [];
  const all = preloaded || (await dbGetAllStore('photos'));
  const mine = all.filter((p) => tripIds.includes(p.tripId));
  for (const photo of mine) {
    const url = URL.createObjectURL(photo.blob);
    photoEntries.push({ photo, url });
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
        playState.simTime = Math.max(0, Math.min(simTime, playState.maxMs));
        playState.renderFn(playState.simTime);
      }
      openPhotoLightbox(photo, url);
    });
    photoMarkers.push(marker);
  }
}

/* ---- live photo callout: surfaces the nearest photo right alongside the moving marker ---- */
function nearestPhotoEntryAt(simTime) {
  let best = null, bestDist = Infinity;
  for (const entry of photoEntries) {
    const st = photoSimTime(entry.photo);
    if (st == null) continue;
    const dist = Math.abs(st - simTime);
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  return best && bestDist <= PHOTO_RADIUS_MS ? best : null;
}

function updateLivePhotoThumb(pos, simTime) {
  const nearest = nearestPhotoEntryAt(simTime);
  if (!nearest) {
    if (liveThumbMarker) { playbackMap.removeLayer(liveThumbMarker); liveThumbMarker = null; liveThumbPhotoId = null; }
    return;
  }
  if (!liveThumbMarker) {
    const icon = L.divIcon({
      className: 'live-photo-thumb',
      html: `<div class="live-photo-thumb-inner" style="background-image:url('${nearest.url}')"></div>`,
      iconSize: [46, 46],
      iconAnchor: [23, 66],
    });
    liveThumbMarker = L.marker([pos.lat, pos.lng], { icon, interactive: false }).addTo(playbackMap);
    liveThumbPhotoId = nearest.photo.id;
    return;
  }
  liveThumbMarker.setLatLng([pos.lat, pos.lng]);
  if (liveThumbPhotoId !== nearest.photo.id) {
    liveThumbMarker.setIcon(L.divIcon({
      className: 'live-photo-thumb',
      html: `<div class="live-photo-thumb-inner" style="background-image:url('${nearest.url}')"></div>`,
      iconSize: [46, 46],
      iconAnchor: [23, 66],
    }));
    liveThumbPhotoId = nearest.photo.id;
  }
}

function currentPlaybackPosition() {
  if (currentHoliday) {
    const leg = legAtSimTime(playState.simTime) || currentHoliday.legs[0];
    const clamped = Math.min(Math.max(playState.simTime, leg.synthStart), leg.synthEnd);
    const { pos } = pointAtSimTime(leg.points, clamped - leg.synthStart);
    return { lat: pos.lat, lng: pos.lng, ts: pos.realTs ?? leg.realStart, tripId: leg.tripId };
  }
  const { pos } = pointAtSimTime(currentPlayTrip.points, playState.simTime);
  return { lat: pos.lat, lng: pos.lng, ts: pos.ts, tripId: currentPlayTrip.id };
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
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (key(a) <= targetTs && key(b) >= targetTs) {
      const span = key(b) - key(a) || 1;
      const f = (targetTs - key(a)) / span;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
  }
  return last;
}

async function resolvePhotoAnchor(file) {
  const fallback = currentPlaybackPosition();
  const exif = await readExifGps(file);
  if (!exif || (exif.lat == null && exif.ts == null)) return fallback;

  let tripId = fallback.tripId;
  let points = currentHoliday ? null : currentPlayTrip.points;

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

/* ---- home-screen bulk photo add: auto-match a whole batch to the right trip by EXIF time ---- */
function findMatchingTrip(trips, ts) {
  const BUFFER_MS = 10 * 60 * 1000;
  let best = null, bestDist = Infinity;
  for (const t of trips) {
    if (!t.points || t.points.length === 0) continue;
    const start = t.points[0].ts - BUFFER_MS;
    const end = (t.endTime || t.points[t.points.length - 1].ts) + BUFFER_MS;
    if (ts < start || ts > end) continue;
    const center = (t.points[0].ts + (t.endTime || t.points[t.points.length - 1].ts)) / 2;
    const dist = Math.abs(ts - center);
    if (dist < bestDist) { bestDist = dist; best = t; }
  }
  return best;
}

async function bulkAddPhotos(files) {
  const trips = await dbGetAll();
  let matched = 0, skipped = 0;
  for (const file of files) {
    const exif = await readExifGps(file);
    if (!exif || exif.ts == null) { skipped++; continue; }
    const trip = findMatchingTrip(trips, exif.ts);
    if (!trip) { skipped++; continue; }
    let lat = exif.lat, lng = exif.lng;
    if (lat == null) {
      const pos = interpolateByRealTs(trip.points, exif.ts);
      lat = pos.lat;
      lng = pos.lng;
    }
    await dbPutStore('photos', {
      id: 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      tripId: trip.id, lat, lng, ts: exif.ts, blob: file,
    });
    matched++;
  }
  await renderHome();
  const skippedMsg = skipped
    ? ` ${skipped} couldn’t be matched (no GPS/time metadata, or no saved trip covers that time) and ${skipped === 1 ? 'was' : 'were'} skipped.`
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
    pausePlayback();
    currentHoliday = null;
    showView('home');
    renderHome();
  });

  document.getElementById('playToggle').addEventListener('click', () => {
    if (playState.playing) pausePlayback();
    else { playState.lastFrameReal = performance.now(); startPlayback(); }
  });

  document.getElementById('scrubber').addEventListener('input', (e) => {
    pausePlayback();
    followEnabled = true;
    playState.simTime = Number(e.target.value);
    playState.renderFn(playState.simTime);
  });

  document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => {
    b.addEventListener('click', () => { setSpeedButtons(Number(b.dataset.speed)); setUniformMode(false); });
  });
  document.getElementById('uniformSpeedBtn').addEventListener('click', () => setUniformMode(!uniformModeEnabled));

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
      const ids = currentHoliday ? currentHoliday.legs.map((l) => l.tripId) : [currentPlayTrip.id];
      await loadPhotoPins(ids);
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
