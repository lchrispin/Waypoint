/* Minimal EXIF reader: GPS coordinates + capture timestamp, nothing else.
 * Returns { lat, lng, ts } (any of which may be null) or null when nothing usable. */
export function readExifGps(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(parseExif(reader.result)); } catch (e) { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 128 * 1024)); // EXIF lives in the first few KB
  });
}

export function parseExif(buf) {
  const view = new DataView(buf);
  if (view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xffe1) {
      const exifStart = offset + 4;
      if (view.getUint32(exifStart) !== 0x45786966) { offset += 2 + view.getUint16(offset + 2); continue; }
      return parseTiff(view, exifStart + 6);
    }
    if ((marker & 0xff00) !== 0xff00) break;
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function parseTiff(view, tiffStart) {
  const little = view.getUint16(tiffStart) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  const typeSize = (t) => ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[t] || 1);

  function readIfd(ifdOffset) {
    const count = u16(ifdOffset);
    const entries = {};
    for (let i = 0; i < count; i++) {
      const eo = ifdOffset + 2 + i * 12;
      entries[u16(eo)] = { type: u16(eo + 2), numValues: u32(eo + 4), valueOffset: eo + 8 };
    }
    return entries;
  }
  function readValue(entry) {
    const size = typeSize(entry.type) * entry.numValues;
    const base = size > 4 ? tiffStart + u32(entry.valueOffset) : entry.valueOffset;
    if (entry.type === 2) {
      let s = '';
      for (let i = 0; i < entry.numValues - 1; i++) s += String.fromCharCode(view.getUint8(base + i));
      return s;
    }
    if (entry.type === 5) {
      const out = [];
      for (let i = 0; i < entry.numValues; i++) {
        const num = u32(base + i * 8), den = u32(base + i * 8 + 4);
        out.push(den ? num / den : 0);
      }
      return out;
    }
    if (entry.type === 3) return u16(base);
    if (entry.type === 4) return u32(base);
    return null;
  }

  const ifd0 = readIfd(tiffStart + u32(tiffStart + 4));
  let dateTimeOriginal = null, tzOffset = null;
  if (ifd0[0x0132]) dateTimeOriginal = readValue(ifd0[0x0132]);
  if (ifd0[0x8769]) {
    const subIfd = readIfd(tiffStart + readValue(ifd0[0x8769]));
    if (subIfd[0x9003]) dateTimeOriginal = readValue(subIfd[0x9003]);
    // OffsetTimeOriginal (fallback OffsetTime): the capture-local UTC offset, e.g. "+02:00"
    const offsetEntry = subIfd[0x9011] || subIfd[0x9010];
    if (offsetEntry) tzOffset = readValue(offsetEntry);
  }

  let lat = null, lng = null, gpsTs = null;
  if (ifd0[0x8825]) {
    const gps = readIfd(tiffStart + readValue(ifd0[0x8825]));
    if (gps[1] && gps[2] && gps[3] && gps[4]) {
      const latRef = readValue(gps[1]), latDms = readValue(gps[2]);
      const lngRef = readValue(gps[3]), lngDms = readValue(gps[4]);
      // cameras with no fix (location permission off) still write a GPS block, just zeroed out:
      // blank refs and 0/0 rationals. Parsing that as 0°N 0°E would "place" the photo in the
      // Atlantic and poison trip matching, so only trust coordinates that look like a real fix.
      const looksReal =
        (latRef === 'N' || latRef === 'S') &&
        (lngRef === 'E' || lngRef === 'W') &&
        Array.isArray(latDms) && Array.isArray(lngDms) &&
        (latDms.some((v) => v !== 0) || lngDms.some((v) => v !== 0));
      if (looksReal) {
        lat = (latDms[0] + latDms[1] / 60 + latDms[2] / 3600) * (latRef === 'S' ? -1 : 1);
        lng = (lngDms[0] + lngDms[1] / 60 + lngDms[2] / 3600) * (lngRef === 'W' ? -1 : 1);
      }
    }
    if (gps[29] && gps[7]) {
      const dateStr = readValue(gps[29]);
      const time = readValue(gps[7]);
      const [y, mo, d] = String(dateStr).split(':').map(Number);
      gpsTs = Date.UTC(y, mo - 1, d, time[0], time[1], Math.floor(time[2]));
      if (isNaN(gpsTs)) gpsTs = null; // a zeroed GPS block must not shadow DateTimeOriginal below
    }
  }

  let ts = gpsTs;
  if (ts == null && dateTimeOriginal) {
    const m = dateTimeOriginal.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const tz = typeof tzOffset === 'string' ? tzOffset.match(/^([+-])(\d{2}):(\d{2})/) : null;
      if (tz) {
        // DateTimeOriginal is capture-local wall clock; the offset tag makes it absolute
        const offsetMs = (tz[1] === '-' ? -1 : 1) * (+tz[2] * 60 + +tz[3]) * 60000;
        ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMs;
      } else {
        ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); // no offset tag — assume this device's zone
      }
    }
  }
  if (ts != null && isNaN(ts)) ts = null;

  if (lat == null && ts == null) return null;
  return { lat, lng, ts };
}
