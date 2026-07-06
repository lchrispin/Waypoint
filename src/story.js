/* Story building — the heart of Waypoint. A "story" is a pure data object built from one trip
 * or a holiday's trips: a compressed display timeline (stays and gaps squeezed to short beats),
 * the events those beats surface, chapters for the overview strip, and pacing so the whole
 * thing plays inside a fixed viewer-time budget. No DOM, no map: playback.js renders it. */
import { haversine, pathDistance, bearing, lowerBoundIdx, pointAtSimTime, interpolateByRealTs } from './geo.js';
import { fmtDate, fmtClock, nightsBetween } from './format.js';

/* ---- stay/jump detection + compressed display timeline ----
 * A merged trip carries the real hours-long gaps between its original legs, and any trip can
 * contain long stationary stretches (an overnight stop, a parked car). Instead of playing those
 * in proportion, the display timeline compresses each one to a short fixed span and surfaces it
 * as an event ("Stayed here · 2 nights" / "Traveling · +6 h") so playback never idles. */
const STAY_RADIUS_M = 100; // points wandering within this of a running centroid count as one stay
const STAY_MIN_MS = 10 * 60 * 1000;
const GAP_MIN_MS = 5 * 60 * 1000; // a single recording gap this long is a stay or an unrecorded jump
const GAP_STAY_DIST_M = 300;
const EVENT_SYNTH_MS = 50000; // compressed display span of a stay/jump (~2.5 s at story speed)

export function detectStays(points) {
  const n = points.length;
  const spans = [];

  for (let i = 1; i < n; i++) {
    if (points[i].ts - points[i - 1].ts >= GAP_MIN_MS) spans.push({ startIdx: i - 1, endIdx: i });
  }

  let s = 0, latSum = points[0].lat, lngSum = points[0].lng, count = 1;
  const closeRun = (endIdx) => {
    if (endIdx > s && points[endIdx].ts - points[s].ts >= STAY_MIN_MS) spans.push({ startIdx: s, endIdx });
  };
  for (let i = 1; i < n; i++) {
    if (haversine({ lat: latSum / count, lng: lngSum / count }, points[i]) <= STAY_RADIUS_M) {
      latSum += points[i].lat; lngSum += points[i].lng; count++;
      continue;
    }
    closeRun(i - 1);
    s = i; latSum = points[i].lat; lngSum = points[i].lng; count = 1;
  }
  closeRun(n - 1);

  spans.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.startIdx <= last.endIdx) last.endIdx = Math.max(last.endIdx, sp.endIdx);
    else merged.push({ ...sp });
  }
  for (const sp of merged) {
    sp.kind = haversine(points[sp.startIdx], points[sp.endIdx]) >= GAP_STAY_DIST_M ? 'jump' : 'stay';
  }
  return merged;
}

export function buildTripTimeline(points) {
  const spans = detectStays(points);
  const factor = new Array(points.length).fill(1); // per-interval compression, interval i = (i-1 -> i)
  for (const sp of spans) {
    const realSpan = points[sp.endIdx].ts - points[sp.startIdx].ts;
    const f = realSpan > 0 ? Math.min(realSpan, EVENT_SYNTH_MS) / realSpan : 1;
    for (let i = sp.startIdx + 1; i <= sp.endIdx; i++) factor[i] = f;
  }
  const out = [{ lat: points[0].lat, lng: points[0].lng, speed: points[0].speed, ts: 0, realTs: points[0].ts }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    out.push({ lat: p.lat, lng: p.lng, speed: p.speed, ts: out[i - 1].ts + (p.ts - points[i - 1].ts) * factor[i], realTs: p.ts });
  }
  const events = spans.map((sp) => ({
    kind: sp.kind,
    startIdx: sp.startIdx,
    endIdx: sp.endIdx,
    synthStart: out[sp.startIdx].ts,
    synthEnd: out[sp.endIdx].ts,
    realStart: points[sp.startIdx].ts,
    realEnd: points[sp.endIdx].ts,
    realSpanMs: points[sp.endIdx].ts - points[sp.startIdx].ts,
    lat: points[sp.startIdx].lat,
    lng: points[sp.startIdx].lng,
    latEnd: points[sp.endIdx].lat,
    lngEnd: points[sp.endIdx].lng,
  }));
  return { points: out, events, maxMs: out[out.length - 1].ts };
}

