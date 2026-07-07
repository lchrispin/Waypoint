/* IndexedDB — the schema is shared with the legacy app (legacy/), so the same data
 * opens in either version and rolling back never strands a trip. */
const DB_NAME = 'waypointDB';
const DB_VERSION = 3;

/* One shared connection, opened lazily — recording autosaves every 15th point and a fresh
 * open per call is needless churn. Cached as the open *promise* so concurrent callers share
 * the same in-flight open. */
let dbPromise = null;

function dbOpen() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A version bump in another tab must not deadlock against our held connection:
      // close it and let the next call reopen at whatever version wins.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

export async function dbPutStore(store, obj) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function dbGetAllStore(store) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function dbGetStore(store, key) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function dbDeleteStore(store, id) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const dbPutTrip = (trip) => dbPutStore('trips', trip);
export const dbGetTrips = () => dbGetAllStore('trips').then((rows) => rows.sort((a, b) => b.startTime - a.startTime));
export const dbDeleteTrip = (id) => dbDeleteStore('trips', id);
