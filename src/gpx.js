/* GPX 1.1 export — the escape hatch for data locked in IndexedDB: one file opens in
 * Strava, Garmin, Google Earth, gpx.studio. Exports the RAW recorded points, never the
 * road-aligned path: alignment carries interpolated timestamps and woven road vertices —
 * a presentation artifact, not a measurement. */
import { movementSegments } from './story.js';
import { showToast } from './views.js';

function xmlEsc(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function trkptTag(p) {
  let inner = '';
  if (p.alt != null && isFinite(p.alt)) inner += `<ele>${p.alt.toFixed(1)}</ele>`;
  if (p.ts != null && isFinite(p.ts)) inner += `<time>${new Date(p.ts).toISOString()}</time>`;
  return `<trkpt lat="${p.lat}" lon="${p.lng}">${inner}</trkpt>`;
}

function trkFor(trip) {
  const pts = trip.points || [];
  if (pts.length < 2) return '';
  // one <trkseg> per movement segment, so stays show up as natural breaks
  const segs = movementSegments(pts)
    .map(([a, b]) => pts.slice(a, b + 1))
    .filter((seg) => seg.length >= 2);
  const body = (segs.length ? segs : [pts])
    .map((seg) => `<trkseg>\n${seg.map(trkptTag).join('\n')}\n</trkseg>`)
    .join('\n');
  return `<trk>\n<name>${xmlEsc(trip.name || 'Trip')}</name>\n${body}\n</trk>`;
}

function wptFor(photo, idx) {
  if (photo.lat == null || photo.lng == null) return '';
  let inner = '';
  if (photo.ts != null && isFinite(photo.ts)) inner += `<time>${new Date(photo.ts).toISOString()}</time>`;
  inner += `<name>${xmlEsc(`Photo ${idx + 1}`)}</name>`;
  return `<wpt lat="${photo.lat}" lon="${photo.lng}">${inner}</wpt>`;
}

export function buildGpx(name, trips, photos = []) {
  const wpts = photos.map(wptFor).filter(Boolean).join('\n');
  const trks = trips.map(trkFor).filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Waypoint" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xmlEsc(name)}</name></metadata>
${wpts}${wpts ? '\n' : ''}${trks}
</gpx>`;
}

function safeFilename(name) {
  const cleaned = String(name).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  return (cleaned || 'waypoint-trip') + '.gpx';
}

export function downloadGpx(name, trips, photos = []) {
  const usable = trips.filter((t) => t && t.points && t.points.length >= 2);
  if (!usable.length) { showToast('Nothing to export — no GPS points.'); return; }
  const gpx = buildGpx(name, usable, photos);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = safeFilename(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  const n = usable.length;
  showToast(`GPX exported: ${n} track${n === 1 ? '' : 's'}.`);
}
