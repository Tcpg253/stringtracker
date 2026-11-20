/* StringTracker: private, offline-first, no accounts or external services. */
const DB_NAME = 'stringtracker-db', DB_VERSION = 1;
// The length pieces a stringing method is built from. Values come from the measurements in Settings.
const UNITS = {
  racket: { label: 'Racket length', cm: () => state.settings.racketLength },
  half: { label: '½ racket', cm: () => state.settings.racketLength / 2 },
  end: { label: 'End to T-head', cm: () => state.settings.endLength },
};
const PARTS = { vertical: 'Vertical', horizontal: 'Horizontal' };
const LEGACY_NAMES = { four: 'YY', two: 'SZ' };
const counts = c => Object.fromEntries(Object.keys(UNITS).map(k => [k, Math.max(0, Math.round(Number(c?.[k]) || 0))]));
// Same totals as the original built-in methods: YY = 11 racket + 2 T-head, SZ = 11.5 racket.
const defaultMethods = () => [
  { id: 'four', name: 'YY', active: true, vertical: counts({ racket: 6, end: 1 }), horizontal: counts({ racket: 5, end: 1 }) },
  { id: 'two', name: 'SZ', active: true, vertical: counts({ racket: 6 }), horizontal: counts({ racket: 5, half: 1 }) },
];
const DEFAULT_SETTINGS = { defaultLength: 200, racketLength: 67.5, endLength: 43, lowWarning: 20, criticalWarning: 10, theme: 'auto', lastBackupAt: null };

let db, deferredInstall, busy = false;
const state = { rolls: [], jobs: [], settings: { ...DEFAULT_SETTINGS }, page: 'home', rollId: null, jobQuery: '', jobMethod: '' };

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]));
const pad = v => String(v).padStart(2, '0');
// Local calendar date (not UTC), so early-morning jobs get the right day.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const n = v => Number.parseFloat(v) || 0;
const round4 = v => Math.round(v * 1e4) / 1e4;
const num = v => Number(Math.max(0, v)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const meters = v => `${num(v)} m`;
function dateFmt(d) {
  if (!d) return '';
  const date = new Date(`${d}T12:00:00`);
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}
const ICON = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
};

/* ---------- storage ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of ['rolls', 'jobs', 'settings']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const getAll = name => request(store(name).getAll());
const put = (name, value) => request(store(name, 'readwrite').put(value));
const remove = (name, id) => request(store(name, 'readwrite').delete(id));
const clearStore = name => request(store(name, 'readwrite').clear());
async function load() {
  state.rolls = await getAll('rolls');
  state.jobs = await getAll('jobs');
  const stored = await getAll('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(stored[0]?.value || {}) };
  state.settings.methods = normalizeMethods(state.settings.methods);
  applyTheme();
}
const saveSettings = () => put('settings', { id: 'preferences', value: state.settings });

/* ---------- calculations ---------- */
function normalizeMethods(list) {
  if (!Array.isArray(list)) return defaultMethods();
  return list.filter(m => m && m.id).map(m => ({ id: String(m.id), name: String(m.name || 'Method'), active: m.active !== false, vertical: counts(m.vertical), horizontal: counts(m.horizontal) }));
}
const methods = () => state.settings.methods;
const methodFor = id => methods().find(m => m.id === id);
const partLength = c => Object.entries(UNITS).reduce((sum, [k, u]) => sum + n(c?.[k]) * u.cm(), 0) / 100;
const methodLength = m => partLength(m.vertical) + partLength(m.horizontal);
const activeMethods = () => methods().filter(m => m.active && methodLength(m) > 0);
const consumption = id => { const m = methodFor(id); return m ? methodLength(m) : 0; };
// A deleted method's entries keep the name they were logged with.
const methodName = (id, job) => methodFor(id)?.name || job?.methodName || LEGACY_NAMES[id] || id;
function minConsumption() {
  const pool = activeMethods().length ? activeMethods() : methods();
  const list = pool.map(methodLength).filter(c => c > 0);
  return list.length ? Math.min(...list) : 0;
}
const rollFor = id => state.rolls.find(r => r.id === id);
const jobsFor = id => state.jobs.filter(j => j.rollId === id);
const logged = id => jobsFor(id).reduce((sum, j) => sum + n(j.consumption), 0);
// Rolls saved by the first version stored "remaining" as originalLength with no openingUsed.
const isLegacy = r => r.openingUsed == null && n(r.originalLength) > 0 && n(r.originalLength) < 200;
const original = r => isLegacy(r) ? 200 : (n(r.originalLength) || 200);
const openingUsed = r => isLegacy(r) ? 200 - n(r.originalLength) : n(r.openingUsed);
const used = r => openingUsed(r) + logged(r.id);
const remaining = r => Math.max(0, original(r) - used(r));
const isFinished = r => remaining(r) <= 1e-9 || remaining(r) + 1e-9 < minConsumption();
const isLow = r => !isFinished(r) && remaining(r) < state.settings.lowWarning;
// Split `length` across the active methods: the most rackets possible, then as many of the
// top-listed method as that allows, then the next, and so on.
function plan(length) {
  const list = activeMethods(), result = { total: 0, counts: {} };
  if (!list.length) return result;
  const cost = list.map(methodLength);
  let left = length, toPlace = Math.floor((length + 1e-9) / Math.min(...cost));
  result.total = toPlace;
  list.forEach((m, i) => {
    const rest = cost.slice(i + 1), cheapest = rest.length ? Math.min(...rest) : null;
    // The rackets still to place after this method must fit using the cheapest method below it.
    const k = cheapest == null || cost[i] <= cheapest ? toPlace
      : Math.max(0, Math.min(toPlace, Math.floor((left - toPlace * cheapest + 1e-9) / (cost[i] - cheapest))));
    result.counts[m.id] = k;
    toPlace -= k;
    left -= k * cost[i];
  });
  return result;
}
const activeRolls = () => state.rolls.filter(r => !r.archived)
  .sort((a, b) => Number(isFinished(a)) - Number(isFinished(b)) || String(b.createdAt).localeCompare(String(a.createdAt)));
