/* Playback view: renders a Story (src/story.js) as a watchable film — atlas overview with a
 * chapter strip, ride-along mode with a damped follow camera, compressed stays, travel arcs,
 * photo memories, and an end-of-story summary card. One code path serves single trips and
 * holidays; the story object hides the difference. */
import { dbGetTrips, dbGetAllStore, dbPutStore, dbDeleteStore, dbPutTrip, dbDeleteTrip } from './db.js';
import { haversine, pathDistance, pointAtSimTime } from './geo.js';
import { fmtDate, fmtClock, fmtDistance, fmtSpeed, fmtSpanShort, nightsBetween, escapeHtml } from './format.js';
import {
  buildTripStory, buildHolidayStory, legAt, eventAt, chapterAt, paceMultiplier, baseSpeed,
  startRealTs, positionAt, photoSimTime, computeSpeedKmh,
} from './story.js';
import { placeNameSync, requestPlaceName } from './places.js';
import { alignTripToRoads } from './roads.js';
import { readExifGps } from './exif.js';
import { newPhotoId, PHOTO_GPS_ONLY_MAX_M } from './photos.js';
import { interpolateByRealTs, nearestTrackPoint } from './geo.js';
import { createMap, ll, ensureLine, setLineCoords, setMultiLine, setFeatures, makeMarker, boundsOf } from './map.js';
import { createCamera, camSeed, camStep, computeTargetZoom, cameraForPair, CAM_TAU_POS, CAM_TAU_ARC } from './camera.js';
import { showView, openModal, closeModal, setTextIfChanged } from './views.js';
import { renderHome } from './home.js';

let map = null;
let cam = null;
let story = null;
let playState = { playing: false, speed: 1, rafId: null, simTime: 0, lastFrameReal: 0, maxMs: 0, rate: 0, holding: false };
let playbackMode = 'playing'; // 'overview' (atlas: whole path + storyline strip) | 'playing' (ride-along)
let overviewAvailable = false;
let playbackBounds = null;
let followEnabled = false;
let followZoomTarget = null;
let activeChapterIdx = -1;
let lastHudAt = 0;

let playMarker = null;
let stayPulseMarker = null;
let photoMarkers = [];
let momentMarkers = [];
let photoEntries = [];
let traceState = { key: null, idx: -1, dist: 0, coords: [] };
let travelArc = null;

let memoryShownIds = new Set();
let memoryActive = null;
let memoryTimer = null;
let lightboxPhoto = null;

const FOLLOW_REAL_LOOKAHEAD_MS = 2500; // frame the next ~2.5 wall-clock seconds of travel

