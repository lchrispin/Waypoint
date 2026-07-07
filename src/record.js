/* Recording. No naming modal in the way: the FAB starts recording immediately under a date
 * placeholder, and the trip renames itself from its endpoints once saved (src/places.js). */
import { haversine } from './geo.js';
import { fmtDistance, fmtDuration } from './format.js';
import { dbPutTrip, dbDeleteTrip } from './db.js';
import { autoNameTrip } from './places.js';
import { createMap, ll, ensureLine, setLineCoords, ensureDot, setDotCoord } from './map.js';
import { showView, showToast } from './views.js';
import { renderHome } from './home.js';

/* Fixes with a worse accuracy radius than this are noise (indoors, urban canyon) — storing
 * them sprays jitter and inflates distance. Generous on purpose: dense urban recording
 * legitimately runs 20-40 m. The first fix is never gated (the map needs a position). */
const ACC_MAX_M = 50;

let recordMap = null;
let watchId = null;
let currentTrip = null;
let statTimer = null;
let lineCoords = [];
let wakeLock = null;

async function startRecording() {
  if (!('geolocation' in navigator)) {
    alert('This browser has no location support.');
    return;
  }

  const placeholder = `Trip · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  currentTrip = { id: String(Date.now()), name: placeholder, autoNamed: true, startTime: Date.now(), endTime: null, points: [], distance: 0 };

  showView('record');
  resetStats();
  hideRecordBanner();
  acquireWakeLock();
  await setupRecordMap();
  if (!currentTrip) return; // discarded while the map was still loading

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });

  statTimer = setInterval(updateElapsedStat, 1000);
}

/* Keep the screen on while recording: when it sleeps, mobile browsers throttle or stop
 * watchPosition and long recordings get holes. The platform auto-releases the lock when
 * the page is hidden, so we re-acquire on return (visibilitychange in initRecord). */
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null; // can reject (e.g. low battery) — recording works regardless
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

async function setupRecordMap() {
  teardownRecordMap();
  lineCoords = [];
  recordMap = await createMap('recordMap', { center: [0, 20], zoom: 2 });
  recordMap.resize();
  ensureLine(recordMap, 'record-line', { 'line-color': '#E8934A', 'line-width': 4 });
  // GL dot, same reason as playback's playhead: stays glued to the line through zooms
  ensureDot(recordMap, 'record-head', {
    'circle-radius': 7,
    'circle-color': '#E8934A',
    'circle-stroke-color': '#F0EAD8',
    'circle-stroke-width': 2.5,
  });
}

function teardownRecordMap() {
  if (recordMap) { recordMap.remove(); recordMap = null; }
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
  if (pts.length > 0 && p.acc > ACC_MAX_M) return; // bad lock — keep waiting, never gate the first fix
  hideRecordBanner(); // GPS is delivering again — clear any error/searching banner
  if (pts.length > 0) {
    const d = haversine(pts[pts.length - 1], p);
    // Require the move to clear the fix's own noise floor, or a stationary phone with
    // 20 m accuracy random-walks distance upward. Floor of 1 m = the old behavior.
    if (d < Math.max(1, Math.min(p.acc, 25) * 0.5)) return;
    currentTrip.distance += d;
  }
  pts.push(p);

  if (recordMap) {
    lineCoords.push(ll(p));
    setLineCoords(recordMap, 'record-line', lineCoords);
    setDotCoord(recordMap, 'record-head', ll(p));
    recordMap.jumpTo({ center: ll(p), zoom: Math.max(recordMap.getZoom(), 16) });
  }

  document.getElementById('statDistance').textContent = fmtDistance(currentTrip.distance);
  document.getElementById('statPoints').textContent = pts.length;

  if (pts.length % 15 === 0) dbPutTrip(currentTrip);
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    showRecordBanner('Location access is blocked — enable it in your browser settings', true);
  } else {
    // TIMEOUT / POSITION_UNAVAILABLE — transient; onPosition clears this on the next good fix
    showRecordBanner('Searching for GPS…');
  }
}

function showRecordBanner(msg, danger = false) {
  const el = document.getElementById('recordBanner');
  el.textContent = msg;
  el.classList.toggle('danger', danger);
  el.classList.add('active');
}

function hideRecordBanner() {
  document.getElementById('recordBanner').classList.remove('active');
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
  releaseWakeLock();
  hideRecordBanner();
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

  // The platform releases the wake lock whenever the page hides; take it back on return
  // while a recording is live.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && watchId != null) acquireWakeLock();
  });

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
