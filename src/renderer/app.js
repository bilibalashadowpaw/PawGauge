'use strict';
const SEGS = 32;
const STALE_READING_MS = 30 * 60 * 1000;

const list = document.getElementById('list');
const updatedEl = document.getElementById('updated');
const refreshBtn = document.getElementById('refresh');
const pinBtn = document.getElementById('pin');
const mascotBtn = document.getElementById('mascot');

const nodes = new Map(); // account id -> { el, meters: Map, more }
let state = null;
let firstRender = true;

/* ---------- tiny DOM helpers (text always goes through textContent) ---------- */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
// Make parent's children equal `kids`, touching only what differs: a node that is removed and re-added loses keyboard focus.
function syncChildren(parent, kids) {
  kids.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null);
  });
  while (parent.children.length > kids.length) parent.lastChild.remove();
}
function icon(name) {
  // Static, bundled markup only (icons.js); parsed as SVG, never fed any account data.
  const doc = new DOMParser().parseFromString(window.ICONS[name], 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/* ---------- formatting ---------- */
// Meters show how much is USED (like the official usage screens). Thresholds live in ../shared/levels.js, shared with the tray.
const { levelOfUsed: levelOf, LOW_DAYS } = window.LEVELS;

function fmtPct(p) {
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}
function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${Math.max(m, 1)}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}
function resetText(w) {
  if (w.resetsAt == null) return 'Starts with your next request';
  const left = w.resetsAt - Date.now();
  return left <= 0 ? 'Resetting now' : `Resets in ${fmtDuration(left)}`;
}
function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
const SYMBOL = { CNY: '¥', USD: '$' };
function fmtMoney(b) {
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(b.total);
  return SYMBOL[b.currency] ? `${SYMBOL[b.currency]}${n}` : `${b.currency} ${n}`;
}
function daysText(d) {
  if (d == null) return 'Spend estimate appears after a day of readings';
  if (d < 1) return 'Under a day left at current spend';
  if (d > 365) return 'More than a year left at current spend';
  return `About ${Math.round(d)} days left at current spend`;
}
function errorHint(a) {
  const src = a.sourceName || 'its settings';
  switch (a.error && a.error.kind) {
    case 'auth': return `Update the key in ${src}.`;
    case 'nokey': return `Add a key in ${src}.`;
    case 'shape': return 'The provider changed its response. PawGauge needs an update.';
    case 'moved': return `${src} no longer points at this service, so its key was not sent. Press Refresh to check again.`;
    case 'region': return 'PawGauge cannot read this region yet, so the key was not sent.';
    default: return 'Retrying automatically.';
  }
}

/* ---------- level meter ---------- */
function makeMeter() {
  const segs = Array.from({ length: SEGS }, (_, i) => {
    const s = document.createElement('i');
    s.style.setProperty('--i', i);
    return s;
  });
  const label = h('span', { class: 'm-label' });
  const val = h('span', { class: 'm-val' });
  const reset = h('span', { class: 'm-reset' });
  const el = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100 }, label, h('div', { class: 'segs' }, segs), val, reset);
  return { el, segs, label, val, reset };
}
function updateMeter(m, w) {
  const pct = Math.min(100, Math.max(0, 100 - w.remainingPct)); // used
  const on = pct <= 0 ? 0 : Math.max(1, Math.round((pct / 100) * SEGS));
  m.segs.forEach((s, i) => s.classList.toggle('on', i < on));
  m.el.className = `meter s-${levelOf(pct)}`;
  m.el.setAttribute('aria-valuenow', Math.round(pct));
  m.el.setAttribute('aria-label', `${w.label}, ${Math.round(pct)} percent used`);
  m.el.title = w.detail || '';
  m.label.textContent = w.label;
  m.val.replaceChildren(document.createTextNode(fmtPct(pct)), h('span', { class: 'm-unit' }, ' used'));
  m.reset.textContent = resetText(w);
}
function skeletonMeter(label) {
  const m = makeMeter();
  m.label.textContent = label;
  m.val.textContent = '--';
  m.reset.textContent = ' ';
  return m.el;
}

/* ---------- account ---------- */
function meterFor(n, w) {
  let m = n.meters.get(w.id);
  if (!m) {
    m = makeMeter();
    n.meters.set(w.id, m);
  }
  updateMeter(m, w);
  return m.el;
}

