/* Backup & restore. Everything lives in this browser's IndexedDB, which the platform is
 * allowed to evict — a trip archive needs a way out. The backup is one JSON file carrying
 * trips, holidays, photos (base64) and the place-name cache; restore is a non-destructive
 * union keyed by id, so it also works as a device-to-device transfer. */
import { dbGetAllStore, dbPutStore } from './db.js';
import { showToast, uiAlert } from './views.js';
import { renderHome } from './home.js';

const BACKUP_VERSION = 1;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'image/jpeg' });
}

export async function exportBackup() {
  const [trips, collections, photos, places] = await Promise.all([
    dbGetAllStore('trips'), dbGetAllStore('collections'), dbGetAllStore('photos'), dbGetAllStore('places'),
  ]);

  // Assemble the file as an array of Blob parts, streaming photos one at a time, rather
  // than JSON.stringify-ing the whole dataset into a single string. A few hundred
  // base64'd photos is hundreds of MB; one contiguous string of that size trips V8's
  // string-length ceiling and OOMs a mobile tab — exactly when the backup matters most.
  // The on-disk shape is byte-identical to v1 ({app,version,trips,collections,photos,
  // places}), so restore is unchanged and BACKUP_VERSION stays 1 (photos serialised last
  // only so we can stream them; JSON object order is irrelevant to the reader).
  const parts = [
    '{"app":"waypoint"' +
    `,"version":${BACKUP_VERSION}` +
    `,"exportedAt":${JSON.stringify(new Date().toISOString())}` +
    `,"trips":${JSON.stringify(trips)}` +
    `,"collections":${JSON.stringify(collections)}` +
    `,"places":${JSON.stringify(places)}` +
    ',"photos":[',
  ];

  const many = photos.length > 50;
  for (let i = 0; i < photos.length; i++) {
    const { blob, ...rest } = photos[i];
    // encode → stringify → push → release: never more than one photo's base64 alive
    const encoded = { ...rest, blobType: blob && blob.type, blobB64: blob ? await blobToBase64(blob) : null };
    parts.push((i ? ',' : '') + JSON.stringify(encoded));
    if (many && (i % 25 === 0 || i === photos.length - 1)) {
      showToast(`Packing photo ${i + 1}/${photos.length}…`, 60000);
    }
  }
  parts.push(']}');

  const blob = new Blob(parts, { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `waypoint-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  showToast(`Backup exported: ${trips.length} trip${trips.length === 1 ? '' : 's'}, ${photos.length} photo${photos.length === 1 ? '' : 's'}.`, 4200);
}

export async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    await uiAlert({ title: 'Couldn’t read that file', body: 'It doesn’t parse as a Waypoint backup.' });
    return;
  }
  if (!data || data.app !== 'waypoint' || !Array.isArray(data.trips)) {
    await uiAlert({ title: 'Not a Waypoint backup', body: 'That file doesn’t look like a Waypoint backup.' });
    return;
  }
  // Restore must read every version ever shipped, forever. v1 and the v2 streaming export
  // share an identical on-disk shape, so one key-by-key union handles both; if a future
  // version changes the shape, branch on data.version here — never drop an old path.
  let trips = 0, photos = 0;
  for (const t of data.trips) {
    if (t && t.id && Array.isArray(t.points)) { await dbPutStore('trips', t); trips++; }
  }
  for (const c of data.collections || []) {
    if (c && c.id && Array.isArray(c.tripIds)) await dbPutStore('collections', c);
  }
  for (const p of data.photos || []) {
    if (!p || !p.id || !p.blobB64) continue;
    const { blobB64, blobType, ...rest } = p;
    await dbPutStore('photos', { ...rest, blob: base64ToBlob(blobB64, blobType) });
    photos++;
  }
  for (const pl of data.places || []) {
    if (pl && pl.id) await dbPutStore('places', pl);
  }
  await renderHome();
  showToast(`Restored ${trips} trip${trips === 1 ? '' : 's'} and ${photos} photo${photos === 1 ? '' : 's'}.`, 4200);
}