const rollName = r => `${r.brand} ${r.model}`;
function rollSub(r) {
  const twin = state.rolls.some(o => o.id !== r.id && rollName(o).toLowerCase() === rollName(r).toLowerCase());
  return [r.color, twin ? r.rollCode : ''].filter(Boolean).join(' · ');
}
const sortedJobs = list => [...list].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));

/* ---------- views ---------- */
function emptyState(title, body, button = '') {
  return `<div class="empty"><strong>${title}</strong><p>${body}</p>${button}</div>`;
}
const addRollButton = `<button class="btn primary" data-act="add-roll">${ICON.plus}Add roll</button>`;

function bar(r) {
  const pct = Math.min(100, remaining(r) / original(r) * 100);
  return `<div class="bar ${isFinished(r) ? 'done' : isLow(r) ? 'low' : ''}"><span style="width:${pct}%"></span></div>`;
}
function statusPill(r) {
  if (isFinished(r)) return '<span class="pill muted">Finished</span>';
  if (isLow(r)) return '<span class="pill warn">Low</span>';
  return '';
}
function logButtons(r) {
  if (r.archived) return '';
  if (isFinished(r)) return `<div class="finished-note"><span>Not enough left for another racket.</span><button class="btn small" data-act="archive" data-id="${r.id}">Archive</button></div>`;
  const list = activeMethods();
  if (!list.length) return `<div class="finished-note"><span>No stringing methods are turned on.</span><a class="btn small" href="#/settings">Settings</a></div>`;
  const p = plan(remaining(r)), rem = remaining(r);
  const button = m => {
    const left = p.counts[m.id] || 0;
    return `<button class="log" data-act="log" data-method="${esc(m.id)}" data-id="${r.id}" ${left < 1 || rem + 1e-9 < methodLength(m) ? 'disabled' : ''} aria-label="Log a ${esc(m.name)} racket on ${esc(rollName(r))}">${ICON.plus}<b>${esc(m.name)}</b><small>${left} left</small></button>`;
  };
  return `<div class="log-row">${list.map(button).join('')}</div>`;
}
function rollCard(r) {
  const sub = rollSub(r);
  return `<article class="card roll">
    <a class="roll-top" href="#/roll/${r.id}">
      <span class="roll-name"><strong>${esc(rollName(r))}</strong>${statusPill(r)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="roll-left"><strong>${num(remaining(r))}</strong> m left</span>
    </a>
    ${bar(r)}
    ${logButtons(r)}
  </article>`;
}
function home() {
  if (!state.rolls.length) return emptyState('No rolls yet', 'Add a string roll, then tap YY or SZ each time you string a racket.', addRollButton);
  const active = activeRolls(), archived = state.rolls.filter(r => r.archived);
  return `<div class="page-head"><h1>Rolls</h1>${addRollButton}</div>
    ${active.length ? `<div class="roll-grid">${active.map(rollCard).join('')}</div>` : '<p class="hint">All your rolls are archived.</p>'}
    ${archived.length ? `<details class="archived"><summary>Archived (${archived.length})</summary><div class="card list">${archived.map(r => `<a class="row" href="#/roll/${r.id}"><span class="row-main"><strong>${esc(rollName(r))}</strong><small>${meters(remaining(r))} left</small></span>${ICON.chevron}</a>`).join('')}</div></details>` : ''}`;
}