function bodyFor(a, n) {
  if (a.status === 'loading') {
    return [h('div', { class: 'loading', 'aria-busy': 'true' }, skeletonMeter('5h'), skeletonMeter('Week'))];
  }
  if (a.status === 'empty') {
    return [h('div', { class: 'notice plain' }, h('div', {}, 'No reading yet', h('small', {}, 'Needs the status-line script from the README, then a Claude Code session on your plan.')))];
  }
  const parts = [];
  if (a.kind === 'balance' && a.balance) {
    const low = !a.balance.available || (a.daysLeft != null && a.daysLeft < LOW_DAYS);
    parts.push(
      h(
        'div',
        { class: `balance${low ? ' low' : ''}` },
        h('div', { class: 'balance-amt' }, fmtMoney(a.balance)),
        h('div', { class: 'balance-sub' }, a.balance.available ? daysText(a.daysLeft) : 'Balance exhausted. Top up to keep using the API.')
      )
    );
  } else {
    const main = a.windows.filter((w) => !w.minor);
    const minor = a.windows.filter((w) => w.minor);
    main.forEach((w) => parts.push(meterFor(n, w)));
    if (minor.length) {
      if (!n.more) {
        n.moreText = document.createTextNode('');
        n.more = h('details', { class: 'more' }, h('summary', {}, icon('caret'), n.moreText));
      }
      n.moreText.data = `Other models (${minor.length})`;
      // Only the meters after the summary change; the summary itself stays put so it keeps keyboard focus.
      syncChildren(n.more, [n.more.firstChild, ...minor.map((w) => meterFor(n, w))]);
      parts.push(n.more);
    }
  }
  if (a.status === 'error') {
    // Reused while the message is unchanged: a fresh role="alert" node would be announced again on every poll.
    const key = `${a.error.kind}|${a.error.message}|${a.sourceName}`;
    if (n.errKey !== key) {
      n.errKey = key;
      n.errEl = h('div', { class: 'notice err', role: 'alert' }, icon('warning'), h('div', {}, a.error.message, h('small', {}, errorHint(a))));
    }
    parts.push(n.errEl);
  } else {
    n.errKey = null;
  }
  return parts;
}

// One row per account, built once. Later states only change text and attributes, so keyboard focus (grip, link button,
// "Other models") and the screen reader's place survive the poll that arrives every few seconds.
function makeAccount(a) {
  const el = h('article', { class: 'acct' });
  const grip = h('button', { class: 'grip', type: 'button', title: 'Drag to reorder' }, icon('grip'));
  wireGrip(grip, el);
  const site = h('button', { class: 'icon-btn site', type: 'button' }, icon('external'));
  site.addEventListener('click', () => window.usage.openProvider(a.provider));
  const name = h('span', { class: 'name' });
  const plan = h('span', { class: 'plan' });
  const age = h('span', { class: 'age' });
  const body = h('div', { class: 'body' });
  el.append(h('div', { class: 'acct-head' }, grip, h('div', { class: 'tile', 'aria-hidden': 'true' }, a.monogram), h('div', {}, name, plan), age, site), body);
  el.dataset.provider = a.provider;
  el.dataset.id = a.id;
  return { el, grip, site, name, plan, age, body, meters: new Map(), more: null, moreText: null, errKey: null, errEl: null };
}

function patchAccount(a) {
  let n = nodes.get(a.id);
  // Badge, colour and website button are set when the row is built, so a row handed to another service is built again.
  if (!n || n.el.dataset.provider !== a.provider) {
    n = makeAccount(a);
    nodes.set(a.id, n);
  }
  const readingAge = a.readingAt ? Date.now() - a.readingAt : null;
  const staleReading = readingAge != null && readingAge > STALE_READING_MS;
  const hasData = a.status === 'ok' || (a.status === 'error' && (a.windows.length || a.balance));
  const site = a.providerName || a.provider;
  n.el.className = `acct${a.status === 'error' || staleReading ? ' dim' : ''}`;
  n.el.setAttribute('aria-label', a.label);
  n.grip.setAttribute('aria-label', `Move ${a.label}. Use the up and down arrow keys, or drag.`);
  n.site.setAttribute('aria-label', `Open ${site} website`);
  n.site.title = `Open ${site} to manage usage and billing`;
  n.name.textContent = a.label;
  n.plan.textContent = a.plan || '';
  n.plan.hidden = !a.plan;
  const showAge = readingAge != null && hasData;
  n.age.textContent = showAge ? `Reading ${fmtAge(readingAge)}` : '';
  n.age.hidden = !showAge;
  syncChildren(n.body, bodyFor(a, n));
  return n.el;
}