export function synthTimeForRealTs(points, realTs) {
  const key = (p) => (p.realTs != null ? p.realTs : p.ts);
  if (realTs <= key(points[0])) return points[0].ts;
  const last = points[points.length - 1];
  if (realTs >= key(last)) return last.ts;
  const i = lowerBoundIdx(points, realTs, key);
  const a = points[i], b = points[i + 1];
  const span = key(b) - key(a) || 1;
  return a.ts + (b.ts - a.ts) * ((realTs - key(a)) / span);
}

export function movementSegments(pts) {
  const segs = [];
  let start = 0;
  for (const sp of detectStays(pts)) {
    if (sp.startIdx > start) segs.push([start, sp.startIdx]);
    start = sp.endIdx;
  }
  if (start < pts.length - 1) segs.push([start, pts.length - 1]);
  return segs;
}

/* prefer road-aligned coordinates when a cached alignment matches this trip's points */
export function effectivePoints(trip) {
  const ra = trip.roadAlign;
  if (!ra || !ra.coords || ra.count !== trip.points.length) return trip.points;
  return trip.points.map((p, i) => ({ ...p, lat: ra.coords[i][0], lng: ra.coords[i][1] }));
}

/* ---- adaptive playback pace: slow near photos/turns ----
 * Turns and photos are momentary, so they're stored as smooth time-radius "dips" that ease
 * playback into and out of the moment. */
const TURN_RADIUS_MS = 20000;
const PHOTO_RADIUS_MS = 45000;

export function buildPaceProfile(points, photosForTrip, simOffset) {
  const n = points.length;
  if (n < 2) return { intervals: [{ start: -Infinity, end: Infinity, base: 1 }], dips: [] };

  const segDist = new Array(n).fill(0);
  const localSpeed = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = (points[i].ts - points[i - 1].ts) / 1000;
    segDist[i] = haversine(points[i - 1], points[i]);
    localSpeed[i] = dt > 0 ? segDist[i] / dt : 0;
  }

  const intervals = [];
  for (let i = 1; i < n; i++) {
    const base = localSpeed[i] > 4 ? 1.15 : 1; // nudge steady, uneventful travel along
    intervals.push({ start: points[i - 1].ts - simOffset, end: points[i].ts - simOffset, base });
  }

  const dips = [];
  let lastTurnSim = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    // bearing across a short segment is mostly GPS noise, not a real heading — require
    // solid displacement on both sides, a decisive angle, and spacing between dips
    if (segDist[i] < 8 || segDist[i + 1] < 8) continue;
    const b1 = bearing(points[i - 1], points[i]);
    const b2 = bearing(points[i], points[i + 1]);
    let diff = Math.abs(b2 - b1) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff > 35) {
      const sim = points[i].ts - simOffset;
      if (sim - lastTurnSim < 15000) continue;
      lastTurnSim = sim;
      dips.push({ sim, strength: Math.min(1, diff / 90) * 0.3, radius: TURN_RADIUS_MS });
    }
  }
  for (const photo of photosForTrip) {
    // anchor on the matching point's own ts (already in this points array's coordinate domain)
    // rather than the photo's raw real-world timestamp, which lives in a different domain for
    // holiday legs.
    let nearestTs = points[0].ts, best = Infinity;
    for (let i = 0; i < n; i++) {
      const mts = points[i].realTs != null ? points[i].realTs : points[i].ts;
      const diff = Math.abs(mts - photo.ts);
      if (diff < best) { best = diff; nearestTs = points[i].ts; }
    }
    dips.push({ sim: nearestTs - simOffset, strength: 0.35, radius: PHOTO_RADIUS_MS });
  }

  return { intervals, dips };
}

export function paceMultiplierAt(profile, simCoord) {
  if (!profile) return 1;
  let base = 1;
  for (const iv of profile.intervals) {
    if (simCoord >= iv.start && simCoord <= iv.end) { base = iv.base; break; }
  }
  let mult = base;
  for (const d of profile.dips) {
    const dist = Math.abs(simCoord - d.sim);
    if (dist >= d.radius) continue;
    const falloff = 1 - dist / d.radius;
    mult = Math.min(mult, 1 - falloff * d.strength);
  }
  return mult;
}