function jobRow(j, showRoll) {
  const r = rollFor(j.rollId);
  const racket = `${j.racketBrand || ''} ${j.racketModel || ''}`.trim();
  const title = showRoll ? (r ? rollName(r) : 'Deleted roll') : dateFmt(j.date);
  const sub = [showRoll ? dateFmt(j.date) : '', j.tension, racket].filter(Boolean).join(' · ');
  return `<button class="row" data-act="edit-job" data-id="${j.id}"><span class="row-main"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="pill">${esc(methodName(j.method, j))}</span></button>`;
}
function filteredJobs() {
  const q = state.jobQuery.trim().toLowerCase();
  return sortedJobs(state.jobs.filter(j => {
    if (state.jobMethod && j.method !== state.jobMethod) return false;
    if (!q) return true;
    const r = rollFor(j.rollId);
    return `${r ? rollName(r) : ''} ${j.racketBrand || ''} ${j.racketModel || ''} ${j.tension || ''} ${j.notes || ''}`.toLowerCase().includes(q);
  }));
}
// Methods that appear in the history, in the order of the methods list.
function usedMethodIds(jobs = state.jobs) {
  const seen = new Set(jobs.map(j => j.method));
  const ordered = methods().map(m => m.id).filter(id => seen.has(id));
  seen.forEach(id => { if (!ordered.includes(id)) ordered.push(id); });
  return ordered;
}
const usedName = (id, jobs = state.jobs) => methodName(id, jobs.find(j => j.method === id));
const jobList = () => { const list = filteredJobs(); return list.length ? list.map(j => jobRow(j, true)).join('') : '<p class="hint pad">Nothing matches.</p>'; };
function seg(act, current, options) {
  return `<div class="seg">${options.map(([value, label]) => `<button data-act="${act}" data-value="${esc(value)}" aria-pressed="${value === current}">${esc(label)}</button>`).join('')}</div>`;
}
function history() {
  if (!state.jobs.length) return `<div class="page-head"><h1>History</h1></div>${emptyState('Nothing logged yet', 'Rackets you log from a roll will show up here.')}`;
  const ids = usedMethodIds();
  if (!ids.includes(state.jobMethod)) state.jobMethod = '';
  return `<div class="page-head"><h1>History</h1></div>
    <div class="filters"><input type="search" id="jobSearch" placeholder="Search" aria-label="Search history" value="${esc(state.jobQuery)}">${ids.length > 1 ? seg('filter-method', state.jobMethod, [['', 'All'], ...ids.map(id => [id, usedName(id)])]) : ''}</div>
    <div class="card list" id="jobRows">${jobList()}</div>
    <p class="hint">Tap an entry to edit or delete it.</p>`;
}

