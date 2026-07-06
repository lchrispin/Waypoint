/* MapLibre GL wrapper. Vector tiles from OpenFreeMap (free, keyless), falling back to raster
 * OSM tiles if the style can't be fetched, so the map always comes up. All app code speaks
 * {lat, lng}; this module converts to MapLibre's [lng, lat] at the boundary. */

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

const RASTER_FALLBACK = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

let styleCache = null;
async function mapStyle() {
  if (styleCache) return styleCache;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(STYLE_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) {
      styleCache = await res.json();
      return styleCache;
    }
  } catch (e) {
    /* offline or blocked — raster fallback below */
  }
  return RASTER_FALLBACK;
}

export const ll = (p) => [p.lng, p.lat];

export async function createMap(container, opts = {}) {
  const style = await mapStyle();
  const map = new maplibregl.Map({
    container,
    style,
    center: opts.center || [0, 20],
    zoom: opts.zoom ?? 2,
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    fadeDuration: 150,
  });
  map.touchZoomRotate.disableRotation();
  return new Promise((resolve) => {
    map.on('load', () => resolve(map));
    map.on('error', () => {}); // tile errors are non-fatal; never let them throw to the console loop
  });
}

/* ---- GeoJSON line helpers ---- */
export function ensureLine(map, id, paint, layout = {}) {
  if (!map.getSource(id)) {
    map.addSource(id, { type: 'geojson', data: emptyLine() });
    map.addLayer({
      id,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round', ...layout },
      paint,
    });
  }
  return map.getSource(id);
}

export function emptyLine() {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
}

export function setLineCoords(map, id, coords) {
  const src = map.getSource(id);
  if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
}

export function setMultiLine(map, id, lines) {
  const src = map.getSource(id);
  if (src) src.setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines } });
}

export function setFeatures(map, id, features) {
  const src = map.getSource(id);
  if (src) src.setData({ type: 'FeatureCollection', features });
}

export function removeLayerAndSource(map, id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

/* ---- DOM markers ---- */
export function makeMarker(map, className, html, pos, opts = {}) {
  const el = document.createElement('div');
  el.className = className;
  if (html) el.innerHTML = html;
  const m = new maplibregl.Marker({ element: el, anchor: 'center', ...opts });
  m.setLngLat(ll(pos)).addTo(map);
  return m;
}

export function boundsOf(pointArrays) {
  let bounds = null;
  for (const pts of pointArrays) {
    for (const p of pts) {
      if (!bounds) bounds = new maplibregl.LngLatBounds(ll(p), ll(p));
      else bounds.extend(ll(p));
    }
  }
  return bounds;
}
