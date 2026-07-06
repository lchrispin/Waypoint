/* Boot: wire every view, ask the platform to protect our storage, register the worker. */
import { initHome, renderHome } from './home.js';
import { initRecord } from './record.js';
import { initPlayback } from './playback.js';
import { initImport } from './import-google.js';
import { exportBackup, restoreBackup } from './backup.js';
import { openModal, closeModal } from './views.js';

function initMenu() {
  const close = () => closeModal('menuSheet');
  document.getElementById('menuBtn').addEventListener('click', () => openModal('menuSheet'));
  document.getElementById('menuCloseBtn').addEventListener('click', close);
  document.getElementById('menuSheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  document.getElementById('menuAddPhotos').addEventListener('click', () => {
    close();
    document.getElementById('homePhotoFileInput').click();
  });
  document.getElementById('menuImportTimeline').addEventListener('click', () => {
    close();
    document.getElementById('timelineFileInput').click();
  });
  document.getElementById('menuExportBackup').addEventListener('click', async () => {
    close();
    await exportBackup();
  });
  document.getElementById('menuRestoreBackup').addEventListener('click', () => {
    close();
    document.getElementById('restoreFileInput').click();
  });
  document.getElementById('restoreFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await restoreBackup(file);
  });
}

export function initApp() {
  initHome();
  initRecord();
  initPlayback();
  initImport();
  initMenu();
  renderHome();

  // years of trips and photos live in this DB — ask the browser not to evict it under pressure
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