function most(list) {
  const counts = {};
  list.forEach(x => counts[x] = (counts[x] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}
const kv = (label, value) => `<div class="kv"><span>${label}</span><strong>${value}</strong></div>`;
function stats() {
  if (!state.jobs.length) return `<div class="page-head"><h1>Stats</h1></div>${emptyState('No stats yet', 'Log a few rackets and your numbers will appear here.')}`;
  const count = state.jobs.length, consumed = state.jobs.reduce((x, j) => x + n(j.consumption), 0);
  const of = key => state.jobs.filter(j => j.method === key).length;
  const popular = most(state.jobs.map(j => rollFor(j.rollId)).filter(Boolean).map(rollName));
  return `<div class="page-head"><h1>Stats</h1></div>
    <div class="tiles">
      <div class="card tile"><strong>${count}</strong><span>rackets</span></div>
      <div class="card tile"><strong>${num(consumed)}<i> m</i></strong><span>string used</span></div>
      <div class="card tile"><strong>${num(consumed / count)}<i> m</i></strong><span>per racket</span></div>
    </div>
    <div class="card facts">
      ${usedMethodIds().map(id => kv(`${esc(usedName(id))} rackets`, of(id))).join('')}
      ${popular ? kv('Most used string', esc(popular)) : ''}
      ${kv('Rolls finished', state.rolls.filter(isFinished).length)}
    </div>`;
}

function methodRows() {
  const list = methods();
  if (!list.length) return '<p class="hint pad">No methods yet. Add one to start logging.</p>';
  return list.map((m, i) => `<div class="row method-row">
    <button class="row-main method-open" data-act="edit-method" data-id="${esc(m.id)}"><strong>${esc(m.name)}</strong><small>${meters(methodLength(m))} per racket</small></button>
    ${i ? `<button class="icon-btn" data-act="method-up" data-id="${esc(m.id)}" aria-label="Move ${esc(m.name)} up">${ICON.up}</button>` : ''}
    <button class="switch" role="switch" aria-checked="${m.active}" data-act="method-toggle" data-id="${esc(m.id)}" aria-label="Show ${esc(m.name)} on roll cards"><span></span></button>
  </div>`).join('');
}
function settings() {
  const s = state.settings;
  const field = (key, label, step, min) => `<label class="field">${label}<input type="number" inputmode="decimal" min="${min}" step="${step}" data-setting="${key}" value="${s[key]}"></label>`;
  return `<div class="page-head"><h1>Settings</h1></div>
    <section class="card section">
      <div class="section-head"><h2>Stringing methods</h2><button class="btn small" data-act="add-method">${ICON.plus}Add</button></div>
      <p class="hint">Tap a method to edit it. Switch one off to hide it from your rolls. When a roll is split between methods, the top one gets priority.</p>
      <div class="list inset" id="methodList">${methodRows()}</div>
    </section>
    <section class="card section"><h2>Measurements</h2>
      <div class="form-grid">${field('racketLength', 'Racket length (cm)', '0.01', '1')}${field('endLength', 'End to T-head (cm)', '0.01', '0')}</div>
    </section>
    <section class="card section"><h2>Rolls</h2>
      <div class="form-grid">${field('defaultLength', 'New roll length (m)', '1', '1')}${field('lowWarning', 'Low warning below (m)', '1', '0')}</div>
    </section>
    <section class="card section"><h2>Appearance</h2>${seg('theme', s.theme === 'light' || s.theme === 'dark' ? s.theme : 'auto', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</section>
    <section class="card section"><h2>Backup</h2>
      <p class="hint">Data stays on this device only. Export a backup to keep it safe or move it to another device.</p>
      <div class="btn-row"><button class="btn" data-act="export">Export</button><button class="btn" data-act="import">Import</button><input id="importFile" type="file" accept="application/json,.json" hidden></div>
      ${s.lastBackupAt ? `<p class="hint">Last export: ${dateFmt(s.lastBackupAt)}</p>` : ''}
    </section>
    <section class="card section"><h2>App</h2>
      ${deferredInstall ? '<div class="btn-row"><button class="btn" data-act="install">Install app</button></div>' : '<p class="hint">To install: use your browser’s “Install app”, or on iPhone tap Share → Add to Home Screen.</p>'}
      <div class="btn-row"><button class="btn danger" data-act="reset">Reset all data</button></div>
    </section>`;
}

function rollDetail() {
  const r = rollFor(state.rollId);
  const jobs = sortedJobs(jobsFor(r.id)), sub = [r.color, r.rollCode].filter(Boolean).join(' · ');
  const of = key => jobs.filter(j => j.method === key).length;
  const fullPlan = plan(original(r)).total;
  return `<a class="back" href="#/">${ICON.back}Rolls</a>
    <div class="page-head"><div><h1>${esc(rollName(r))}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
      <div class="btn-row"><button class="btn small" data-act="edit-roll" data-id="${r.id}">Edit</button><button class="btn small" data-act="archive" data-id="${r.id}">${r.archived ? 'Restore' : 'Archive'}</button></div></div>
    <section class="card hero">
      <div class="big">${num(remaining(r))}<i> m</i>${statusPill(r)}</div>
      <p class="sub">left of ${meters(original(r))}</p>
      ${bar(r)}
      ${logButtons(r)}
    </section>
    <section class="card facts">
      ${kv('Rackets strung', jobs.length ? `${jobs.length} <small>(${usedMethodIds(jobs).map(id => `${of(id)} ${esc(usedName(id, jobs))}`).join(' · ')})</small>` : '0')}
      ${n(r.price) > 0 && fullPlan ? kv('String cost per racket', `¥${(n(r.price) / fullPlan).toFixed(2)}`) : ''}
      ${r.purchaseDate ? kv('Bought', dateFmt(r.purchaseDate)) : ''}
      ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
    </section>
    ${jobs.length ? `<h2 class="list-title">History</h2><div class="card list">${jobs.map(j => jobRow(j, false)).join('')}</div>` : ''}`;
}

const VIEWS = { home, history, stats, settings, roll: rollDetail };
function render() {
  if (state.page === 'roll' && !rollFor(state.rollId)) { location.replace('#/'); return; }
  $('#app').innerHTML = VIEWS[state.page]();
  const current = state.page === 'roll' ? 'home' : state.page;
  $$('[data-nav]').forEach(a => a.dataset.nav === current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
}
function route() {
  const [, page, id] = location.hash.split('/');
  state.page = ['history', 'stats', 'settings', 'roll'].includes(page) ? page : 'home';
  state.rollId = state.page === 'roll' ? id : null;
  closeModal();
  render();
  window.scrollTo(0, 0);
}

/* ---------- modal & toast ---------- */
function modal(title, content) {
  document.body.style.overflow = 'hidden';
  $('#modalRoot').innerHTML = `<div class="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="close" data-act="close" aria-label="Close">×</button></div>${content}</section></div>`;
  $('.backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; document.body.style.overflow = ''; }
function confirmModal(title, body, label, onConfirm) {
  modal(title, `<p class="modal-text">${body}</p><div class="modal-foot"><button class="btn" data-act="close">Cancel</button><button class="btn danger solid" id="confirmYes">${label}</button></div>`);
  $('#confirmYes').onclick = onConfirm;
}
let toastTimer;
function toast(message, actionLabel, action) {
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: actionLabel });
    b.onclick = () => { el.remove(); action(); };
    el.append(b);
  }
  $('#toastRoot').replaceChildren(el);
  toastTimer = setTimeout(() => el.remove(), action ? 6000 : 2600);
}

/* ---------- actions ---------- */
async function refresh() { await load(); render(); }

async function logRacket(rollId, method) {
  if (busy) return;
  const r = rollFor(rollId), m = methodFor(method), c = m ? methodLength(m) : 0;
  if (!r || !m || c <= 0) return;
  if (remaining(r) + 1e-9 < c) { toast('Not enough string on this roll.'); return; }
  busy = true;
  try {
    const job = { id: uid('job'), rollId, method, methodName: m.name, date: today(), consumption: c, racketBrand: '', racketModel: '', tension: '', notes: '', createdAt: new Date().toISOString() };
    await put('jobs', job);
    await refresh();
    toast(`${m.name} racket logged`, 'Undo', async () => { await remove('jobs', job.id); await refresh(); toast('Removed.'); });
  } catch (e) { toast('Could not save. Please try again.'); }
  busy = false;
}

function rollForm(id) {
  const r = id ? rollFor(id) : null;
  const full = r ? original(r) : (n(state.settings.defaultLength) || 200);
  const extras = r && (r.color || r.purchaseDate || r.price || r.notes);
  modal(r ? 'Edit roll' : 'Add roll', `<form id="rollForm">
    <div class="form-grid">
      <label class="field">Brand<input required name="brand" value="${esc(r?.brand || '')}" placeholder="Yonex"></label>
      <label class="field">Model<input required name="model" value="${esc(r?.model || '')}" placeholder="BG80"></label>
      <label class="field full">String left now (m)<input required type="number" inputmode="decimal" min="0" max="2000" step="0.0001" name="left" value="${r ? round4(remaining(r)) : full}"></label>
    </div>
    <details class="more" ${extras ? 'open' : ''}><summary>More details</summary><div class="form-grid">
      <label class="field">Color<input name="color" value="${esc(r?.color || '')}"></label>
      <label class="field">Price (¥)<input type="number" inputmode="decimal" min="0" step="0.01" name="price" value="${esc(r?.price || '')}"></label>
      <label class="field full">Bought on<input type="date" name="purchaseDate" value="${esc(r?.purchaseDate || '')}"></label>
      <label class="field full">Notes<textarea name="notes" rows="2">${esc(r?.notes || '')}</textarea></label>
    </div></details>
    <div class="modal-foot">${r ? '<button type="button" class="btn danger left" id="deleteRoll">Delete</button>' : ''}<button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">${r ? 'Save' : 'Add roll'}</button></div>
  </form>`);
  if (r) $('#deleteRoll').onclick = () => deleteRoll(r);
  else $('#rollForm').elements.brand.focus();
  $('#rollForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const left = n(f.left), done = r ? logged(r.id) : 0;
    // A roll holding more than the standard length is simply a longer roll.
    const length = Math.max(full, round4(left + done));
    const fields = { brand: f.brand.trim(), model: f.model.trim(), color: f.color.trim(), price: f.price.trim(), purchaseDate: f.purchaseDate, notes: f.notes.trim(), originalLength: length, openingUsed: Math.max(0, round4(length - left - done)) };
    if (r) await put('rolls', { ...r, ...fields });
    else {
      const number = String(Math.max(0, ...state.rolls.map(x => Number(x.rollCode?.match(/\d+/)?.[0]) || 0)) + 1).padStart(3, '0');
      await put('rolls', { id: uid('roll'), rollCode: `Roll #${number}`, ...fields, archived: false, empty: false, createdAt: new Date().toISOString() });
      // Ask the browser not to evict this data when the device runs low on space.
      navigator.storage?.persist?.().catch(() => {});
    }
    closeModal();
    await refresh();
    toast(r ? 'Roll updated.' : 'Roll added.');
  });
}

function deleteRoll(r) {
  const count = jobsFor(r.id).length;
  confirmModal('Delete this roll?', `${esc(rollName(r))} ${count ? `and its ${count} logged racket${count === 1 ? '' : 's'} ` : ''}will be permanently deleted. To keep the history, archive the roll instead.`, 'Delete', async () => {
    for (const j of jobsFor(r.id)) await remove('jobs', j.id);
    await remove('rolls', r.id);
    closeModal();
    await load();
    if (location.hash === '#/' || !location.hash) render(); else location.hash = '#/';
    toast('Roll deleted.');
  });
}

async function deleteJob(j) {
  await remove('jobs', j.id);
  closeModal();
  await refresh();
  toast('Entry deleted', 'Undo', async () => { await put('jobs', j); await refresh(); });
}
function jobForm(jobId) {
  const j = state.jobs.find(x => x.id === jobId);
  if (!j) return;
  const r = rollFor(j.rollId);
  if (!r) { confirmModal('Delete this entry?', 'Its roll no longer exists.', 'Delete', () => deleteJob(j)); return; }
  const choices = methods().map(m => [m.id, m.name]);
  if (!methodFor(j.method)) choices.push([j.method, methodName(j.method, j)]);
  const options = choices.map(([id, name]) => `<option value="${esc(id)}" ${j.method === id ? 'selected' : ''}>${esc(name)}</option>`).join('');
  const extras = j.racketBrand || j.racketModel || j.notes;
  modal('Edit entry', `<p class="modal-text">${esc(rollName(r))}</p><form id="jobForm">
    <div class="form-grid">
      <label class="field">Date<input required type="date" name="date" value="${esc(j.date || today())}"></label>
      <label class="field">Method<select name="method">${options}</select></label>
      <label class="field full">Tension<input name="tension" value="${esc(j.tension || '')}" placeholder="e.g. 26 lbs"></label>
    </div>
    <details class="more" ${extras ? 'open' : ''}><summary>More details</summary><div class="form-grid">
      <label class="field">Racket brand<input name="racketBrand" value="${esc(j.racketBrand || '')}"></label>
      <label class="field">Racket model<input name="racketModel" value="${esc(j.racketModel || '')}"></label>
      <label class="field full">String used (m)<input required type="number" inputmode="decimal" min="0.0001" step="0.0001" name="amount" value="${n(j.consumption)}"></label>
      <label class="field full">Notes<textarea name="notes" rows="2">${esc(j.notes || '')}</textarea></label>
    </div></details>
    <div class="modal-foot"><button type="button" class="btn danger left" id="deleteJob">Delete</button><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
  const form = $('#jobForm');
  form.elements.method.addEventListener('change', () => { const c = consumption(form.elements.method.value); if (c > 0) form.elements.amount.value = round4(c); });
  $('#deleteJob').onclick = () => deleteJob(j);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const amount = n(f.amount), others = used(r) - n(j.consumption);
    if (amount <= 0 || others + amount > original(r) + 1e-9) { toast('That is more string than this roll has left.'); return; }
    await put('jobs', { ...j, method: f.method, methodName: methodName(f.method, j), date: f.date, tension: f.tension.trim(), racketBrand: f.racketBrand.trim(), racketModel: f.racketModel.trim(), notes: f.notes.trim(), consumption: amount, updatedAt: new Date().toISOString() });
    closeModal();
    await refresh();
    toast('Saved.');
  });
}

/* ---------- stringing methods ---------- */
let draft = null;
function partEditor(part) {
  const c = draft[part], len = partLength(c);
  const chips = Object.entries(UNITS).filter(([k]) => c[k] > 0).map(([k, u]) =>
    `<span class="chip">${c[k]} × ${u.label}<button type="button" data-act="unit-sub" data-part="${part}" data-unit="${k}" aria-label="Remove one ${u.label} from ${PARTS[part]}">−</button></span>`).join('');
  return `<div class="part-head"><h3>${PARTS[part]}</h3><span>${len ? meters(len) : ''}</span></div>
    <div class="chips">${chips || '<span class="hint-inline">Tap the buttons below to add lengths.</span>'}</div>
    <div class="unit-row">${Object.entries(UNITS).map(([k, u]) =>
      `<button type="button" class="unit" data-act="unit-add" data-part="${part}" data-unit="${k}" aria-label="Add one ${u.label} to ${PARTS[part]}">${ICON.plus}<span>${u.label}</span><small>${num(u.cm())} cm</small></button>`).join('')}</div>`;
}
const methodTotal = () => `Total <strong>${meters(methodLength(draft))}</strong> per racket`;
function changeUnit(el, delta) {
  const { part, unit } = el.dataset;
  draft[part][unit] = Math.max(0, draft[part][unit] + delta);
  $(`.part[data-part="${part}"]`).innerHTML = partEditor(part);
  $('#methodTotal').innerHTML = methodTotal();
}
function methodForm(id) {
  const m = id ? methodFor(id) : null;
  draft = m ? structuredClone(m) : { id: uid('method'), name: '', active: true, vertical: counts(), horizontal: counts() };
  modal(m ? 'Edit method' : 'Add method', `<form id="methodForm">
    <label class="field">Name<input required name="name" maxlength="24" value="${esc(draft.name)}" placeholder="e.g. YY 4-knot" autocomplete="off"></label>
    ${Object.keys(PARTS).map(part => `<div class="part" data-part="${part}">${partEditor(part)}</div>`).join('')}
    <div class="method-total" id="methodTotal">${methodTotal()}</div>
    <label class="check"><input type="checkbox" name="active" ${draft.active ? 'checked' : ''}>Show on roll cards</label>
    <div class="modal-foot">${m ? '<button type="button" class="btn danger left" id="deleteMethod">Delete</button>' : ''}<button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
  const form = $('#methodForm');
  if (!m) form.elements.name.focus();
  if (m) $('#deleteMethod').onclick = () => deleteMethod(m);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    draft.name = form.elements.name.value.trim();
    draft.active = form.elements.active.checked;
    if (!draft.name) { toast('Give the method a name.'); return; }
    if (methodLength(draft) <= 0) { toast('Add at least one length.'); return; }
    const list = methods(), i = list.findIndex(x => x.id === draft.id);
    if (i >= 0) list[i] = draft; else list.push(draft);
    await saveSettings();
    closeModal();
    render();
    toast(m ? 'Method saved.' : 'Method added.');
  });
}
function deleteMethod(m) {
  const count = state.jobs.filter(j => j.method === m.id).length;
  confirmModal('Delete this method?', `${esc(m.name)} will be removed.${count ? ` The ${count === 1 ? 'racket' : `${count} rackets`} logged with it ${count === 1 ? 'stays' : 'stay'} in your history.` : ''}`, 'Delete', async () => {
    for (const j of state.jobs.filter(j => j.method === m.id)) await put('jobs', { ...j, methodName: m.name });
    state.settings.methods = methods().filter(x => x.id !== m.id);
    await saveSettings();
    closeModal();
    await refresh();
    toast('Method deleted.');
  });
}
async function updateMethods(change) {
  change(methods());
  await saveSettings();
  $('#methodList').innerHTML = methodRows();
}