/* ---- story pacing: the viewer's time is the fixed budget, the trip flexes to fit it ----
 * Each chapter gets a display duration on a log curve of its distance, so a 1 km stroll takes
 * ~12 s and a 1,000 km drive ~35 s rather than 1000x. If the whole story would still run long,
 * everything scales down proportionally. */
const STORY_MAX_SPEED = 150;
const STORY_GAP_SPEED = 20; // through compressed stays/jumps and inter-leg gaps (~2-2.5 s each)
const STORY_TOTAL_BUDGET_S = 150;

function storySecondsForDistance(m) {
  const km = m / 1000;
  return Math.min(35, Math.max(10, 8 + 6 * Math.log(1 + km)));
}

function assignStoryPacing(chapters) {
  let total = 0;
  for (const c of chapters) {
    c.storySec = storySecondsForDistance(c.distance);
    total += c.storySec;
  }
  if (total > STORY_TOTAL_BUDGET_S) {
    const f = STORY_TOTAL_BUDGET_S / total;
    for (const c of chapters) c.storySec *= f;
  }
  for (const c of chapters) {
    const span = c.synthEnd - c.synthStart;
    c.storySpeed = Math.min(STORY_MAX_SPEED, Math.max(1, span / (c.storySec * 1000)));
  }
}

/* ---- chapters: the storyline units a viewer scans and jumps between ----
 * A holiday chapters by leg; a merged/single trip chapters by the movement segments between
 * its stay/jump events. */
