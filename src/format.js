export function fmtDistance(m) {
  if (m < 1000) return Math.round(m) + ' m';
  const km = m / 1000;
  if (km >= 100) return Math.round(km) + ' km';
  if (km >= 10) return km.toFixed(1) + ' km';
  return km.toFixed(2) + ' km';
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtSpeed(kmh) {
  if (kmh == null) return '—';
  return (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))) + ' km/h';
}

export function fmtSpanShort(ms) {
  const h = ms / 3600000;
  if (h >= 10) return Math.round(h) + ' h';
  if (h >= 1) return (Math.round(h * 10) / 10) + ' h';
  return Math.max(1, Math.round(ms / 60000)) + ' min';
}

export function nightsBetween(a, b) {
  const d1 = new Date(a); d1.setHours(0, 0, 0, 0);
  const d2 = new Date(b); d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}

export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
