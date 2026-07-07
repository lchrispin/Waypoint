/* Photo ↔ trip matching. Time is the primary key, validated/refined by GPS when present;
 * photos with GPS but no timestamp match by location and take their time from the track. */
import { haversine, interpolateByRealTs, nearestTrackPoint } from './geo.js';
import { readExifGps } from './exif.js';
import { dbGetTrips, dbPutStore } from './db.js';

const PHOTO_TRACK_MAX_M = 2000; // a photo whose GPS is further than this from the track at its time isn't from that trip
export const PHOTO_GPS_ONLY_MAX_M = 250; // matching by location alone needs to be much tighter

export function newPhotoId() {
  return 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/* Returns { trip, lat, lng, ts } or null. */
export function matchPhotoToTrip(trips, exif) {
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

/* Home-screen bulk add: auto-match a whole batch to the right trip by EXIF time + GPS.
 * Returns { matched, skipped }. */
export async function bulkAddPhotos(files) {
  const trips = await dbGetTrips();
  let matched = 0, skipped = 0;
  for (const file of files) {
    const exif = await readExifGps(file);
    const match = exif ? matchPhotoToTrip(trips, exif) : null;
    if (!match) { skipped++; continue; }
    await dbPutStore('photos', {
      id: newPhotoId(),
      tripId: match.trip.id, lat: match.lat, lng: match.lng, ts: match.ts, blob: file,
    });
    matched++;
  }
  return { matched, skipped };
}
