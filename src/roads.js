/* Road work against the free OSRM demo server (1 req/s, no SLA — every call degrades
 * gracefully to the raw trace):
 *  - alignTripToRoads: map-match driving-speed segments of a recorded trace onto the road
 *    network and project every original point onto the matched line. Timestamps and point
 *    counts untouched, wobble gone. Results persist on the trip record.
 *  - snapToRoad: turn a 2-point imported activity (start/end only) into a routed polyline. */
import { haversine, pathDistance, downsampleByDistance } from './geo.js';
import { movementSegments } from './story.js';
import { dbPutTrip } from './db.js';

const MATCH_BASE = 'https://router.project-osrm.org/match/v1/driving';
const ROUTE_BASE = 'https://router.project-osrm.org/route/v1';
const ALIGN_MIN_SPEED = 5.5; // median m/s for a segment to count as driving
const ALIGN_BACKBONE_M = 40; // downsample spacing for match requests
const ALIGN_MAX_REQUESTS = 20;
const ALIGN_MAX_PULL_M = 60; // never drag a point further than this onto the "road"

export const ROAD_PROFILES = { Walk: 'walking', Run: 'walking', Cycle: 'cycling', Drive: 'driving', Bus: 'driving' };

function medianSegmentSpeed(pts, a, b) {
  const v = [];
  for (let i = a + 1; i <= b; i++) {
    const dt = (pts[i].ts - pts[i - 1].ts) / 1000;
    if (dt > 0) v.push(haversine(pts[i - 1], pts[i]) / dt);
  }
  if (!v.length) return 0;
  v.sort((x, y) => x - y);
  return v[v.length >> 1];
}

async function osrmMatch(chunk) {
  try {
    const coords = chunk.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const radiuses = chunk.map(() => 20).join(';');
    const res = await fetch(`${MATCH_BASE}/${coords}?overview=full&geometries=geojson&radiuses=${radiuses}`);
    await new Promise((r) => setTimeout(r, 1100)); // free OSRM demo server allows 1 req/s
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.matchings || !data.matchings.length) return null;
    const out = [];
    for (const m of data.matchings) for (const c of m.geometry.coordinates) out.push([c[1], c[0]]);
    return out;
  } catch (e) {
    return null; // offline or server unavailable — the raw trace stays
  }
}

/* snap original points [a..b] onto the matched line with an advancing-cursor projection.
 * Returns, for every index that landed on the line, its position along it ({ seg, t }) so
 * the caller can weave the road's own vertices back in between the projected points. */
function projectOntoLine(pts, a, b, line, alignedOut) {
  const kx = 111320 * Math.cos((pts[a].lat * Math.PI) / 180);
  const ky = 110540;
  const P = line.map(([lat, lng]) => [lng * kx, lat * ky]);
  let cursor = 0;
  const projInfo = {};
  for (let i = a; i <= b; i++) {
    const x = pts[i].lng * kx, y = pts[i].lat * ky;
    let best = Infinity, bestPt = null, bestSeg = cursor, bestT = 0;
    const from = Math.max(0, cursor - 5);
    const to = Math.min(P.length - 2, cursor + 80);
    for (let s = from; s <= to; s++) {
      const dx = P[s + 1][0] - P[s][0], dy = P[s + 1][1] - P[s][1];
      const L2 = dx * dx + dy * dy || 1;
      let t = ((x - P[s][0]) * dx + (y - P[s][1]) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = P[s][0] + dx * t, py = P[s][1] + dy * t;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < best) { best = d; bestPt = [py / ky, px / kx]; bestSeg = s; bestT = t; }
    }
    cursor = bestSeg;
    if (Math.sqrt(best) <= ALIGN_MAX_PULL_M) { alignedOut[i] = bestPt; projInfo[i] = { seg: bestSeg, t: bestT }; }
  }
  return projInfo;
}

/* Projection alone still draws straight chords between GPS samples, so the trace cuts corners
 * wherever the road curves between fixes. Densify: between each pair of projected points,
 * insert the matched line's own intermediate vertices with timestamps interpolated by distance
 * along the road — the drawn line then follows the road's actual curvature. */
