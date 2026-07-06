/* View switching + small shared UI utilities. */
export function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

export function activeView() {
  const v = document.querySelector('.view.active');
  return v ? v.id.replace('view-', '') : null;
}

export function openModal(id) {
  document.getElementById(id).classList.add('active');
}

export function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

export function setLoading(message) {
  document.getElementById('loadingMessage').textContent = message;
  showView('loading');
}

/* Non-blocking toast for background outcomes (auto-naming, photo matching). */
let toastTimer = null;
export function showToast(message, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('active');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('active'), ms);
}

export function setTextIfChanged(id, txt) {
  const el = document.getElementById(id);
  if (el.textContent !== txt) el.textContent = txt;
}