function buildTripChapters(displayPoints, events) {
  const pts = displayPoints;
  const chapters = [];
  const segs = [];
  let segStart = 0;
  for (const ev of events) {
    if (ev.startIdx > segStart) segs.push([segStart, ev.startIdx]);
    segStart = ev.endIdx;
  }
  if (segStart < pts.length - 1) segs.push([segStart, pts.length - 1]);

  for (const [a, b] of segs) {
    const slice = pts.slice(a, b + 1);
    const d = pathDistance(slice);
    const last = chapters[chapters.length - 1];
    if (d < 50 && last) {
      // GPS jitter around a stop, not a real movement segment — absorb into the previous chapter
      last.synthEnd = pts[b].ts;
      last.realEnd = pts[b].realTs;
      last.distance += d;
      continue;
    }
    chapters.push({
      synthStart: pts[a].ts,
      synthEnd: pts[b].ts,
      realStart: pts[a].realTs,
      realEnd: pts[b].realTs,
      distance: d,
      latlngs: slice.map((p) => [p.lat, p.lng]),
    });
  }

  const multiDay = nightsBetween(pts[0].realTs, pts[pts.length - 1].realTs) >= 1;
  const dayCounts = {};
  for (const c of chapters) {
    const day = nightsBetween(pts[0].realTs, c.realStart) + 1;
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  chapters.forEach((c, i) => {
    c.idx = i;
    const day = nightsBetween(pts[0].realTs, c.realStart) + 1;
    c.title = multiDay ? `Day ${day}` : `Stage ${i + 1}`;
    // several chapters on one day would be indistinguishable — show the start time instead
    c.dateLabel = multiDay && dayCounts[day] === 1 ? fmtDate(c.realStart) : fmtClock(c.realStart);
  });
  return chapters;
}

/* ---- constructors ---- */
export function buildTripStory(trip, tripPhotos) {
  const timeline = buildTripTimeline(effectivePoints(trip));
  const chapters = buildTripChapters(timeline.points, timeline.events);
  assignStoryPacing(chapters);
  return {
    kind: 'trip',
    id: trip.id,
    title: trip.name,
    trip,
    displayPoints: timeline.points,
    events: timeline.events,
    chapters,
    maxMs: timeline.maxMs,
    paceProfile: buildPaceProfile(timeline.points, tripPhotos, 0),
    tripIds: [trip.id],
  };
}

const LEG_GAP_MS = 40000; // synthetic pause between legs, scaled by playback speed like everything else

export function buildHolidayStory(collection, tripList, photosByTrip) {
  let cursor = 0;
  const legs = [];
  const events = [];
  tripList.forEach((trip, i) => {
    const tl = buildTripTimeline(effectivePoints(trip)); // stays inside a leg compress just like in a single trip
    const synthStart = cursor;
    const legPoints = tl.points.map((p) => ({ ...p, ts: synthStart + p.ts }));
    const synthEnd = synthStart + tl.maxMs;
    for (const ev of tl.events) {
      events.push({ ...ev, synthStart: synthStart + ev.synthStart, synthEnd: synthStart + ev.synthEnd });
    }
    legs.push({
      tripId: trip.id,
      name: trip.name,
      synthStart,
      synthEnd,
      distance: trip.distance || pathDistance(legPoints),
      realStart: trip.startTime,
      points: legPoints,
      paceProfile: buildPaceProfile(legPoints, photosByTrip[trip.id] || [], 0),
    });
    cursor = synthEnd + (i < tripList.length - 1 ? LEG_GAP_MS : 0);
  });

  const chapters = legs.map((leg, i) => ({
    idx: i,
    title: leg.name,
    dateLabel: fmtDate(leg.realStart),
    synthStart: leg.synthStart,
    synthEnd: leg.synthEnd,
    realStart: leg.points[0].realTs,
    realEnd: leg.points[leg.points.length - 1].realTs,
    distance: leg.distance,
    latlngs: leg.points.map((p) => [p.lat, p.lng]),
  }));
  assignStoryPacing(chapters);

  return {
    kind: 'holiday',
    id: collection.id,
    title: collection.name,
    collection,
    legs,
    events,
    chapters,
    maxMs: cursor,
    tripIds: legs.map((l) => l.tripId),
  };
}

/* ---- accessors ---- */
export function legAt(story, simTime) {
  if (story.kind !== 'holiday') return null;
  return story.legs.find((l) => simTime >= l.synthStart && simTime <= l.synthEnd) || null;
}

export function eventAt(story, simTime) {
  return story.events.find((e) => simTime >= e.synthStart && simTime <= e.synthEnd) || null;
}

export function chapterAt(story, simTime) {
  return story.chapters.find((c) => simTime >= c.synthStart && simTime <= c.synthEnd) || null;
}

export function paceMultiplier(story, simTime) {
  if (story.kind === 'holiday') {
    const leg = legAt(story, simTime);
    if (!leg) return 2; // synthetic gap between legs — nothing to see, fast-forward through it
    return paceMultiplierAt(leg.paceProfile, simTime);
  }
  return paceMultiplierAt(story.paceProfile, simTime);
}

export function baseSpeed(story, simTime, speedMult) {
  const c = chapterAt(story, simTime);
  return (c ? c.storySpeed : STORY_GAP_SPEED) * (speedMult || 1);
}

export function startRealTs(story) {
  if (story.kind === 'holiday') return story.legs[0].points[0].realTs;
  return story.displayPoints[0].realTs;
}

/* Where the dot is (or would be) at a sim time — used for photo anchoring and HUD fallbacks. */
export function positionAt(story, simTime) {
  if (story.kind === 'holiday') {
    const leg = legAt(story, simTime) || story.legs[0];
    const clamped = Math.min(Math.max(simTime, leg.synthStart), leg.synthEnd);
    const { pos } = pointAtSimTime(leg.points, clamped - leg.synthStart);
    return { lat: pos.lat, lng: pos.lng, ts: pos.realTs ?? leg.realStart, tripId: leg.tripId };
  }
  const { pos } = pointAtSimTime(story.displayPoints, simTime);
  return { lat: pos.lat, lng: pos.lng, ts: pos.realTs ?? pos.ts, tripId: story.id };
}

/* A photo's position on the story clock, or null if its trip isn't part of this story. */
export function photoSimTime(story, photo) {
  if (story.kind === 'holiday') {
    const leg = story.legs.find((l) => l.tripId === photo.tripId);
    if (!leg) return null;
    return synthTimeForRealTs(leg.points, photo.ts); // leg points carry compressed synthetic ts
  }
  return synthTimeForRealTs(story.displayPoints, photo.ts);
}

/* ---- human-readable speed: displacement over a ±30 s real-time window, since raw GPS speed
 * is null on imported/merged points and too jittery for a readout anyway ---- */
export function computeSpeedKmh(points, realTs) {
  const key = (p) => (p.realTs != null ? p.realTs : p.ts);
  const t0 = Math.max(key(points[0]), realTs - 30000);
  const t1 = Math.min(key(points[points.length - 1]), realTs + 30000);
  if (t1 - t0 < 5000) return null;
  const a = interpolateByRealTs(points, t0);
  const b = interpolateByRealTs(points, t1);
  return (haversine(a, b) / ((t1 - t0) / 1000)) * 3.6;
}