/* ================= map + layers ================= */
async function ensurePlaybackMap() {
  if (map) return map;
  map = await createMap('playbackMap');
  // draw order: ghost under chapter lines under the live trace
  ensureLine(map, 'ghost', { 'line-color': '#3A6B72', 'line-width': 3, 'line-opacity': 0.55, 'line-dasharray': [0.1, 2.4] });
  if (!map.getSource('chapters')) {
    map.addSource('chapters', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'chapters', type: 'line', source: 'chapters',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#E8934A', 'line-width': 3, 'line-opacity': 0.35 },
    });
    map.on('click', 'chapters', (e) => {
      const idx = e.features && e.features[0] && e.features[0].properties.idx;
      if (idx == null) return;
      setActiveChapter(Number(idx));
      const card = document.querySelector(`.chapter-card[data-idx="${idx}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  }
  ensureLine(map, 'trace', { 'line-color': '#E8934A', 'line-width': 4 });
  ensureLine(map, 'arc', { 'line-color': '#E8934A', 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [1.6, 1.8] });
  // a user gesture takes the wheel; playback keeps running but stops steering
  map.on('movestart', (e) => { if (e.originalEvent) followEnabled = false; });
  return map;
}

function resetLayers(legsForGhost) {
  setMultiLine(map, 'ghost', legsForGhost.map((leg) => leg.points.map(ll)));
  setFeatures(map, 'chapters', []);
  setLineCoords(map, 'trace', []);
  setLineCoords(map, 'arc', []);
  for (const m of photoMarkers) m.remove();
  photoMarkers = [];
  removeMomentPins();
  if (stayPulseMarker) { stayPulseMarker.remove(); stayPulseMarker = null; }
  if (playMarker) { playMarker.remove(); playMarker = null; }
  travelArc = null;
  activeChapterIdx = -1;
  followEnabled = false;
  followZoomTarget = null;
  resetTrace();

  const firstPt = legsForGhost[0].points[0];
  playMarker = makeMarker(map, 'play-dot', '', firstPt);
  playbackBounds = boundsOf(legsForGhost.map((leg) => leg.points));
  if (playbackBounds) map.fitBounds(playbackBounds, { padding: 48, duration: 0 });
  cam = createCamera(map);
}

/* ================= opening ================= */
export async function openPlayback(id) {
  const trips = await dbGetTrips();
  const trip = trips.find((t) => t.id === id);
  if (!trip || trip.points.length < 2) {
    alert('This trip doesn’t have enough GPS points to play back.');
    return;
  }
  const allPhotos = await dbGetAllStore('photos');
  story = buildTripStory(trip, allPhotos.filter((p) => p.tripId === trip.id));
  await presentStory(allPhotos, [trip]);
}

export async function openHolidayPlayback(collectionId) {
  const collections = await dbGetAllStore('collections');
  const collection = collections.find((c) => c.id === collectionId);
  if (!collection) return;
  const allTrips = await dbGetTrips();
  const tripsById = Object.fromEntries(allTrips.map((t) => [t.id, t]));
  const tripList = collection.tripIds
    .map((tid) => tripsById[tid])
    .filter((t) => t && t.points && t.points.length >= 2)
    .sort((a, b) => a.startTime - b.startTime);
  if (tripList.length === 0) {
    alert('None of the trips in this holiday could be found — they may have been deleted.');
    return;
  }
  const allPhotos = await dbGetAllStore('photos');
  const photosByTrip = {};
  for (const p of allPhotos) (photosByTrip[p.tripId] = photosByTrip[p.tripId] || []).push(p);
  story = buildHolidayStory(collection, tripList, photosByTrip);
  await presentStory(allPhotos, tripList);
}

async function presentStory(allPhotos, tripsToAlign) {
  document.getElementById('playbackTitle').textContent = story.title;
  document.getElementById('legBanner').classList.remove('active');
  showView('playback');
  await ensurePlaybackMap();
  map.resize(); // the container was display:none until now
  dismissPhotoMemory();
  memoryShownIds = new Set();

  const legs = story.kind === 'holiday' ? story.legs : [{ points: story.displayPoints }];
  resetLayers(legs);

  playState = { playing: false, speed: 1, rafId: null, simTime: 0, lastFrameReal: 0, maxMs: story.maxMs, rate: 0, holding: false };
  setSpeedButtons(1);
  loadPhotoPins(allPhotos);
  buildScrubber();
  queuePlaceLookups();
  overviewAvailable = story.kind === 'holiday' || story.chapters.length > 1;
  if (overviewAvailable) enterOverview();
  else enterPlaying(0, false);
  maybeAlignRoads(tripsToAlign);
}

/* background enrichment: kicked off on playback open; if the user is still browsing the same
 * overview when alignment lands, refresh quietly — never swap the path mid-ride */
async function maybeAlignRoads(trips) {
  const openedId = story.id;
  const openedKind = story.kind;
  let any = false;
  for (const t of trips) {
    if (await alignTripToRoads(t)) any = true;
  }
  if (!any) return;
  const sameView = story && story.id === openedId && story.kind === openedKind;
  if (sameView && playbackMode === 'overview' && !playState.playing) {
    if (openedKind === 'holiday') openHolidayPlayback(openedId);
    else openPlayback(openedId);
  }
}

/* ================= place names for banners/strip/summary ================= */
function queuePlaceLookups() {
  const refresh = () => {
    if (playbackMode === 'overview') renderStorylineStrip();
  };
  for (const ev of story.events) {
    requestPlaceName(ev.lat, ev.lng, refresh);
    if (ev.kind === 'jump' && ev.latEnd != null) requestPlaceName(ev.latEnd, ev.lngEnd, refresh);
  }
  for (const c of story.chapters) {
    if (!c.latlngs || !c.latlngs.length) continue;
    requestPlaceName(c.latlngs[0][0], c.latlngs[0][1], refresh);
    const end = c.latlngs[c.latlngs.length - 1];
    requestPlaceName(end[0], end[1], refresh);
  }
}

function stayLabel(ev) {
  if (ev.kind === 'jump') {
    const dest = ev.latEnd != null ? placeNameSync(ev.latEnd, ev.lngEnd) : null;
    if (dest) return `Traveling to ${dest} · +${fmtSpanShort(ev.realSpanMs)}`;
    const d = ev.latEnd != null ? haversine({ lat: ev.lat, lng: ev.lng }, { lat: ev.latEnd, lng: ev.lngEnd }) : 0;
    const dPart = d >= 1000 ? `${fmtDistance(d)} · ` : '';
    return `Traveling ${dPart}+${fmtSpanShort(ev.realSpanMs)}`;
  }
  const place = placeNameSync(ev.lat, ev.lng);
  const where = place ? `in ${place}` : 'here';
  const nights = nightsBetween(ev.realStart, ev.realEnd);
  if (nights >= 1 && ev.realSpanMs >= 18 * 3600000) return `Stayed ${where} · ${nights} night${nights === 1 ? '' : 's'}`;
  return `Stayed ${where} · ${fmtSpanShort(ev.realSpanMs)}`;
}

/* ================= photo spotlight + stay pulse ================= */
/* the map runs in full colour; it desaturates only while a photo is actually on screen,
 * so the photo gets the stage and the atlas stays vivid the rest of the time */
function updatePhotoSpotlight() {
  const on =
    !!memoryActive ||
    document.getElementById('photoLightbox').classList.contains('active') ||
    document.getElementById('momentSheet').classList.contains('active');
  document.getElementById('playbackMap').classList.toggle('map-photo-dim', on);
}

function updateStayPulse(ev) {
  if (!ev) {
    if (stayPulseMarker) { stayPulseMarker.remove(); stayPulseMarker = null; }
    return;
  }
  if (!stayPulseMarker) {
    stayPulseMarker = makeMarker(map, 'stay-pulse', '<div class="stay-pulse-ring"></div>', ev);
  } else {
    stayPulseMarker.setLngLat([ev.lng, ev.lat]);
  }
}

/* ================= travel arcs ================= */
/* the "Indiana Jones map" cut for big unrecorded jumps: the camera pulls out to frame both
 * endpoints and a dashed arc sweeps across, instead of the dot teleporting */
const ARC_MIN_DIST_M = 50000;

function travelGapAt(simTime) {
  if (story.kind === 'holiday' && !legAt(story, simTime)) {
    const prev = [...story.legs].reverse().find((l) => l.synthEnd <= simTime);
    const next = story.legs.find((l) => l.synthStart > simTime);
    if (!prev || !next) return null;
    const from = prev.points[prev.points.length - 1];
    const to = next.points[0];
    return { key: 'gap' + prev.synthEnd, start: prev.synthEnd, end: next.synthStart, from, to };
  }
  const ev = eventAt(story, simTime);
  if (ev && ev.kind === 'jump' && ev.latEnd != null) {
    return { key: 'ev' + ev.synthStart, start: ev.synthStart, end: ev.synthEnd, from: { lat: ev.lat, lng: ev.lng }, to: { lat: ev.latEnd, lng: ev.lngEnd } };
  }
  return null;
}

function arcCoords(from, to, f) {
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
    out.push([a * from.lng + b * ctrl.lng + c * to.lng, a * from.lat + b * ctrl.lat + c * to.lat]);
  }
  return out;
}

/* Returns the arc tip position ([lng,lat]) while a big jump is on screen, else null. */
function updateTravelArc(simTime) {
  const gap = travelGapAt(simTime);
  const big = gap && haversine(gap.from, gap.to) >= ARC_MIN_DIST_M ? gap : null;
  if (!big) {
    if (travelArc) {
      setLineCoords(map, 'arc', []);
      travelArc = null;
      followZoomTarget = null; // re-aim fresh; the damped camera glides back in, no cut
      if (playState.playing) followEnabled = true;
    }
    return null;
  }
  if (!travelArc || travelArc.key !== big.key) {
    travelArc = { key: big.key, target: cameraForPair(map, big.from, big.to) };
  }
  if (travelArc.target) {
    camStep(cam, travelArc.target, { tauPos: CAM_TAU_ARC, tauZoom: CAM_TAU_ARC, zoom: travelArc.target.zoom });
  }
  const f = Math.max(0, Math.min(1, (simTime - big.start) / Math.max(1, big.end - big.start)));
  const coords = arcCoords(big.from, big.to, f);
  setLineCoords(map, 'arc', coords);
  return coords[coords.length - 1];
}

/* ================= photo moments (overview pins) ================= */
/* photos clustered in space and time, shown as one pin at atlas altitude. The cluster radius
 * derives from the trip's bounding box so a walking tour clusters per café and a road trip
 * clusters per town. */
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
  for (const c of clusterPhotoMoments(photoEntries)) {
    const badge = c.entries.length > 1 ? `<span class="moment-count">${c.entries.length}</span>` : '';
    const m = makeMarker(map, 'moment-pin-wrap', `<div class="moment-pin" style="background-image:url('${c.entries[0].url}')">${badge}</div>`, c.center);
    m.getElement().addEventListener('click', () => openMomentSheet(c));
    momentMarkers.push(m);
  }
}
function removeMomentPins() {
  for (const m of momentMarkers) m.remove();
  momentMarkers = [];
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
  openModal('momentSheet');
  updatePhotoSpotlight();
}
function closeMomentSheet() {
  closeModal('momentSheet');
  updatePhotoSpotlight();
}

/* ================= overview (atlas) <-> playing (ride-along) ================= */
function buildChapterLines() {
  setFeatures(map, 'chapters', story.chapters.map((c) => ({
    type: 'Feature',
    properties: { idx: c.idx },
    geometry: { type: 'LineString', coordinates: c.latlngs.map(([lat, lng]) => [lng, lat]) },
  })));
  paintActiveChapter();
}

function paintActiveChapter() {
  if (!map.getLayer('chapters')) return;
  map.setPaintProperty('chapters', 'line-opacity', ['case', ['==', ['get', 'idx'], activeChapterIdx], 0.95, 0.35]);
  map.setPaintProperty('chapters', 'line-width', ['case', ['==', ['get', 'idx'], activeChapterIdx], 4, 3]);
}

function setActiveChapter(idx) {
  if (idx === activeChapterIdx) return;
  activeChapterIdx = idx;
  document.querySelectorAll('.chapter-card').forEach((el) => el.classList.toggle('active', Number(el.dataset.idx) === idx));
  paintActiveChapter();
}

function photosForChapter(c) {
  return photoEntries.filter((e) => e.synth != null && e.synth >= c.synthStart && e.synth <= c.synthEnd);
}

function renderStorylineStrip() {
  const strip = document.getElementById('storylineStrip');
  strip.innerHTML = '';
  story.chapters.forEach((c) => {
    const thumbs = photosForChapter(c).slice(0, 3);
    const card = document.createElement('div');
    card.className = 'chapter-card';
    card.dataset.idx = c.idx;
    // holiday legs carry the user's own names; only generic Day/Stage titles earn a place suffix
    const place = story.kind !== 'holiday' && c.latlngs && c.latlngs.length ? placeNameSync(c.latlngs[0][0], c.latlngs[0][1]) : null;
    card.innerHTML = `
      <div class="chapter-title">${escapeHtml(c.title)}${place ? ` · ${escapeHtml(place)}` : ''}</div>
      <div class="chapter-meta">${escapeHtml(c.dateLabel)} · ${fmtDistance(c.distance)}</div>
      ${thumbs.length ? `<div class="chapter-thumbs">${thumbs.map((t) => `<div style="background-image:url('${t.url}')"></div>`).join('')}</div>` : ''}`;
    card.addEventListener('click', () => enterPlaying(c.synthStart, true));
    strip.appendChild(card);
  });

  const start = startRealTs(story);
  const end = story.chapters.length ? story.chapters[story.chapters.length - 1].realEnd : start;
  const days = nightsBetween(start, end) + 1;
  const dist = story.chapters.reduce((s, c) => s + c.distance, 0);
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
  map.stop();
  hideSummary();
  playbackMode = 'overview';
  document.getElementById('playerPanel').style.display = 'none';
  document.getElementById('overviewPanel').style.display = '';
  document.getElementById('legBanner').classList.remove('active');
  updateStayPulse(null);
  setLineCoords(map, 'trace', []);
  setLineCoords(map, 'arc', []);
  travelArc = null;
  if (playMarker) playMarker.getElement().style.display = 'none';
  for (const m of photoMarkers) m.getElement().style.display = 'none';
  buildMomentPins();
  buildChapterLines();
  renderStorylineStrip();
  followEnabled = false;
  activeChapterIdx = -1;
  setActiveChapter(0);
  if (playbackBounds) map.fitBounds(playbackBounds, { padding: 48, duration: 800 });
}

function enterPlaying(simTime, autoplay) {
  playbackMode = 'playing';
  hideSummary();
  closeMomentSheet();
  document.getElementById('overviewPanel').style.display = 'none';
  document.getElementById('playerPanel').style.display = '';
  removeMomentPins();
  setFeatures(map, 'chapters', []);
  if (playMarker) playMarker.getElement().style.display = '';
  for (const m of photoMarkers) m.getElement().style.display = '';
  playState.simTime = Math.max(0, Math.min(simTime, playState.maxMs));
  if (playState.simTime === 0) memoryShownIds.clear();
  else rearmMemoriesAfter(playState.simTime);
  map.stop();
  camSeed(cam); // the damped camera glides from wherever the view is now, never cuts
  followZoomTarget = null;
  resetTrace();
  renderFrame(playState.simTime);
  if (autoplay) startPlayback();
  else document.getElementById('playToggle').textContent = '▶';
}

/* ================= segmented story scrubber ================= */
/* one segment per chapter sized by its display time, with photo dots and stay ticks, so the
 * structure of the story is visible before pressing play */
let scrubSegs = [];

function buildScrubber() {
  const el = document.getElementById('storyScrubber');
  el.innerHTML = '';
  scrubSegs = [];
  const spans = [];
  let cursor = 0;
  for (const c of story.chapters) {
    if (c.synthStart > cursor + 1) spans.push({ start: cursor, end: c.synthStart, gap: true });
    spans.push({ start: c.synthStart, end: c.synthEnd, gap: false, weight: c.storySec || 1 });
    cursor = c.synthEnd;
  }
  if (cursor < playState.maxMs - 1) spans.push({ start: cursor, end: playState.maxMs, gap: true });

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
      for (const ev of story.events) {
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

/* ================= end-of-story summary ================= */
function showSummary() {
  const chapters = story.chapters;
  const start = startRealTs(story);
  const end = chapters.length ? chapters[chapters.length - 1].realEnd : start;
  const days = nightsBetween(start, end) + 1;
  const dist = story.kind === 'holiday'
    ? story.legs.reduce((s, l) => s + l.distance, 0)
    : (story.trip.distance || chapters.reduce((s, c) => s + c.distance, 0));
  document.getElementById('summaryTitle').textContent = story.title;
  const bits = [`${days} day${days === 1 ? '' : 's'}`, fmtDistance(dist)];
  if (photoEntries.length) bits.push(`${photoEntries.length} photo${photoEntries.length === 1 ? '' : 's'}`);
  document.getElementById('summaryStats').textContent = bits.join(' · ');
  let route = '';
  if (chapters.length && chapters[0].latlngs && chapters[0].latlngs.length) {
    const first = chapters[0].latlngs[0];
    const lastC = chapters[chapters.length - 1];
    const last = lastC.latlngs[lastC.latlngs.length - 1];
    const a = placeNameSync(first[0], first[1]);
    const b = placeNameSync(last[0], last[1]);
    if (a && b) route = a === b ? a : `${a} → ${b}`;
  }
  document.getElementById('summaryRoute').textContent = route;
  document.getElementById('summaryOverviewBtn').style.display = overviewAvailable ? '' : 'none';
  openModal('summaryOverlay');
}
function hideSummary() {
  closeModal('summaryOverlay');
}

/* ================= trace + frame rendering ================= */
function resetTrace() {
  traceState = { key: null, idx: -1, dist: 0, coords: [] };
}

/* committed coordinates append one by one; only the interpolated tip is replaced per frame.
 * Rebuilds happen only on seeks and leg changes. Returns the distance traced so far. */
function updateTrace(pts, idx, pos, key) {
  if (traceState.key !== key || idx < traceState.idx || idx - traceState.idx > 50) {
    const slice = pts.slice(0, idx + 1);
    traceState = { key, idx, dist: pathDistance(slice), coords: slice.map(ll) };
  } else {
    for (let i = traceState.idx + 1; i <= idx; i++) {
      traceState.coords.push(ll(pts[i]));
      traceState.dist += haversine(pts[i - 1], pts[i]);
    }
    traceState.idx = idx;
  }
  setLineCoords(map, 'trace', [...traceState.coords, ll(pos)]);
  return traceState.dist + haversine(pts[idx], pos);
}

function hudShouldUpdate() {
  const now = performance.now();
  if (playState.playing && now - lastHudAt < 200) return false;
  lastHudAt = now;
  return true;
}

function renderFrame(simTime) {
  const ev = eventAt(story, simTime);
  const leg = story.kind === 'holiday' ? legAt(story, simTime) : null;
  let pos, dist = 0, bannerText = null, pts = null, simBase = 0, traceKey = 'trip';

  if (story.kind === 'holiday') {
    if (leg) {
      pts = leg.points;
      simBase = leg.synthStart;
      traceKey = leg.tripId;
      const local = pointAtSimTime(pts, simTime - simBase);
      pos = local.pos;
      dist = updateTrace(pts, local.idx, pos, traceKey);
      bannerText = ev ? stayLabel(ev) : `${leg.name} · ${fmtDate(leg.realStart)}`;
    } else {
      const prevLeg = [...story.legs].reverse().find((l) => l.synthEnd <= simTime);
      const nextLeg = story.legs.find((l) => l.synthStart > simTime);
      pos = prevLeg ? prevLeg.points[prevLeg.points.length - 1] : story.legs[0].points[0];
      setLineCoords(map, 'trace', []);
      resetTrace();
      bannerText = nextLeg ? `Traveling to ${nextLeg.name}…` : 'Holiday complete';
    }
  } else {
    pts = story.displayPoints;
    const { idx, pos: p } = pointAtSimTime(pts, simTime);
    pos = p;
    dist = updateTrace(pts, idx, pos, traceKey);
    if (ev) bannerText = stayLabel(ev);
  }

  playMarker.setLngLat(ll(pos));
  const arcTip = updateTravelArc(simTime);
  if (arcTip) playMarker.setLngLat(arcTip);
  updateStayPulse(travelArc ? null : ev);
  updateScrubberValue(simTime);

  if (hudShouldUpdate()) {
    const banner = document.getElementById('legBanner');
    if (bannerText) {
      setTextIfChanged('legBanner', bannerText);
      banner.classList.add('active');
    } else {
      banner.classList.remove('active');
    }
    let hudDist = dist;
    if (story.kind === 'holiday') {
      for (const l of story.legs) {
        if (l.synthEnd <= simTime && l !== leg) hudDist += l.distance;
      }
    }
    setTextIfChanged('readoutClock', fmtClock(pos.realTs ?? pos.ts));
    setTextIfChanged('readoutDist', fmtDistance(hudDist));
    setTextIfChanged('readoutSpeed', ev || !pts ? '—' : fmtSpeed(computeSpeedKmh(pts, pos.realTs ?? pos.ts)));
    updatePaceBadge(simTime);
  }

  if (followEnabled && !travelArc && pts) {
    const rate = playState.rate || baseSpeed(story, simTime, playState.speed);
    const clampLocal = (t) => Math.min(t - simBase, pts[pts.length - 1].ts - pts[0].ts);
    const aheadPos = pointAtSimTime(pts, clampLocal(simTime + rate * FOLLOW_REAL_LOOKAHEAD_MS)).pos;
    // feed-forward: the damped camera trails its target by ~speed × tau, so aim one time
    // constant ahead and the marker rides dead-centre instead of drifting toward the edge.
    // During a stay, anchor on the event's location and freeze the zoom target instead —
    // the marker only wobbles through the compressed GPS cluster there.
    const camPos = ev
      ? { lat: ev.lat, lng: ev.lng }
      : pointAtSimTime(pts, clampLocal(simTime + (playState.rate || 0) * CAM_TAU_POS)).pos;
    // during a stay the zoom target freezes; otherwise it re-aims continuously
    if (!ev || followZoomTarget == null) followZoomTarget = computeTargetZoom(map, camPos, aheadPos);
    camStep(cam, camPos, { zoom: followZoomTarget });
  } else if (followEnabled && !travelArc && !pts) {
    camStep(cam, pos, { zoom: null });
  }
}

function updatePaceBadge(simTime) {
  const pace = paceMultiplier(story, simTime);
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

/* ================= playback clock ================= */
function playbackTick(nowReal) {
  if (!playState.playing || playState.holding) return;
  const dtReal = Math.min(100, Math.max(0, nowReal - playState.lastFrameReal));
  playState.lastFrameReal = nowReal;
  // smooth the rate itself: chapter/gap speed steps, pace dips, and hold-resumes all become
  // glides instead of velocity jumps
  const targetRate = baseSpeed(story, playState.simTime, playState.speed) * paceMultiplier(story, playState.simTime);
  const prevRate = playState.rate != null ? playState.rate : targetRate;
  playState.rate = prevRate + (targetRate - prevRate) * (1 - Math.exp(-dtReal / 350));
  const nextSim = playState.simTime + dtReal * playState.rate;
  const photoHit = nextUnshownPhotoBetween(playState.simTime, nextSim);
  if (photoHit) {
    // land exactly on the photo's moment and hold there while the memory card shows
    playState.simTime = Math.min(photoHit.synth, playState.maxMs);
    renderFrame(playState.simTime);
    showPhotoMemory(photoHit);
    return;
  }
  playState.simTime = nextSim;
  if (playState.simTime >= playState.maxMs) {
    playState.simTime = playState.maxMs;
    renderFrame(playState.simTime);
    pausePlayback();
    showSummary();
    return;
  }
  renderFrame(playState.simTime);
  playState.rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
  if (playState.holding) dismissPhotoMemory();
  playState.rate = 0; // ease in from standstill
  playState.playing = true;
  followEnabled = true;
  document.getElementById('playToggle').textContent = '⏸';
  preloadNextPhoto(playState.simTime);
  playState.lastFrameReal = performance.now();
  playState.rafId = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
  playState.playing = false;
  document.getElementById('playToggle').textContent = '▶';
  if (playState.rafId) cancelAnimationFrame(playState.rafId);
}

function setSpeedButtons(speed) {
  playState.speed = speed;
  document.querySelectorAll('.speed-btn[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}

/* ================= photos ================= */
function loadPhotoPins(allPhotos) {
  for (const m of photoMarkers) m.remove();
  photoMarkers = [];
  photoEntries.forEach((e) => URL.revokeObjectURL(e.url)); // blobs re-read below; free the old URLs
  photoEntries = [];
  const mine = allPhotos.filter((p) => story.tripIds.includes(p.tripId));
  for (const photo of mine) {
    const url = URL.createObjectURL(photo.blob);
    photoEntries.push({ photo, url, synth: photoSimTime(story, photo) });
    const m = makeMarker(map, 'photo-pin', `<div class="photo-pin-thumb" style="background-image:url('${url}')"></div>`, photo);
    m.getElement().addEventListener('click', () => {
      const simTime = photoSimTime(story, photo);
      if (simTime != null) {
        pausePlayback();
        dismissPhotoMemory();
        playState.simTime = Math.max(0, Math.min(simTime, playState.maxMs));
        rearmMemoriesAfter(playState.simTime);
        renderFrame(playState.simTime);
      }
      openPhotoLightbox(photo, url);
    });
    photoMarkers.push(m);
  }
}

async function reloadPhotos() {
  const allPhotos = await dbGetAllStore('photos');
  loadPhotoPins(allPhotos);
  buildScrubber();
  if (playbackMode === 'overview') {
    for (const m of photoMarkers) m.getElement().style.display = 'none';
    buildMomentPins();
    renderStorylineStrip();
  }
}

/* ---- photo memory card: when playback reaches a photo's moment, glide to a stop and show it
 * big with its date/time, then resume automatically. Photos taken around the same moment share
 * one hold and cycle as a stack instead of stop-starting playback once per photo. ---- */
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

function photoCaption(photo) {
  const datePart = new Date(photo.ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  let caption = `${datePart} · ${fmtClock(photo.ts)}`;
  const start = startRealTs(story);
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
  updatePhotoSpotlight();
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
      renderFrame(playState.simTime);
      renderMemoryPhoto();
      scheduleMemoryStep();
      return;
    }
    dismissPhotoMemory();
    if (playState.playing) {
      playState.rate = 0; // ease back in after the hold
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
  updatePhotoSpotlight();
}

/* photos ahead of this point may fire again — used after seeking backwards */
function rearmMemoriesAfter(simTime) {
  for (const entry of photoEntries) {
    if (entry.synth != null && entry.synth > simTime) memoryShownIds.delete(entry.photo.id);
  }
}

function openPhotoLightbox(photo, url) {
  lightboxPhoto = photo;
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightboxMeta').textContent = `${fmtDate(photo.ts)} · ${fmtClock(photo.ts)}`;
  openModal('photoLightbox');
  updatePhotoSpotlight();
}

/* ---- place a photo by its own EXIF GPS/timestamp instead of the scrubber position ---- */
async function resolvePhotoAnchor(file) {
  const fallback = positionAt(story, playState.simTime);
  const exif = await readExifGps(file);
  if (!exif || (exif.lat == null && exif.ts == null)) return fallback;

  let tripId = fallback.tripId;
  let points = story.kind === 'holiday' ? null : story.trip.points;

  if (exif.ts == null && exif.lat != null) {
    // no timestamp — snap to the nearest track point by location and take its time
    const candidates = story.kind === 'holiday'
      ? story.legs.map((l) => ({ id: l.tripId, pts: l.points }))
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

  if (story.kind === 'holiday' && exif.ts != null) {
    const BUFFER_MS = 10 * 60 * 1000;
    const match = story.legs.find((l) => {
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

/* ================= wiring ================= */
export function initPlayback() {
  document.getElementById('playbackBackBtn').addEventListener('click', () => {
    if (playbackMode === 'playing' && overviewAvailable) {
      enterOverview();
      return;
    }
    pausePlayback();
    dismissPhotoMemory();
    hideSummary();
    if (map) map.stop(); // kill any in-flight camera animation before the view goes away
    photoEntries.forEach((e) => URL.revokeObjectURL(e.url));
    photoEntries = [];
    story = null;
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
    map.stop();
    followEnabled = true;
    playState.simTime = Math.max(0, Math.min(simFromScrubberX(e.clientX), playState.maxMs));
    rearmMemoriesAfter(playState.simTime);
    renderFrame(playState.simTime);
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
    if (!story) return;
    if (story.kind === 'holiday') {
      if (confirm('Delete this holiday? The individual trips inside it will stay saved.')) {
        await dbDeleteStore('collections', story.id);
        story = null;
        pausePlayback();
        showView('home');
        renderHome();
      }
    } else {
      if (confirm('Delete this trip permanently?')) {
        await dbDeleteTrip(story.id);
        story = null;
        pausePlayback();
        showView('home');
        renderHome();
      }
    }
  });

  document.getElementById('renameTripBtn').addEventListener('click', () => {
    if (!story) return;
    document.getElementById('renameModalTitle').textContent = story.kind === 'holiday' ? 'Rename holiday' : 'Rename trip';
    document.getElementById('renameInput').value = story.title;
    openModal('renameModal');
  });
  document.getElementById('cancelRename').addEventListener('click', () => closeModal('renameModal'));
  document.getElementById('confirmRename').addEventListener('click', async () => {
    const val = document.getElementById('renameInput').value.trim();
    closeModal('renameModal');
    if (!val || !story) return;
    story.title = val;
    if (story.kind === 'holiday') {
      story.collection.name = val;
      await dbPutStore('collections', story.collection);
    } else {
      story.trip.name = val;
      story.trip.autoNamed = false; // the user's name wins from now on
      await dbPutTrip(story.trip);
    }
    document.getElementById('playbackTitle').textContent = val;
  });

  document.getElementById('addPhotoBtn').addEventListener('click', () => document.getElementById('photoFileInput').click());
  document.getElementById('photoFileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0 || !story) return;
    for (const file of files) {
      const anchor = await resolvePhotoAnchor(file);
      await dbPutStore('photos', {
        id: newPhotoId(),
        tripId: anchor.tripId, lat: anchor.lat, lng: anchor.lng, ts: anchor.ts, blob: file,
      });
    }
    await reloadPhotos();
  });

  document.getElementById('lightboxCloseBtn').addEventListener('click', () => {
    closeModal('photoLightbox');
    updatePhotoSpotlight();
  });
  document.getElementById('lightboxDeleteBtn').addEventListener('click', async () => {
    if (lightboxPhoto && confirm('Delete this photo?')) {
      await dbDeleteStore('photos', lightboxPhoto.id);
      closeModal('photoLightbox');
      closeMomentSheet();
      await reloadPhotos();
      updatePhotoSpotlight();
    }
  });
}
