/* Home: the shelf. Journeys (holidays) on top, trips beneath, each card carrying a small
 * route sparkline so the shelf reads as a map collection rather than a list of rows. */
import { dbGetTrips, dbGetAllStore, dbPutStore, dbPutTrip, dbDeleteTrip } from './db.js';
import { pathDistance } from './geo.js';
import { fmtDate, fmtDistance, fmtDuration, escapeHtml } from './format.js';
import { bulkAddPhotos } from './photos.js';
import { autoNameTrip } from './places.js';
import { openPlayback, openHolidayPlayback } from './playback.js';
import { openModal, closeModal, showToast } from './views.js';

let selectMode = false;
let selectedTripIds = new Set();

/* Inline SVG route sparkline from a trip's points — the card's little map. */
function sparklineSvg(pointArrays, cls) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const pts of pointArrays) {
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
  }
  if (!isFinite(minLat)) return '';
  const W = 84, H = 52, PAD = 6;
  const spanLat = Math.max(maxLat - minLat, 1e-5);
  const spanLng = Math.max(maxLng - minLng, 1e-5);
  // uniform scale so the shape doesn't distort, centred in the box
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat);
  const ox = (W - spanLng * scale) / 2, oy = (H - spanLat * scale) / 2;
  const paths = pointArrays.map((pts) => {
    const step = Math.max(1, Math.floor(pts.length / 60));
    const coords = [];
    for (let i = 0; i < pts.length; i += step) coords.push(pts[i]);
    if (coords[coords.length - 1] !== pts[pts.length - 1]) coords.push(pts[pts.length - 1]);
    const d = coords
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(ox + (p.lng - minLng) * scale).toFixed(1)},${(oy + (maxLat - p.lat) * scale).toFixed(1)}`)
      .join('');
    return `<path d="${d}" />`;
  });
  return `<svg class="spark ${cls || ''}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${paths.join('')}</svg>`;
}

export async function renderHome() {
  const [trips, collections, photos] = await Promise.all([dbGetTrips(), dbGetAllStore('collections'), dbGetAllStore('photos')]);
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
        card.className = 'trip-card holiday-card';
        card.innerHTML = `
          ${sparklineSvg(members.map((t) => t.points || []).filter((p) => p.length), 'spark-holiday')}
          <div class="trip-card-body">
            <div class="trip-name">${escapeHtml(c.name)}</div>
            <div class="trip-meta">
              <span>${starts.length ? fmtDate(Math.min(...starts)) : '—'}</span>
              <span>${fmtDistance(totalDist)}</span>
              <span>${members.length} leg${members.length === 1 ? '' : 's'}</span>
              ${photoCount ? `<span>${photoCount} photo${photoCount === 1 ? '' : 's'}</span>` : ''}
            </div>
          </div>`;
        card.addEventListener('click', () => openHolidayPlayback(c.id));
        holidayList.appendChild(card);
      });
  }

  const list = document.getElementById('tripList');
  list.innerHTML = '';
  if (trips.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="glyph">&#9737;</div>
      <p>No trips yet.</p>
      <p class="empty-hint">Tap <b>&#9679; Record trip</b> to log a route as you travel, or open the &#8943; menu to import your Google Timeline and turn the places you've already been into stories.</p></div>`;
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
    const dur = t.endTime ? fmtDuration((t.endTime - t.startTime) / 1000) : '—';
    const photoCount = photoCountByTrip[t.id] || 0;
    card.innerHTML = `
      ${selectMode ? `<input type="checkbox" class="tripSelectCheck" data-id="${t.id}" ${selectedTripIds.has(t.id) ? 'checked' : ''} />` : ''}
      ${selectMode ? '' : sparklineSvg([t.points || []], '')}
      <div class="trip-card-body">
        <div class="trip-name">${escapeHtml(t.name)}</div>
        <div class="trip-meta">
          <span>${fmtDate(t.startTime)}</span>
          <span>${fmtDistance(t.distance || 0)}</span>
          <span>${dur}</span>
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
  const trips = await dbGetTrips();
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
  await dbPutTrip(merged);

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

  for (const id of ids) await dbDeleteTrip(id);
  setSelectMode(false);
}

export function initHome() {
  document.getElementById('selectModeBtn').addEventListener('click', () => setSelectMode(!selectMode));

  document.getElementById('homePhotoFileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    const { matched, skipped } = await bulkAddPhotos(files);
    await renderHome();
    const skippedMsg = skipped
      ? ` ${skipped} couldn’t be matched (no GPS/time metadata, or no saved trip covers that time and place).`
      : '';
    showToast(`${matched} photo${matched === 1 ? '' : 's'} added to your trips.${skippedMsg}`, 4200);
  });

  document.getElementById('fabCombine').addEventListener('click', () => {
    if (selectedTripIds.size < 2) return;
    document.getElementById('holidayNameInput').value = `Holiday · ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
    openModal('holidayNameModal');
  });
  document.getElementById('cancelHolidayName').addEventListener('click', () => closeModal('holidayNameModal'));
  document.getElementById('confirmHolidayName').addEventListener('click', async () => {
    const name = document.getElementById('holidayNameInput').value.trim() || 'Untitled holiday';
    closeModal('holidayNameModal');
    await dbPutStore('collections', { id: 'col-' + Date.now(), name, tripIds: [...selectedTripIds], createdAt: Date.now() });
    setSelectMode(false);
  });

  document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
    const n = selectedTripIds.size;
    if (n === 0) return;
    if (!confirm(`Delete ${n} trip${n === 1 ? '' : 's'} permanently? This can't be undone.`)) return;
    for (const id of selectedTripIds) await dbDeleteTrip(id);
    setSelectMode(false);
  });

  document.getElementById('mergeBtn').addEventListener('click', () => {
    if (selectedTripIds.size < 2) return;
    document.getElementById('mergeNameInput').value = `Trip · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    openModal('mergeNameModal');
  });
  document.getElementById('cancelMergeName').addEventListener('click', () => closeModal('mergeNameModal'));
  document.getElementById('confirmMergeName').addEventListener('click', async () => {
    const name = document.getElementById('mergeNameInput').value.trim() || 'Merged trip';
    closeModal('mergeNameModal');
    await mergeSelectedTrips(name);
  });

  // any trips that never got a resolved name (offline at the time) retry quietly on launch
  dbGetTrips().then((trips) => {
    for (const t of trips) {
      if (t.autoNamed === true) autoNameTrip(t, () => renderHome());
    }
  });
}
