/* View switching + small shared UI utilities.
 *
 * History integration: the OS/browser back button must navigate the app, not exit the
 * PWA. The model is a linear stack mirrored into history entries: home is the root
 * (never pushed), every non-home view is one pushed entry, every open modal one more
 * (e.g. home → playback → momentSheet → photoLightbox). One popstate handler reconciles;
 * UI back buttons call history.back() so both paths converge on it.
 *
 * Views can register a guard (may veto the exit — record's discard confirm, playback's
 * playing→overview step) and an exit handler (teardown when the view actually leaves).
 * The loading view is deliberately never a history entry. */

const stack = []; // {type:'view'|'modal', name}
let suppressPops = 0; // pops we caused ourselves and already applied visually

const guards = {}; // view name -> () => boolean (false = stay put)
const exits = {}; // view name -> () => void (cleanup on leave)

export function registerViewGuard(name, fn) { guards[name] = fn; }
export function registerViewExit(name, fn) { exits[name] = fn; }

function showViewRaw(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

export function activeView() {
  const v = document.querySelector('.view.active');
  return v ? v.id.replace('view-', '') : null;
}

function applyTopView() {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === 'view') { showViewRaw(stack[i].name); return; }
  }
  showViewRaw('home');
}

export function showView(name) {
  if (name === 'home') { navigateHome(); return; }
  if (name === 'loading') { showViewRaw('loading'); return; } // transient, not a history entry
  if (activeView() === name) { showViewRaw(name); return; } // refresh in place, no duplicate entry
  stack.push({ type: 'view', name });
  history.pushState({ depth: stack.length }, '');
  showViewRaw(name);
}

/* Programmatic "go home" (stop & save, import done, delete trip): unwind however deep we
 * are in one history.go, running exits, so back-on-home still exits the app cleanly. */
function navigateHome() {
  if (stack.length > 0) {
    const n = stack.length;
    while (stack.length) {
      const top = stack.pop();
      if (top.type === 'modal') dismissModalEntry(top);
      else if (exits[top.name]) exits[top.name]();
    }
    suppressPops += 1; // history.go fires a single popstate no matter the distance
    history.go(-n);
  }
  showViewRaw('home');
}

function openModalRaw(id) { document.getElementById(id).classList.add('active'); }
function closeModalRaw(id) { document.getElementById(id).classList.remove('active'); }

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function focusablesIn(sheet) {
  return [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.offsetParent !== null);
}
function topModalEntry() {
  const top = stack[stack.length - 1];
  return top && top.type === 'modal' ? top : null;
}

/* Remove a modal from the stack: hide it, cancel any pending dialog, and restore focus to
 * whatever was focused when it opened — so keyboard users aren't dropped at the page top. */
function dismissModalEntry(entry) {
  closeModalRaw(entry.name);
  if (entry.name === 'confirmSheet') settleDialog(false);
  if (entry.returnFocus && document.contains(entry.returnFocus)) {
    try { entry.returnFocus.focus(); } catch { /* element may be gone */ }
  }
}

export function openModal(id) {
  if (stack.some((en) => en.type === 'modal' && en.name === id)) return; // already open
  const entry = { type: 'modal', name: id, returnFocus: document.activeElement };
  stack.push(entry);
  history.pushState({ depth: stack.length }, '');
  openModalRaw(id);
  const first = focusablesIn(document.getElementById(id))[0];
  if (first) first.focus();
}

export function closeModal(id) {
  const top = stack[stack.length - 1];
  if (top && top.type === 'modal' && top.name === id) {
    stack.pop();
    dismissModalEntry(top);
    suppressPops += 1;
    history.back();
  } else {
    closeModalRaw(id); // not the top entry (or not tracked) — just hide it
  }
}