async function toggleArchive(id) {
  const r = rollFor(id);
  if (!r) return;
  await put('rolls', { ...r, archived: !r.archived });
  await load();
  toast(r.archived ? 'Roll restored.' : 'Roll archived. Its history is kept.');
  if (state.page === 'roll' && !r.archived) location.hash = '#/'; else render();
}

async function exportData() {
  const payload = { app: 'StringTracker', version: 1, exportedAt: new Date().toISOString(), rolls: state.rolls, jobs: state.jobs, settings: state.settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: `stringtracker-backup-${today()}.json` }).click();
  URL.revokeObjectURL(url);
  state.settings.lastBackupAt = today();
  await saveSettings();
  render();
  toast('Backup downloaded.');
}
async function replaceAll(rolls, jobs, settingsValue) {
  for (const s of ['rolls', 'jobs', 'settings']) await clearStore(s);
  for (const r of rolls) await put('rolls', r);
  for (const j of jobs) await put('jobs', j);
  if (settingsValue) await put('settings', { id: 'preferences', value: { ...DEFAULT_SETTINGS, ...settingsValue } });
  closeModal();
  await refresh();
}
async function importData(file) {
  try {
    const p = JSON.parse(await file.text());
    if (!p || p.app !== 'StringTracker' || !Array.isArray(p.rolls) || !Array.isArray(p.jobs) || !p.settings || typeof p.settings !== 'object') throw Error('not a StringTracker backup');
    if (!p.rolls.every(r => r.id && r.brand && r.model && Number.isFinite(Number(r.originalLength))) || !p.jobs.every(j => j.id && j.rollId && j.method && Number.isFinite(Number(j.consumption)))) throw Error('backup contains invalid records');
    confirmModal('Replace your data?', `This backup has ${p.rolls.length} roll(s) and ${p.jobs.length} racket(s). Importing replaces everything currently on this device.`, 'Replace', async () => { await replaceAll(p.rolls, p.jobs, p.settings); toast('Backup restored.'); });
  } catch (err) { toast(`Could not import: ${err.message}`); }
}
function resetData() {
  confirmModal('Reset all data?', 'This permanently deletes every roll, entry and setting on this device. Export a backup first if you might want them back.', 'Reset', async () => { await replaceAll([], [], null); toast('All data reset.'); });
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.settings.theme, explicit = t === 'light' || t === 'dark';
  if (explicit) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { explicit ? localStorage.setItem('st-theme', t) : localStorage.removeItem('st-theme'); } catch (e) { /* storage blocked */ }
  const dark = explicit ? t === 'dark' : systemDark.matches;
  $('meta[name="theme-color"]').content = dark ? '#111315' : '#f4f3ef';
}

