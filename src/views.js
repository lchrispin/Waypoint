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
      if (top.type === 'modal') closeModalRaw(top.name);
      else if (exits[top.name]) exits[top.name]();
    }
    suppressPops += 1; // history.go fires a single popstate no matter the distance
    history.go(-n);
  }
  showViewRaw('home');
}

function openModalRaw(id) { document.getElementById(id).classList.add('active'); }
function closeModalRaw(id) { document.getElementById(id).classList.remove('active'); }

export function openModal(id) {
  if (stack.some((en) => en.type === 'modal' && en.name === id)) return; // already open
  stack.push({ type: 'modal', name: id });
  history.pushState({ depth: stack.length }, '');
  openModalRaw(id);
}

export function closeModal(id) {
  closeModalRaw(id);
  const top = stack[stack.length - 1];
  if (top && top.type === 'modal' && top.name === id) {
    stack.pop();
    suppressPops += 1;
    history.back();
  }
}

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
      closeModalRaw(top.name);
      continue;
    }
    if (guards[top.name] && !guards[top.name]()) {
      // veto (e.g. discard declined): re-create the popped entry, stay put
      history.pushState({ depth: stack.length }, '');
      return;
    }
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