/* ---------- reorder (drag the grip, or focus it and use the up/down arrows) ---------- */
let dragging = null;
function emitOrder() {
  window.usage.setOrder([...list.querySelectorAll('.acct')].map((el) => el.dataset.id));
}
function wireGrip(grip, article) {
  grip.addEventListener('pointerdown', () => { article.draggable = true; });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const sib = e.key === 'ArrowUp' ? article.previousElementSibling : article.nextElementSibling;
    if (!sib) return;
    if (e.key === 'ArrowUp') list.insertBefore(article, sib);
    else list.insertBefore(sib, article);
    grip.focus();
    emitOrder();
  });
  article.addEventListener('dragstart', (e) => {
    dragging = article;
    article.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', article.dataset.id);
  });
  article.addEventListener('dragend', () => {
    article.draggable = false;
    article.classList.remove('dragging');
    dragging = null;
    emitOrder();
  });
}
list.addEventListener('dragover', (e) => {
  if (!dragging) return;
  e.preventDefault();
  const others = [...list.querySelectorAll('.acct')].filter((el) => el !== dragging);
  const next = others.find((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
  if (next) list.insertBefore(dragging, next);
  else list.append(dragging);
});

const autosortBtn = document.getElementById('autosort');
autosortBtn.append(icon('sort'));
autosortBtn.addEventListener('click', () => window.usage.setOrder(null));

/* ---------- Accounts screen: every account (show, hide, rename), then each skipped file and why ---------- */
const setupEl = document.getElementById('setup');
const setupSummary = document.getElementById('setup-summary');
const setupAccounts = document.getElementById('setup-accounts');
const setupFiles = document.getElementById('setup-files');
const setupClose = document.getElementById('setup-close');
const setupRows = new Map(); // account id -> row nodes, kept so that a rescan never wipes a name being typed
let setupKey = null;

const SKIPPED = {
  'no-base-url': () => 'No API address (ANTHROPIC_BASE_URL) in this file',
  'bad-url': () => 'The API address is not a valid URL',
  'unknown-host': (r) => `${r.host} is not a service PawGauge supports`,
  'unsupported-region': (r) => `${r.providerName} at ${r.host}: this region is not supported yet`,
  'no-key': (r) => `${r.providerName} address, but no API key`,
  unreadable: () => 'Not valid JSON, or the file cannot be read',
  duplicate: (r) => `Same account as ${r.sameAs}`,
  'unknown-provider': (r) => `The entry "${r.id}" names an unknown provider`,
  'no-id': () => 'An entry has no id',
};

function makeSetupRow(id) {
  const n = { id, saved: '' };
  n.show = h('input', { type: 'checkbox' });
  n.name = h('input', { class: 'a-name', type: 'text', maxlength: '40', spellcheck: 'false' });
  n.from = h('span', { class: 'a-from' });
  n.remove = h('button', { class: 'btn', type: 'button', title: 'Take this added account off the list' }, 'Remove');
  n.el = h('li', {}, n.show, n.name, n.remove, n.from);
  n.show.addEventListener('change', () => window.usage.changeAccount(id, { hidden: !n.show.checked }));
  n.name.addEventListener('change', () => {
    if (n.name.value.trim() !== n.saved) window.usage.changeAccount(id, { label: n.name.value });
  });
  n.name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.stopPropagation(); // Esc here cancels the edit; it must not also hide the window
    if (e.key === 'Escape') n.name.value = n.saved;
    n.name.blur();
  });
  n.remove.addEventListener('click', () => window.usage.removeAccount(id));
  return n;
}