function densifySegment(pts, a, b, line, projInfo, aligned) {
  const out = [];
  const at = (i) => ({ lat: aligned[i][0], lng: aligned[i][1], ts: pts[i].ts, speed: pts[i].speed });
  for (let i = a; i < b; i++) {
    out.push(at(i));
    const p1 = projInfo[i], p2 = projInfo[i + 1];
    if (!p1 || !p2 || p2.seg <= p1.seg) continue; // off-road gap or backward jitter — plain chord
    const verts = [];
    for (let v = p1.seg + 1; v <= p2.seg; v++) verts.push({ lat: line[v][0], lng: line[v][1] });
    if (!verts.length) continue;
    const chain = [at(i), ...verts, at(i + 1)];
    const cum = [0];
    for (let k = 1; k < chain.length; k++) cum.push(cum[k - 1] + haversine(chain[k - 1], chain[k]));
    const total = cum[cum.length - 1];
    if (total < 1) continue;
    const t0 = pts[i].ts, t1 = pts[i + 1].ts;
    for (let k = 1; k < chain.length - 1; k++) {
      const f = cum[k] / total;
      if (f <= 0 || f >= 1) continue;
      out.push({ lat: chain[k].lat, lng: chain[k].lng, ts: t0 + (t1 - t0) * f });
    }
  }
  out.push(at(b));
  return out;
}

export async function alignTripToRoads(trip) {
  if (!navigator.onLine || !trip.points || trip.points.length < 2) return false;
  // a cached alignment without a densified path (written by the legacy app) is upgraded once
  if (trip.roadAlign && trip.roadAlign.count === trip.points.length && trip.roadAlign.path) return false;
  const pts = trip.points;
  const aligned = pts.map((p) => [p.lat, p.lng]);
  const stretches = [];
  let changed = false;
  let budget = ALIGN_MAX_REQUESTS;

  for (const [a, b] of movementSegments(pts)) {
    if (b - a < 5 || medianSegmentSpeed(pts, a, b) < ALIGN_MIN_SPEED) continue;
    let spacing = ALIGN_BACKBONE_M;
    let backbone = downsampleByDistance(pts, a, b, spacing);
    while (Math.ceil(backbone.length / 97) > budget && spacing < 700) {
      spacing *= 2;
      backbone = downsampleByDistance(pts, a, b, spacing);
    }
    const road = [];
    let matchedInput = 0;
    for (let i = 0; i < backbone.length - 1 && budget > 0; i += 97) {
      const chunk = backbone.slice(i, i + 98);
      if (chunk.length < 2) break;
      budget--;
      const geo = await osrmMatch(chunk);
      if (geo) { for (const c of geo) road.push(c); matchedInput += chunk.length; }
    }
    if (road.length < 2 || matchedInput / backbone.length < 0.8) continue;
    const rawDist = pathDistance(pts.slice(a, b + 1));
    const roadDist = pathDistance(road.map(([lat, lng]) => ({ lat, lng })));
    if (roadDist < rawDist * 0.75 || roadDist > rawDist * 1.25) continue; // suspicious match — keep raw
    const projInfo = projectOntoLine(pts, a, b, road, aligned);
    stretches.push({ a, b, path: densifySegment(pts, a, b, road, projInfo, aligned) });
    changed = true;
  }

  if (!changed) return false;
  // full-trip densified path: aligned stretches woven with road vertices, everything else raw
  const path = [];
  let i = 0;
  stretches.sort((x, y) => x.a - y.a);
  for (const st of stretches) {
    while (i < st.a) { path.push({ lat: aligned[i][0], lng: aligned[i][1], ts: pts[i].ts, speed: pts[i].speed }); i++; }
    path.push(...st.path);
    i = st.b + 1;
  }
  while (i < pts.length) { path.push({ lat: aligned[i][0], lng: aligned[i][1], ts: pts[i].ts, speed: pts[i].speed }); i++; }
  trip.roadAlign = { count: pts.length, coords: aligned, path, fetchedAt: Date.now() };
  await dbPutTrip(trip);
  return true;
}

/* route a 2-point imported activity along the road network, timestamps spread by distance */
export async function snapToRoad(points, typeLabel) {
  const profile = ROAD_PROFILES[typeLabel];
  if (!profile || points.length !== 2) return points;
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${ROUTE_BASE}/${profile}/${coords}?overview=full&geometries=geojson`;
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
