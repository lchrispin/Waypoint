/* Damped follow camera. With GL's continuous fractional zoom, the legacy app's whole
 * zoom-glide machinery (discrete zoom targets, hysteresis, native animated zooms, the
 * camZooming standoff) collapses into one exponentially-damped state: centre and zoom both
 * glide toward their targets every frame via jumpTo, which on a GL map is smooth at any rate. */
import { haversine } from './geo.js';

export const CAM_TAU_POS = 600; // ms time constant for centre
export const CAM_TAU_ZOOM = 900; // zoom breathes a little slower than the pan
export const CAM_TAU_ARC = 1100; // travel arcs pull out lazily

export function createCamera(map) {
  const c = map.getCenter();
  return { map, lat: c.lat, lng: c.lng, zoom: map.getZoom(), lastFrame: performance.now(), zoomTarget: null };
}

export function camSeed(cam) {
  const c = cam.map.getCenter();
  cam.lat = c.lat;
  cam.lng = c.lng;
  cam.zoom = cam.map.getZoom();
  cam.lastFrame = performance.now();
}

/* Zoom framing the next few seconds of travel: pick the zoom where the lookahead span is
 * ~30% of the short screen dimension, so a fast leg doesn't fly off-screen and a slow one
 * isn't zoomed out to nothing. */
export function computeTargetZoom(map, pos, aheadPos) {
  const spanMeters = Math.max(30, haversine(pos, aheadPos));
  const canvas = map.getCanvas();
  const scale = window.devicePixelRatio || 1;
  const minDim = Math.max(100, Math.min(canvas.width / scale, canvas.height / scale));
  const metersPerPixel = spanMeters / (minDim * 0.3);
  const latRad = (pos.lat * Math.PI) / 180;
  const zoom = Math.log2((156543.03392 * Math.cos(latRad)) / metersPerPixel);
  return Math.min(16, Math.max(4, zoom));
}

/* One frame of camera: damp centre and zoom toward the target and jump there.
 * Dead-band holds the map perfectly still through GPS jitter and stays. */
export function camStep(cam, target, { tauPos = CAM_TAU_POS, tauZoom = CAM_TAU_ZOOM, zoom = null } = {}) {
  const now = performance.now();
  const dt = Math.min(100, Math.max(0, now - cam.lastFrame));
  cam.lastFrame = now;
  const aP = 1 - Math.exp(-dt / tauPos);
  cam.lat += (target.lat - cam.lat) * aP;
  cam.lng += (target.lng - cam.lng) * aP;
  let zoomMoved = false;
  if (zoom != null) {
    const aZ = 1 - Math.exp(-dt / tauZoom);
    const dz = (zoom - cam.zoom) * aZ;
    if (Math.abs(dz) > 0.0005) { cam.zoom += dz; zoomMoved = true; }
  }
  const cur = cam.map.getCenter();
  const movedPx = cam.map.project([cam.lng, cam.lat]).dist(cam.map.project([cur.lng, cur.lat]));
  if (movedPx < 0.5 && !zoomMoved) return;
  cam.map.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom });
}

/* Camera target that frames two points (used for travel arcs). */
export function cameraForPair(map, a, b, padding = 80) {
  const bounds = new maplibregl.LngLatBounds([a.lng, a.lat], [a.lng, a.lat]);
  bounds.extend([b.lng, b.lat]);
  const cam = map.cameraForBounds(bounds, { padding });
  if (!cam) return null;
  const center = maplibregl.LngLat.convert(cam.center);
  return { lat: center.lat, lng: center.lng, zoom: Math.min(cam.zoom, 16) };
}
