/* Geodesy + interpolation primitives. Points are {lat, lng, ts, ...} throughout the app;
 * conversion to MapLibre's [lng, lat] happens only at the map boundary (src/map.js). */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function pathDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

export function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/* binary search: the interpolators run per animation frame on merged trips that can carry
 * thousands of points, so a linear scan is the difference between smooth and stuttery */
export function lowerBoundIdx(points, target, key) {
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (key(points[mid]) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function pointAtSimTime(points, simTime) {
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

export function interpolateByRealTs(points, targetTs) {
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

export function nearestTrackPoint(points, loc) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = haversine(p, loc);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { point: best, dist: bestD };
}

export function downsampleByDistance(pts, a, b, spacing) {
  const out = [pts[a]];
  let acc = 0;
  for (let i = a + 1; i <= b; i++) {
    acc += haversine(pts[i - 1], pts[i]);
    if (acc >= spacing) { out.push(pts[i]); acc = 0; }
  }
  if (out[out.length - 1] !== pts[b]) out.push(pts[b]);
  return out;
}
