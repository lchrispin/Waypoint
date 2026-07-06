/* Recording. No naming modal in the way: the FAB starts recording immediately under a date
 * placeholder, and the trip renames itself from its endpoints once saved (src/places.js). */
import { haversine } from './geo.js';
import { fmtDistance, fmtDuration } from './format.js';
import { dbPutTrip, dbDeleteTrip } from './db.js';
import { autoNameTrip } from './places.js';
import { createMap, ll, ensureLine, setLineCoords, makeMarker } from './map.js';
import { showView, showToast } from './views.js';
import { renderHome } from './home.js';

let recordMap = null;
let recordMarker = null;
let watchId = null;
let currentTrip = null;
let statTimer = null;
let lineCoords = [];

async function startRecording() {
  const placeholder = `Trip · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  currentTrip = { id: String(Date.now()), name: placeholder, autoNamed: true, startTime: Date.now(), endTime: null, points: [], distance: 0 };

  showView('record');
  resetStats();
  await setupRecordMap();
  if (!currentTrip) return; // discarded while the map was still loading

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

async function setupRecordMap() {
  teardownRecordMap();
  lineCoords = [];
  recordMap = await createMap('recordMap', { center: [0, 20], zoom: 2 });
  recordMap.resize();
  ensureLine(recordMap, 'record-line', { 'line-color': '#E8934A', 'line-width': 4 });
  recordMarker = makeMarker(recordMap, 'record-dot', '', { lat: 0, lng: 0 });
}

function teardownRecordMap() {
  if (recordMap) { recordMap.remove(); recordMap = null; recordMarker = null; }
}

function onPosition(pos) {
  if (!currentTrip) return;
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

  if (recordMap) {
    lineCoords.push(ll(p));
    setLineCoords(recordMap, 'record-line', lineCoords);
    recordMarker.setLngLat(ll(p));
    recordMap.jumpTo({ center: ll(p), zoom: Math.max(recordMap.getZoom(), 16) });
  }

  document.getElementById('statDistance').textContent = fmtDistance(currentTrip.distance);
  document.getElementById('statPoints').textContent = pts.length;

  if (pts.length % 15 === 0) dbPutTrip(currentTrip);
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
  if (currentTrip) document.getElementById('statElapsed').textContent = fmtDuration((Date.now() - currentTrip.startTime) / 1000);
}

function stopWatching() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (statTimer) { clearInterval(statTimer); statTimer = null; }
}

async function stopRecording() {
  stopWatching();
  currentTrip.endTime = Date.now();
  if (currentTrip.points.length >= 2) {
    await dbPutTrip(currentTrip);
    autoNameTrip(currentTrip, (t) => {
      showToast(`Trip named "${t.name}"`);
      renderHome();
    });
  }
  currentTrip = null;
  teardownRecordMap();
  showView('home');
  renderHome();
}

export function initRecord() {
  document.getElementById('fabRecord').addEventListener('click', startRecording);

  document.getElementById('stopRecordBtn').addEventListener('click', () => {
    if (confirm('Stop and save this trip?')) stopRecording();
  });
  document.getElementById('recordBackBtn').addEventListener('click', async () => {
    if (confirm('Discard this in-progress trip?')) {
      stopWatching();
      const discarded = currentTrip;
      currentTrip = null;
      teardownRecordMap();
      // the 15-point autosave may already have written a partial — clean it up
      if (discarded && discarded.points.length >= 15) await dbDeleteTrip(discarded.id);
      showView('home');
      renderHome();
    }
  });
}