function setupRow(a) {
  let n = setupRows.get(a.id);
  if (!n) {
    n = makeSetupRow(a.id);
    setupRows.set(a.id, n);
  }
  n.saved = a.label;
  if (document.activeElement !== n.name) n.name.value = a.label;
  n.name.placeholder = a.autoLabel;
  n.name.setAttribute('aria-label', `Name for ${a.autoLabel}`);
  n.show.checked = !a.hidden;
  n.show.setAttribute('aria-label', `Show ${a.label || a.autoLabel}`);
  n.from.textContent = a.provider === 'anthropic' ? 'Claude plan usage' : [a.providerName, a.source].filter(Boolean).join(' · ');
  n.remove.hidden = !a.removable;
  n.el.className = a.hidden ? 'off' : '';
  return n.el;
}

function skippedRow(r) {
  const why = h('span', { class: 'f-why' }, `Skipped: ${(SKIPPED[r.reason] || (() => r.reason))(r)}`);
  let assign = null;
  if (r.canAssign) {
    assign = h('button', { class: 'btn', type: 'button' }, 'Choose its service…');
    assign.addEventListener('click', () => window.usage.assignFile(r.file));
  }
  return h('li', {}, h('span', { class: 'f-name' }, r.file), why, assign);
}

function renderSetup() {
  const report = state.setup;
  setupEl.hidden = !report;
  if (!report) {
    setupKey = null;
    return;
  }
  // Rebuilt only when the findings change, so a poll does not make the screen reader announce them again.
  const key = JSON.stringify(report);
  if (key === setupKey) return;
  setupKey = key;
  const found = report.accounts.filter((a) => a.provider !== 'anthropic').length;
  const where = report.dirFound ? `Looked in ${report.dir}.` : `No Claude Code folder at ${report.dir}.`;
  setupSummary.textContent = `${where} ${found ? `Found ${found} ${found === 1 ? 'account' : 'accounts'} with a service PawGauge supports.` : 'No z.ai, MiniMax or DeepSeek account found.'}`;
  syncChildren(setupAccounts, report.accounts.map(setupRow));
  setupAccounts.hidden = !report.accounts.length;
  const skipped = report.files.filter((r) => r.status === 'skipped' && r.reason !== 'hidden' && r.reason !== 'listed');
  setupFiles.replaceChildren(...skipped.map(skippedRow));
  setupFiles.hidden = !skipped.length;
}

setupClose.append(icon('x'));
setupClose.addEventListener('click', () => window.usage.closeSetup());
document.getElementById('setup-add').addEventListener('click', () => window.usage.pickFile());
document.getElementById('setup-again').addEventListener('click', () => window.usage.refresh());
document.getElementById('setup-guide').addEventListener('click', () => window.usage.openSetupGuide());

/* ---------- collapsed pill ---------- */
const appEl = document.getElementById('app');
const pill = document.getElementById('pill');
const pillName = document.getElementById('pill-name');
const pillVal = document.getElementById('pill-val');
const collapseBtn = document.getElementById('collapse');

// The pill shows the most urgent account (lowest urgency, never just the first row: a manual order makes that arbitrary).
// Its dot uses the same thresholds as the meters in the panel (90% used = orange, 100% = red).
function pillSummary() {
  const ok = state.accounts.filter((a) => a.status === 'ok').sort((x, y) => x.urgency - y.urgency);
  const a = ok[0];
  if (!a) {
    const errors = state.accounts.filter((a2) => a2.status === 'error').length;
    return errors ? { name: 'Needs attention', val: String(errors), level: 'warn' } : { name: 'PawGauge', val: '--', level: 'idle' };
  }
  if (a.kind === 'balance' && a.balance) {
    const low = !a.balance.available || (a.daysLeft != null && a.daysLeft < LOW_DAYS);
    return { name: a.label, val: fmtMoney(a.balance), level: !a.balance.available ? 'crit' : low ? 'warn' : 'ok' };
  }
  const main = a.windows.filter((w) => !w.minor);
  const ws = main.length ? main : a.windows;
  const used = ws.length ? Math.max(...ws.map((w) => Math.min(100, Math.max(0, 100 - w.remainingPct)))) : 0;
  return { name: a.label, val: fmtPct(used), level: levelOf(used) };
}
function renderPill() {
  const s = pillSummary();
  pillName.textContent = s.name;
  pillVal.textContent = s.val;
  pill.className = `pill s-${s.level}`;
  pill.setAttribute('aria-label', `Expand PawGauge. ${s.name}, ${s.val}${s.level === 'idle' ? '' : ' used'}`);
}
function applyMode() {
  const c = !!state.collapsed;
  document.documentElement.classList.toggle('collapsed', c);
  document.body.dataset.ax = state.ax || 'right';
  document.body.dataset.ay = state.ay || 'bottom';
  appEl.inert = c;
  pill.inert = !c;
  pill.tabIndex = c ? 0 : -1;
  collapseBtn.setAttribute('aria-expanded', String(!c));
}

