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

async function renderHome() {
  const [trips, collections] = await Promise.all([dbGetAll(), dbGetAllStore('collections')]);
  const tripsById = Object.fromEntries(trips.map((t) => [t.id, t]));

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
        const card = document.createElement('div');
        card.className = 'trip-card';
        card.innerHTML = `
          <div class="trip-name">&#9992;&#65039; ${escapeHtml(c.name)}</div>
          <div class="trip-meta">
            <span>${starts.length ? fmtDate(Math.min(...starts)) : '\u2014'}</span>
            <span>${fmtDistance(totalDist)}</span>
            <span>${members.length} leg${members.length === 1 ? '' : 's'}</span>
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
    card.innerHTML = `
      ${selectMode ? `<input type="checkbox" class="tripSelectCheck" data-id="${t.id}" ${selectedTripIds.has(t.id) ? 'checked' : ''} />` : ''}
      <div>
        <div class="trip-name">${escapeHtml(t.name)}</div>
        <div class="trip-meta">
          <span>${fmtDate(t.startTime)}</span>
          <span>${fmtDistance(t.distance || 0)}</span>
          <span>${dur}</span>
          <span>${(t.points || []).length} pts</span>
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
  const btn = document.getElementById('fabCombine');
  btn.textContent = `Combine (${selectedTripIds.size})`;
  btn.disabled = selectedTripIds.size < 2;
}

function setSelectMode(on) {
  selectMode = on;
  selectedTripIds.clear();
  document.getElementById('selectModeBtn').textContent = selectMode ? 'Cancel' : 'Select';
  document.getElementById('fabRecord').style.display = selectMode ? 'none' : '';
  document.getElementById('fabCombine').style.display = selectMode ? '' : 'none';
  document.getElementById('fabCombine').textContent = 'Combine (0)';
  document.getElementById('fabCombine').disabled = true;
  renderHome();
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

  const maxMs = currentPlayTrip.points[currentPlayTrip.points.length - 1].ts - currentPlayTrip.points[0].ts;
  playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderFrame };
  setSpeedButtons(20);
  document.getElementById('scrubber').max = maxMs;
  document.getElementById('scrubber').value = 0;
  renderFrame(0);
  document.getElementById('playToggle').textContent = '\u25B6';
  await loadPhotoPins([currentPlayTrip.id]);
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

  document.getElementById('playbackTitle').textContent = collection.name;
  showView('playback');
  setupPlaybackMap(legs);

  playState = { playing: false, speed: 20, rafId: null, simTime: 0, lastFrameReal: 0, maxMs, renderFn: renderHolidayFrame };
  setSpeedButtons(20);
  document.getElementById('scrubber').max = maxMs;
  document.getElementById('scrubber').value = 0;
  renderHolidayFrame(0);
  document.getElementById('playToggle').textContent = '\u25B6';
  await loadPhotoPins(tripList.map((t) => t.id));
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
}

/* ---- shared playback controls ---- */
function playbackTick(nowReal) {
  if (!playState.playing) return;
  const dtReal = nowReal - playState.lastFrameReal;
  playState.lastFrameReal = nowReal;
  playState.simTime += dtReal * playState.speed;
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
  document.querySelectorAll('.speed-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}

/* ---- photos ---- */
async function loadPhotoPins(tripIds) {
  photoMarkers.forEach((m) => playbackMap.removeLayer(m));
  photoMarkers = [];
  const all = await dbGetAllStore('photos');
  const mine = all.filter((p) => tripIds.includes(p.tripId));
  for (const photo of mine) {
    const url = URL.createObjectURL(photo.blob);
    const icon = L.divIcon({
      className: 'photo-pin',
      html: `<div class="photo-pin-thumb" style="background-image:url('${url}')"></div>`,
      iconSize: [34, 34],
    });
    const marker = L.marker([photo.lat, photo.lng], { icon }).addTo(playbackMap);
    marker.on('click', () => openPhotoLightbox(photo, url));
    photoMarkers.push(marker);
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
    playState.simTime = Number(e.target.value);
    playState.renderFn(playState.simTime);
  });

  document.querySelectorAll('.speed-btn').forEach((b) => {
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

  document.getElementById('selectModeBtn').addEventListener('click', () => setSelectMode(!selectMode));
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

  document.getElementById('addPhotoBtn').addEventListener('click', () => document.getElementById('photoFileInput').click());
  document.getElementById('photoFileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    const anchor = currentPlaybackPosition();
    for (const file of files) {
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
