/* Place names: cached reverse geocoding so the story says "Stayed in Siena", not "here",
 * and trips can name themselves ("Lyon → Annecy"). Free Nominatim endpoint at 1 req/s,
 * results cached in IndexedDB so each place is fetched once ever; everything degrades to
 * generic labels offline. Lookups resolve in the background; callers pick names up on
 * their next frame or via the onResolve callback. */
import { dbGetStore, dbPutStore, dbPutTrip } from './db.js';

const placeNames = new Map(); // key -> resolved name (or null for "looked up, nothing usable")
const placePending = new Set();
let placeQueue = Promise.resolve();

export function placeKey(lat, lng) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`; // ~100 m grid: one lookup covers a whole stop
}

export function placeNameSync(lat, lng) {
  return placeNames.get(placeKey(lat, lng)) || null;
}

export function requestPlaceName(lat, lng, onResolve) {
  const key = placeKey(lat, lng);
  if (placeNames.has(key)) {
    if (onResolve) onResolve(placeNames.get(key));
    return;
  }
  if (placePending.has(key)) return;
  placePending.add(key);
  placeQueue = placeQueue.then(async () => {
    try {
      const cached = await dbGetStore('places', key);
      if (cached) {
        placeNames.set(key, cached.name);
      } else {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12`);
        if (res.ok) {
          const data = await res.json();
          const a = data.address || {};
          const name = a.city || a.town || a.village || a.suburb || a.municipality || a.county || null;
          placeNames.set(key, name);
          await dbPutStore('places', { id: key, name, fetchedAt: Date.now() });
        }
        await new Promise((r) => setTimeout(r, 1100)); // the free endpoint allows 1 req/s
      }
    } catch (e) {
      /* offline — labels stay generic and we'll retry on a future visit */
    }
    placePending.delete(key);
    if (onResolve) onResolve(placeNames.get(key) ?? null);
  });
}

/* ---- automatic trip naming ----
 * Recording and importing no longer block on a naming modal: trips save immediately under a
 * date placeholder and rename themselves to "Lyon → Annecy" (or "Siena loop") once the
 * endpoints reverse-geocode. A manual rename clears trip.autoNamed, after which we never
 * touch the name again. */
export function autoNameTrip(trip, onNamed) {
  if (trip.autoNamed === false || !trip.points || trip.points.length < 2) return;
  const start = trip.points[0];
  const end = trip.points[trip.points.length - 1];
  let a, b, resolved = 0;
  const finish = async () => {
    if (trip.autoNamed === false) return; // renamed while we were looking it up
    let name = null;
    if (a && b) name = a === b ? `${a} loop` : `${a} → ${b}`;
    else if (a || b) name = a || b;
    if (name && trip.typeLabel && trip.typeLabel !== 'Trip' && trip.typeLabel !== 'Route') {
      name = `${trip.typeLabel} · ${name}`; // keep the imported activity ("Drive · Lyon → Annecy")
    }
    if (!name || name === trip.name) return;
    trip.name = name;
    trip.autoNamed = true;
    await dbPutTrip(trip);
    if (onNamed) onNamed(trip);
  };
  requestPlaceName(start.lat, start.lng, (n) => { a = n; if (++resolved === 2) finish(); });
  requestPlaceName(end.lat, end.lng, (n) => { b = n; if (++resolved === 2) finish(); });
}