// Drag the pill to move the window; a click that barely moves expands it. (An OS drag region would swallow the click.)
let pdrag = null;
pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pill.setPointerCapture(e.pointerId);
  pdrag = { x: e.screenX, y: e.screenY, moved: false };
});
pill.addEventListener('pointermove', (e) => {
  if (!pdrag) return;
  if (!pdrag.moved && Math.hypot(e.screenX - pdrag.x, e.screenY - pdrag.y) > 4) {
    pdrag.moved = true;
    pill.classList.add('grabbing');
    window.usage.pillDrag('start');
  }
  if (pdrag.moved) window.usage.pillDrag('move');
});
function endPillPointer(e, allowClick) {
  if (!pdrag) return;
  const { moved } = pdrag;
  pdrag = null;
  pill.classList.remove('grabbing');
  if (moved) window.usage.pillDrag('end');
  else if (allowClick) window.usage.setCollapsed(false);
}
pill.addEventListener('pointerup', (e) => endPillPointer(e, true));
pill.addEventListener('pointercancel', (e) => endPillPointer(e, false));
pill.addEventListener('click', (e) => {
  if (e.detail === 0) window.usage.setCollapsed(false); // Enter / Space on the focused pill
});
collapseBtn.append(icon('caret'));
collapseBtn.addEventListener('click', () => window.usage.setCollapsed(true));

/* ---------- render ---------- */
function render() {
  if (!state) return;
  applyMode();
  renderPill();
  if (dragging) return;
  renderSetup();
  autosortBtn.hidden = !state.manualOrder;
  mascotBtn.setAttribute('aria-pressed', String(state.mascot !== false));
  const els = state.accounts.map(patchAccount);
  syncChildren(list, els);
  // Just the time: "Updated 05:59 PM" did not fit beside seven buttons and wrapped onto two lines.
  const at = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const waiting = state.accounts.length > 0; // with no accounts there is nothing to wait for
  updatedEl.textContent = at || (waiting ? 'Waiting…' : '');
  updatedEl.title = at ? `Updated ${at}` : waiting ? 'Waiting for first reading' : '';

  if (firstRender && state.updatedAt) {
    firstRender = false;
    list.classList.add('enter');
    [...list.querySelectorAll('.acct')].forEach((el, i) => el.style.setProperty('--row', i));
    setTimeout(() => list.classList.remove('enter'), 2500);
  }
}

/* ---------- wiring ---------- */
window.usage.getState().then((s) => {
  state = s;
  render();
});
window.usage.onState((s) => {
  state = s;
  render();
});
setInterval(render, 30_000); // keep reset countdowns and reading ages honest between polls

refreshBtn.append(icon('refresh'));
refreshBtn.addEventListener('click', () => {
  window.usage.refresh();
  refreshBtn.classList.remove('spin');
  void refreshBtn.offsetWidth;
  refreshBtn.classList.add('spin');
});
mascotBtn.append(icon('eye'));
mascotBtn.addEventListener('click', () => window.usage.setMascot(mascotBtn.getAttribute('aria-pressed') !== 'true'));
pinBtn.append(icon('pin'));
pinBtn.addEventListener('click', () => {
  const on = pinBtn.getAttribute('aria-pressed') !== 'true';
  pinBtn.setAttribute('aria-pressed', String(on));
  window.usage.setPinned(on);
});
const hideBtn = document.getElementById('hide');
const quitBtn = document.getElementById('quit');
hideBtn.append(icon('x'));
hideBtn.addEventListener('click', () => window.usage.hide());
quitBtn.append(icon('power'));
quitBtn.addEventListener('click', () => window.usage.quit());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.usage.hide();
});

new ResizeObserver(() => window.usage.reportHeight(document.getElementById('app').offsetHeight)).observe(document.getElementById('app'));