// Modal keyboard semantics: Escape closes the top modal (routes through history.back so
// the dialog/settle/focus paths all run); Tab is trapped within the open sheet.
document.addEventListener('keydown', (e) => {
  const top = topModalEntry();
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); history.back(); return; }
  if (e.key === 'Tab') {
    const items = focusablesIn(document.getElementById(top.name));
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

let bypassGuardOnce = false; // set when an async guard has already approved this one leave

window.addEventListener('popstate', (e) => {
  if (suppressPops > 0) { suppressPops -= 1; return; }
  const depth = (e.state && typeof e.state.depth === 'number') ? e.state.depth : 0;
  if (depth > stack.length) {
    // forward-nav into entries we no longer have state for (a finished recording, a
    // closed story) — don't fabricate views, just pin history where the app really is
    history.replaceState({ depth: stack.length }, '');
    return;
  }
  while (stack.length > depth) {
    const top = stack[stack.length - 1];
    if (top.type === 'modal') {
      stack.pop();
      dismissModalEntry(top); // hides, cancels any dialog, restores focus
      continue;
    }
    if (!bypassGuardOnce && guards[top.name]) {
      const res = guards[top.name]();
      if (res === false) {
        // veto (e.g. playing→overview, or a plain no): re-create the entry, stay put
        history.pushState({ depth: stack.length }, '');
        return;
      }
      if (res && res.confirm) {
        // guard wants to ask first (in-theme confirm). Restore the view entry so we stay
        // put while the dialog is up; the dialog opens as a normal stacked modal on top,
        // so the push order stays correct. On yes: run the guard's cleanup, then re-issue
        // the back with the guard bypassed so this same leave completes without re-asking.
        history.pushState({ depth: stack.length }, '');
        uiConfirm(res.confirm).then((ok) => {
          if (!ok) return;
          if (res.onConfirm) res.onConfirm();
          bypassGuardOnce = true;
          history.back();
        });
        return;
      }
      // res === true (or any other truthy): fall through and leave
    }
    bypassGuardOnce = false;
    stack.pop();
    if (exits[top.name]) exits[top.name]();
  }
  applyTopView();
});

// home is the root history entry; give it a depth so popstate can tell it apart
history.replaceState({ depth: 0 }, '');

export function setLoading(message) {
  document.getElementById('loadingMessage').textContent = message;
  showView('loading');
}

/* ---------- in-theme dialogs (no native alert/confirm — they puncture the theme) ----------
 * Promise-returning; the sheet participates in history like any modal, so the OS back
 * button cancels an open dialog instead of leaving the view behind it. */
let dialogResolve = null;
let dialogWired = false;

function settleDialog(val) {
  if (!dialogResolve) return;
  const r = dialogResolve;
  dialogResolve = null;
  r(val);
}

function wireDialog() {
  if (dialogWired) return;
  dialogWired = true;
  // settle BEFORE closeModal: closeModal → dismissModalEntry also settles(false) for the
  // confirm sheet (the cancel-on-dismiss path), so the real answer must land first or it
  // gets clobbered. Once settled, dialogResolve is null and the later settle is a no-op.
  document.getElementById('confirmOkBtn').addEventListener('click', () => {
    settleDialog(true);
    closeModal('confirmSheet');
  });
  document.getElementById('confirmCancelBtn').addEventListener('click', () => {
    settleDialog(false);
    closeModal('confirmSheet');
  });
  document.getElementById('confirmSheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { settleDialog(false); closeModal('confirmSheet'); }
  });
}

function openDialog({ title, body, confirmLabel, cancelLabel, danger, alertOnly }) {
  wireDialog();
  settleDialog(false); // a dialog opened over a forgotten one cancels the old one
  document.getElementById('confirmTitle').textContent = title || '';
  const bodyEl = document.getElementById('confirmBody');
  bodyEl.textContent = body || '';
  bodyEl.style.display = body ? '' : 'none';
  const ok = document.getElementById('confirmOkBtn');
  ok.textContent = confirmLabel || 'OK';
  ok.classList.toggle('btn-danger-solid', !!danger);
  const cancel = document.getElementById('confirmCancelBtn');
  cancel.textContent = cancelLabel || 'Cancel';
  cancel.style.display = alertOnly ? 'none' : '';
  openModal('confirmSheet');
  return new Promise((resolve) => { dialogResolve = resolve; });
}

export function uiConfirm(opts) { return openDialog(opts); }
export function uiAlert(opts) { return openDialog({ ...opts, alertOnly: true }).then(() => undefined); }

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