/* ---------- events ---------- */
const ACTIONS = {
  'add-roll': () => rollForm(),
  'edit-roll': el => rollForm(el.dataset.id),
  'archive': el => toggleArchive(el.dataset.id),
  'log': el => logRacket(el.dataset.id, el.dataset.method),
  'edit-job': el => jobForm(el.dataset.id),
  'close': closeModal,
  'filter-method': el => { state.jobMethod = el.dataset.value; render(); },
  'theme': async el => { state.settings.theme = el.dataset.value; await saveSettings(); applyTheme(); render(); },
  'export': exportData,
  'import': () => $('#importFile').click(),
  'reset': resetData,
  'add-method': () => methodForm(),
  'edit-method': el => methodForm(el.dataset.id),
  'method-toggle': el => updateMethods(list => { const m = list.find(x => x.id === el.dataset.id); if (m) m.active = !m.active; }),
  'method-up': el => updateMethods(list => { const i = list.findIndex(x => x.id === el.dataset.id); if (i > 0) list.splice(i - 1, 0, ...list.splice(i, 1)); }),
  'unit-add': el => changeUnit(el, 1),
  'unit-sub': el => changeUnit(el, -1),
  'install': async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) ACTIONS[el.dataset.act]?.(el);
});
document.addEventListener('input', e => {
  if (e.target.id === 'jobSearch') { state.jobQuery = e.target.value; $('#jobRows').innerHTML = jobList(); }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'importFile') { if (el.files[0]) importData(el.files[0]); el.value = ''; return; }
  const key = el.dataset?.setting;
  if (!key) return;
  const value = n(el.value);
  if (el.value.trim() === '' || value < n(el.min)) { el.value = state.settings[key]; toast('Enter a valid number.'); return; }
  state.settings[key] = value;
  await saveSettings();
  $('#methodList').innerHTML = methodRows();
  toast('Saved.');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', route);
systemDark.addEventListener('change', applyTheme);
const syncOffline = () => { $('#offlineStatus').hidden = navigator.onLine; };
window.addEventListener('online', syncOffline);
window.addEventListener('offline', syncOffline);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (state.page === 'settings') render(); });

(async function init() {
  try {
    db = await openDB();
    await load();
    route();
    syncOffline();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (err) {
    $('#app').innerHTML = emptyState('Storage could not start', `StringTracker needs browser storage (IndexedDB) enabled. ${esc(err.message)}`);
  }
})();
