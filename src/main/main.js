'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeTheme, shell, session, systemPreferences, dialog } = require('electron');
const { scanAccounts, planAdd } = require('./accounts');
const userAccounts = require('./user-accounts');
const statusline = require('./statusline');
const { Poller } = require('./poller');
const { providers } = require('./providers');
const { History } = require('./history');
const { demoState } = require('./demo');
const { createPrefs } = require('./prefs');
const { applyOrder } = require('./poller');
const { trayIcon } = require('./tray-icon');
const { createMascot, MASCOT_HEIGHT } = require('./mascot');

const argv = process.argv.slice(1);
const DEMO = argv.includes('--demo');
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx >= 0 ? argv[shotIdx + 1] : null; // --shot <png path>: render demo state, save PNG, quit
const SHOT_LIGHT = argv.includes('--light');
const LIVE = argv.includes('--live'); // with --shot: use real accounts instead of demo data
const USE_DEMO = DEMO || (SHOT && !LIVE);
const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
const HIDDEN = argv.includes('--hidden'); // set on the login-item launch: start in the tray without popping the window

// The uninstaller runs `PawGauge.exe --remove-statusline`: take our own status line out of Claude Code's settings, if it
// is there, and exit without opening anything. Anything else in that file, or a status line of your own, is left alone.
if (argv.includes('--remove-statusline')) {
  try {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
    statusline.apply(statusline.plan(claudeDir, path.join(app.getPath('appData'), 'PawGauge', statusline.SCRIPT_NAME), 'remove'));
  } catch {
    /* nothing of ours to remove, or a file that must not be touched */
  }
  app.exit(0);
  return;
}

// Start at login is OFF by default (the installer puts a desktop shortcut instead); the tray menu toggles it.
// Unpackaged (npm start), the login item must run electron.exe with the project path as its first argument.
const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });
const autostartOn = () => app.getLoginItemSettings(loginItem()).openAtLogin;
const setAutostart = (on) => app.setLoginItemSettings({ openAtLogin: on, ...loginItem() });

const WIDTH = 392;
const MARGIN = 12;
const PILL_W = 212; // collapsed: a small pill showing the most urgent account
const PILL_H = 40;
const FADE_MS = 110; // the panel fades out this long before the window shrinks
const TWEEN_MS = 240; // window grow/shrink
const SNAP = 14; // px from a screen edge where a dropped window snaps flush
const AUTO_COLLAPSE_MS = 30_000;
const SETUP_GUIDE_URL = 'https://github.com/bilibalashadowpaw/PawGauge#accounts-and-settings';

let win = null;
let tray = null;
let menu = null;
let poller = null;
let mascot = null;
let prefs = null;
let pinned = true; // always on top by default, so clicking another window never hides it; the pin button toggles
let lastLevel = null;
let lastHeight = 420;
let collapsed = false;
let animating = false; // a grow/shrink is in flight: ignore clicks and content-height reports
let pillDrag = null; // { cx, cy, x, y }: cursor and window position when a pill drag started
let anchor = { ax: 'right', ay: 'bottom' }; // the screen corner the window grows from / shrinks to
let autoCollapse = false;
let pendingExpand = false; // "Show" arrived while a collapse was still animating
let userDir = null;
let scan = null; // the latest account scan: { accounts, report }; null with demo data
let setupAsked = false; // "Accounts" was chosen from the tray menu
let choosing = false; // a file picker or question is open

// The pages only ever load our own bundled files and never navigate. Refuse anything else a page might try: new windows,
// any navigation or redirect, and permission prompts (camera, notifications, ...).
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
});

// A second launch hands over to the first and quits; app.quit() does not stop whenReady, so startup below checks this too.
const gotLock = SHOT || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => showWindow(true));

/* ---------- placement: one place decides where the window may be ---------- */
const workAreaOf = (b) => screen.getDisplayMatching(b).workArea;
// ShadowBlack sits above the window, so keep that much room above it while she is on.
const topReserve = () => (mascot && mascot.isEnabled() ? MASCOT_HEIGHT - 12 : 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function fitToScreen(b) {
  const wa = workAreaOf(b);
  return {
    ...b,
    x: clamp(b.x, wa.x, wa.x + wa.width - b.width),
    y: clamp(b.y, wa.y + topReserve(), wa.y + wa.height - b.height),
  };
}

// Grow away from the nearest screen edges: the quadrant the window sits in picks the corner that stays put.
function anchorOf(b) {
  const wa = workAreaOf(b);
  return {
    ax: b.x + b.width / 2 > wa.x + wa.width / 2 ? 'right' : 'left',
    ay: b.y + b.height / 2 > wa.y + wa.height / 2 ? 'bottom' : 'top',
  };
}

function anchoredBounds(from, w, h) {
  return fitToScreen({
    x: anchor.ax === 'right' ? from.x + from.width - w : from.x,
    y: anchor.ay === 'bottom' ? from.y + from.height - h : from.y,
    width: w,
    height: h,
  });
}

function panelHeight() {
  const wa = workAreaOf(win.getBounds());
  const maxH = wa.height - 2 * MARGIN - (mascot && mascot.isEnabled() ? MASCOT_HEIGHT : 0);
  return Math.min(maxH, Math.max(200, Math.ceil(lastContentH || lastHeight)));
}

function initialBounds() {
  const w = collapsed ? PILL_W : WIDTH;
  const h = collapsed ? PILL_H : lastHeight;
  const saved = SHOT ? null : prefs.get('pos', null);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return fitToScreen({ x: saved.x, y: saved.y, width: w, height: h });
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - w - MARGIN, y: wa.y + wa.height - h - MARGIN, width: w, height: h };
}

// After a drag, a display change or startup: keep it on screen, snap flush to a nearby edge, remember where it is.
function settle(keepAnchor = false) {
  if (!win || win.isDestroyed() || animating || pillDrag) return;
  const b = win.getBounds();
  const wa = workAreaOf(b);
  const top = wa.y + topReserve() + MARGIN;
  const near = (v, edge) => Math.abs(v - edge) < SNAP;
  let { x, y } = b;
  if (near(x, wa.x + MARGIN)) x = wa.x + MARGIN;
  else if (near(x + b.width, wa.x + wa.width - MARGIN)) x = wa.x + wa.width - MARGIN - b.width;
  if (near(y, top)) y = top;
  else if (near(y + b.height, wa.y + wa.height - MARGIN)) y = wa.y + wa.height - MARGIN - b.height;
  const next = fitToScreen({ x, y, width: b.width, height: b.height });
  if (next.x !== b.x || next.y !== b.y) win.setBounds(next);
  if (!keepAnchor) anchor = anchorOf(next);
  if (!SHOT && prefs) prefs.set('pos', { x: next.x, y: next.y });
}

function tweenTo(to, ms, done) {
  const from = win.getBounds();
  if (!ms) {
    win.setBounds(to);
    done();
    return;
  }
  const t0 = Date.now();
  const step = () => {
    if (!win || win.isDestroyed()) return;
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    const c = (a, b) => Math.round(a + (b - a) * e);
    win.setBounds({ x: c(from.x, to.x), y: c(from.y, to.y), width: c(from.width, to.width), height: c(from.height, to.height) });
    if (k < 1) setTimeout(step, 8);
    else done();
  };
  step();
}

// Windows "Animation effects" off (or reduced motion): jump instead of tween.
function animMs(ms) {
  try {
    return systemPreferences.getAnimationSettings().shouldRenderRichAnimation ? ms : 0;
  } catch {
    return ms;
  }
}

function setCollapsed(on) {
  if (!win || animating || on === collapsed) return;
  pillDrag = null; // a drag in progress is over once the window changes shape
  const from = win.getBounds();
  if (!on) anchor = anchorOf(from); // expanding: grow away from whichever corner the pill is nearest
  if (!on) lastHeight = panelHeight();
  const target = on ? anchoredBounds(from, PILL_W, PILL_H) : anchoredBounds(from, WIDTH, lastHeight);
  collapsed = on;
  animating = true;
  if (!SHOT) prefs.set('collapsed', on);
  pushState(); // the page flips at once: panel fades out / pill fades in
  if (mascot) mascot.sendMode(on ? 'collapsing' : 'expanding');
  const run = () =>
    tweenTo(target, animMs(TWEEN_MS), () => {
      animating = false;
      settle(true);
      resizeToContent(); // a height report that arrived mid-tween was ignored: apply it now
      pushState();
      if (mascot) mascot.sendMode(on ? 'collapsed' : 'expanded');
      if (pendingExpand) {
        pendingExpand = false;
        if (collapsed) setCollapsed(false);
      }
    });
  if (on) setTimeout(run, animMs(FADE_MS));
  else run();
}

// Optional (tray checkbox): fold into the pill once the cursor has stayed off the panel (and ShadowBlack) for a while.
let lastHover = Date.now();
let autoTimer = null;
function setAutoCollapse(on) {
  autoCollapse = on;
  lastHover = Date.now();
  if (on && !autoTimer) autoTimer = setInterval(autoCollapseTick, 1000);
  else if (!on && autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}
function autoCollapseTick() {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const above = mascot && mascot.isEnabled() ? MASCOT_HEIGHT : 0; // her strip counts as "on the window" only while she is there
  const over = c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y - above && c.y <= b.y + b.height;
  if (over || !autoCollapse || collapsed || animating || !win.isVisible()) lastHover = Date.now();
  else if (Date.now() - lastHover >= AUTO_COLLAPSE_MS) setCollapsed(true);
}

function createWindow() {
  const b0 = initialBounds();
  anchor = anchorOf(b0);
  win = new BrowserWindow({
    ...b0,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Acrylic on Windows, the macOS vibrancy material on Mac (the page background is translucent in both).
    ...(IS_MAC ? { vibrancy: SHOT ? undefined : 'under-window', visualEffectState: 'active' } : { backgroundMaterial: SHOT ? 'none' : 'acrylic' }),
    backgroundColor: SHOT ? '#0E1418' : '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!app.isQuitting && !SHOT) {
      e.preventDefault();
      win.hide();
    }
  });
}

/* ---------- tuck to the screen edge: the window slides off the right edge, ShadowBlack stays in the corner ---------- */
let tucked = false;
let tuckSide = 'right'; // which screen edge it is tucked to
let preTuck = null; // where the window was, so it slides back to the same place

function hideMode() {
  return prefs && prefs.get('hideMode', 'tray') === 'edge' ? 'edge' : 'tray';
}

function sideOf(b) { // nearest side edge of the window's own display
  const wa = workAreaOf(b);
  return b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right';
}
const offX = (wa, w, side) => (side === 'left' ? wa.x - w : wa.x + wa.width);

function tuck(side) {
  if (!win || tucked || animating || !win.isVisible() || !mascot || !mascot.isEnabled()) return false; // without her there is no handle to bring it back
  pillDrag = null;
  const wa0 = workAreaOf(win.getBounds());
  tuckSide = side || sideOf(win.getBounds());
  preTuck = fitToScreen(win.getBounds()); // a drag may have pushed it partly past the edge: remember an on-screen place
  const wa = wa0;
  tucked = true;
  animating = true;
  edgePreview = false;
  mascot.setDock(wa, tuckSide);
  tweenTo({ ...preTuck, x: offX(wa, preTuck.width, tuckSide) }, animMs(TWEEN_MS), () => {
    win.hide();
    win.setOpacity(1);
    win.setBounds(preTuck); // parked in its old place, hidden, so Show lands where it was
    animating = false;
    if (pendingUntuck) { // she was clicked while the window was still sliding away: bring it straight back
      const expand = pendingUntuck.expand;
      pendingUntuck = null;
      untuck(expand);
    }
  });
  return true;
}

let pendingUntuck = null; // { expand } a click arrived while the tuck was still animating
function untuck(expand = false) {
  if (!tucked) return;
  if (animating) { // mid-tuck: let it land first, or the half-finished tuck would hide the window again
    pendingUntuck = { expand: expand || (pendingUntuck && pendingUntuck.expand) };
    return;
  }
  tucked = false;
  win.setOpacity(1);
  const wa = workAreaOf(preTuck);
  const target = preTuck;
  animating = true;
  win.setBounds({ ...target, x: offX(wa, target.width, tuckSide) });
  win.show();
  win.setAlwaysOnTop(true, 'floating');
  win.focus();
  if (!pinned) win.setAlwaysOnTop(false);
  mascot.setDock(null);
  mascot.setOnTop(pinned);
  tweenTo(target, animMs(TWEEN_MS), () => {
    animating = false;
    settle(true);
    if (expand && collapsed) setCollapsed(false);
  });
}

// While a drag is under way and the cursor reaches the right screen edge, show what a drop will do: ShadowBlack appears in
// the corner and the window dims. Moving back off the edge undoes it. (Hovering alone never triggers it: the window keeps a
// margin from the edge, so the cursor can only be both inside the window and on the edge while the window is being dragged.)
// 'left' / 'right' when the cursor is on a screen edge that has no other display beyond it (the seam between two monitors is not an edge).
function edgeAt(c, wa) {
  const beyond = (x) => screen.getAllDisplays().some((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && c.y >= d.bounds.y && c.y < d.bounds.y + d.bounds.height);
  if (c.x >= wa.x + wa.width - 3 && !beyond(wa.x + wa.width + 4)) return 'right';
  if (c.x <= wa.x + 2 && !beyond(wa.x - 4)) return 'left';
  return null;
}
let edgePreview = false;
let previewSide = 'right';
function cancelEdgePreview() {
  if (!edgePreview) return;
  edgePreview = false;
  if (win && !win.isDestroyed()) win.setOpacity(1);
  if (mascot && !tucked) {
    mascot.setDock(null);
    mascot.setOnTop(pinned);
  }
}
function edgePreviewTick() {
  if (!win || win.isDestroyed() || tucked || animating || !mascot || !mascot.isEnabled() || !win.isVisible()) {
    cancelEdgePreview(); // hidden, tucking, or ShadowBlack switched off: never leave the dim and the docked sprite behind
    return;
  }
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const wa = screen.getDisplayNearestPoint(c).workArea;
  const edge = edgeAt(c, wa);
  const on = !!edge && c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
  if (!on) return cancelEdgePreview();
  if (edgePreview && previewSide === edge) return;
  edgePreview = true;
  previewSide = edge;
  win.setOpacity(0.4);
  mascot.setDock(wa, edge);
}

// The preview only matters while a drag is under way, so its 60 ms timer runs only then: it starts on the first 'will-move'
// (dragging the header) or when a pill drag starts, and stops on the drop. If no drop event ever arrives it stops itself
// once the window has not moved for a moment. The drop itself (droppedOnRightEdge) never depends on this timer.
const EDGE_WATCH_IDLE_MS = 1500;
let edgeTimer = null;
let dragSeenAt = 0;
function startEdgeWatch() {
  dragSeenAt = Date.now();
  if (!edgeTimer) edgeTimer = setInterval(edgeWatchTick, 60);
}
function stopEdgeWatch() {
  clearInterval(edgeTimer);
  edgeTimer = null;
}
function edgeWatchTick() {
  edgePreviewTick();
  if (!pillDrag && Date.now() - dragSeenAt > EDGE_WATCH_IDLE_MS) stopEdgeWatch();
}

// Drag and drop: letting go with the cursor on the left or right edge of the screen tucks the window away.
function droppedOnRightEdge() {
  if (!win || win.isDestroyed() || tucked || animating || !mascot || !mascot.isEnabled()) return false;
  const c = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(c).workArea;
  const edge = edgeAt(c, wa);
  const ok = !!edge && tuck(edge);
  if (!ok) cancelEdgePreview();
  return ok;
}

// "Hide" (the X button, Esc): to the tray, or tucked to the screen edge, as the tray menu chose.
function hideAction() {
  if (!win) return;
  if (hideMode() === 'edge' && tuck()) return;
  cancelEdgePreview();
  win.hide();
}

let shownAt = 0;
function showWindow(expand = false) {
  if (!win) return;
  if (tucked) {
    untuck(expand);
    return;
  }
  if (expand && collapsed) {
    if (animating) pendingExpand = true; // mid-collapse: expand as soon as it lands
    else setCollapsed(false);
  }
  settle(true); // a monitor may have gone away while it was hidden
  shownAt = Date.now();
  win.show();
  // Windows can refuse foreground to a freshly launched app; a brief always-on-top toggle brings it to the front.
  win.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) app.focus({ steal: true }); // a menu-bar-only app is not frontmost by default
  win.focus();
  if (!pinned) win.setAlwaysOnTop(false);
  if (mascot) mascot.setOnTop(pinned);
}

function toggleWindow() {
  if (tucked) untuck();
  else if (win.isVisible()) win.hide();
  else showWindow();
}

/* ---------- accounts: scanned at startup, on Refresh and from the Accounts screen ---------- */
const hasKeyAccount = () => scan.accounts.some((a) => a.provider !== 'anthropic');

function refresh() {
  if (!poller) return;
  scan = scanAccounts(userDir);
  poller.refreshAll(poller.setAccounts(scan.accounts));
  pushState();
}

// A settings file now points elsewhere: if that is another supported service, its row takes over without a Refresh.
function followMove(account) {
  const next = scanAccounts(userDir);
  if (!poller.followMove(account, next.accounts)) return;
  scan = { ...next, accounts: poller.accounts };
  pushState();
}

// The Accounts screen opens by itself on the first run, and while no account with a key is found, until it is closed;
// the tray menu reopens it.
function setupState() {
  if (!scan) return null;
  const firstRun = !SHOT && prefs.get('setupSeen', false) !== true;
  const dismissed = !SHOT && prefs.get('setupDismissed', false) === true;
  return setupAsked || firstRun || (!hasKeyAccount() && !dismissed) ? { ...scan.report, claude: claudeUsage() } : null;
}

/* ---------- Claude usage: the one change PawGauge can make to a Claude Code file, always asked first ---------- */
const statusScript = () => path.join(userDir, statusline.SCRIPT_NAME);
const scriptSource = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'statusline-snapshot.ps1') : path.join(__dirname, '..', '..', 'tools', 'statusline-snapshot.ps1');
const SNAPSHOT_RECENT_MS = 7 * 24 * 3600 * 1000;

// What the Accounts screen shows. States and yes/no answers only: nothing read from settings.json reaches the page.
function claudeUsage() {
  let hasReading = false;
  try {
    hasReading = Date.now() - fs.statSync(path.join(require('os').homedir(), '.claude', 'usage-snapshot.json')).mtimeMs < SNAPSHOT_RECENT_MS;
  } catch {
    /* no reading yet */
  }
  return { ...statusline.inspect(scan.claudeDir, statusScript()), hasReading, supported: IS_WINDOWS };
}

// A system dialog shows the exact change, with Cancel as the default.
async function changeStatusLine(action) {
  if (!IS_WINDOWS) return;
  applyAccounts();
  const change = statusline.plan(scan.claudeDir, statusScript(), action);
  const setup = action === 'setup';
  const detail = setup
    ? [
        'PawGauge will add this entry to settings.json in Claude Code\'s folder. Nothing else in the file changes.',
        `"statusLine": ${JSON.stringify(change.entry, null, 2)}`,
        'Claude Code then runs this small PowerShell script after it replies. It saves your plan usage on this computer and shows it in the status line. You can remove it here at any time, and uninstalling PawGauge removes it too.',
        ...(statusline.inspect(scan.claudeDir, statusScript()).hooksDisabled
          ? ['Note: "disableAllHooks" is on in settings.json, so Claude Code will not run it until you turn that off.']
          : []),
      ]
    : ['PawGauge will remove its "statusLine" entry from settings.json in Claude Code\'s folder. Nothing else in the file changes. The Claude row then stops getting new readings.'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'PawGauge',
    message: setup ? 'Set up Claude usage?' : 'Remove Claude usage setup?',
    detail: detail.join('\n\n'),
    buttons: ['Cancel', setup ? 'Add status line' : 'Remove it'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return;
  if (setup) statusline.installScript(scriptSource(), statusScript()); // the script is in place before anything points at it
  statusline.apply(change);
  applyAccounts();
}

/* ---------- Accounts screen: show, hide, rename, add. Only PawGauge's own accounts.json is ever written ---------- */
const say = (message, detail) => dialog.showMessageBox(win, { type: 'info', title: 'PawGauge', message, detail, buttons: ['OK'], noLink: true });

// Rescan without polling every account again: only new or newly shown ones start.
function applyAccounts() {
  scan = scanAccounts(userDir);
  poller.setAccounts(scan.accounts);
  scan.accounts = poller.accounts;
  pushState();
}

function saveAccounts(change) {
  try {
    change();
  } catch (e) {
    say('Your change was not saved', e && e.message);
  }
  applyAccounts();
}

const listedAccount = (id) => scan && scan.report.accounts.find((a) => a.id === id);

// A settings file with a key but no address is normally a Claude (Anthropic) key, so the page cannot assign it: the
// choice is made in a system dialog that names the file and where its key will be sent, and Cancel is the default.
async function addSettingsFile(name) {
  applyAccounts(); // decide from the files as they are now
  const plan = planAdd(scan.claudeDir, scan.report, name);
  if (plan.error) {
    await say('That file was not added', plan.error);
    return;
  }
  let { account } = plan;
  if (plan.choose) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'PawGauge',
      message: `Whose key is in ${name}?`,
      detail: [
        'This file has no API address. Claude Code uses a key like that with Anthropic, so it may be your Anthropic key.',
        'Choose a service only if you know the key came from it. PawGauge will send the key to that service:',
        plan.choose.map((p) => `${providers[p].name} receives it at ${providers[p].domains.join(', ')}`).join('\n'),
      ].join('\n\n'),
      buttons: ['Cancel', ...plan.choose.map((p) => `Send to ${providers[p].name}`)],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (!(response > 0 && response <= plan.choose.length)) return;
    account = { id: account.id, provider: plan.choose[response - 1], settings: name };
  }
  saveAccounts(() => userAccounts.addAccount(userDir, account));
}

async function pickSettingsFile() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose a settings file in Claude Code's folder",
    defaultPath: scan.claudeDir,
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'Settings files', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return;
  if (path.relative(scan.claudeDir, path.dirname(filePaths[0])) !== '') {
    await say('That file was not added', "Choose a file that is directly inside Claude Code's folder.");
    return;
  }
  await addSettingsFile(path.basename(filePaths[0]));
}

// One dialog at a time, and only for the panel's own page.
async function whileChoosing(e, task) {
  if (!scan || choosing || !win || e.sender !== win.webContents) return;
  choosing = true;
  try {
    await task();
  } catch (err) {
    await say('That did not work', err && err.message);
  } finally {
    choosing = false;
  }
}

function openSetup() {
  setupAsked = true;
  showWindow(true);
  refresh();
}

function currentState() {
  const order = prefs && !SHOT ? prefs.get('order', null) : null; // screenshots never use the owner's settings
  const mascotOn = prefs && !SHOT ? prefs.get('mascot', true) !== false : true;
  const mode = { collapsed, ax: anchor.ax, ay: anchor.ay };
  if (USE_DEMO) {
    const s = demoState();
    return { ...s, accounts: applyOrder(s.accounts, order), manualOrder: !!(order && order.length), mascot: mascotOn, ...mode };
  }
  poller.order = order;
  return { ...poller.snapshot(), setup: setupState(), mascot: mascotOn, ...mode };
}

// One switch for ShadowBlack, shared by the tray menu and the header button; both stay in step.
function setMascot(on) {
  if (!mascot) return;
  if (!on) cancelEdgePreview(); // no dimmed window or docked sprite left behind
  if (!on && tucked) untuck(); // she is the handle for a tucked window: bring it back before she goes
  mascot.setEnabled(on);
  settle(true); // she needs room above the window: move it down if it was parked at the top while she was off
  mascot.sync();
  if (menu) menu.getMenuItemById('mascot').checked = on;
  resizeToContent();
  pushState();
}

function pushState() {
  const s = currentState();
  if (win && !win.isDestroyed()) win.webContents.send('state', s);
  if (mascot) mascot.sendMood(s.level, s.updatedAt > 0);
  if (tray) {
    if (s.level !== lastLevel) {
      tray.setImage(trayIcon(s.level));
      lastLevel = s.level;
    }
    const worst = s.accounts.find((a) => a.status === 'ok' || a.status === 'error');
    const errors = s.accounts.filter((a) => a.status === 'error').length;
    tray.setToolTip(`PawGauge${worst ? ` • lowest: ${worst.label}` : ''}${errors ? ` • ${errors} need attention` : ''}`);
  }
}

function createTray() {
  tray = new Tray(trayIcon('ok'));
  tray.setToolTip('PawGauge');
  tray.on('click', toggleWindow);
  menu = Menu.buildFromTemplate([
    { label: `PawGauge v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => showWindow(true) },
    { label: 'Tuck to screen edge', click: () => tuck() },
    {
      label: 'Hide button goes to screen edge',
      type: 'checkbox',
      checked: hideMode() === 'edge',
      click: (item) => prefs.set('hideMode', item.checked ? 'edge' : 'tray'),
    },
    { label: 'Refresh now', click: refresh },
    { label: 'Accounts…', enabled: !USE_DEMO, click: openSetup },
    { type: 'separator' },
    { id: 'mascot', label: 'ShadowBlack', type: 'checkbox', checked: mascot ? mascot.isEnabled() : true, click: (item) => setMascot(item.checked) },
    {
      label: 'Collapse when idle',
      type: 'checkbox',
      checked: autoCollapse,
      click: (item) => {
        setAutoCollapse(item.checked);
        prefs.set('autoCollapse', autoCollapse || null);
      },
    },
    { label: 'Start at login', type: 'checkbox', checked: autostartOn(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    {
      label: 'Quit PawGauge',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  // On macOS a tray with a context menu swallows the left click, so the menu opens on right/ctrl-click instead.
  if (IS_MAC) tray.on('right-click', () => tray.popUpContextMenu(menu));
  else tray.setContextMenu(menu);
}

ipcMain.handle('get-state', () => currentState());
ipcMain.on('set-order', (_e, ids) => {
  prefs.set('order', Array.isArray(ids) && ids.length ? ids.filter((x) => typeof x === 'string') : null);
  pushState();
});
ipcMain.on('set-mascot', (_e, v) => setMascot(!!v));
// The renderer only names a provider; the URL comes from our own table and must be https.
ipcMain.on('open-provider', (_e, id) => {
  const url = typeof id === 'string' && providers[id] && providers[id].url;
  if (url && url.startsWith('https://')) shell.openExternal(url);
});
ipcMain.on('refresh', refresh);
ipcMain.on('close-setup', () => {
  if (!scan) return;
  setupAsked = false;
  prefs.set('setupSeen', true);
  if (!hasKeyAccount()) prefs.set('setupDismissed', true); // someone with only a Claude plan is not asked again
  pushState();
});
// The page names an account or a listed file; both are checked against the latest scan before anything is written.
ipcMain.on('account-change', (e, id, change) => {
  if (!win || e.sender !== win.webContents || !listedAccount(id) || !change) return;
  const next = {};
  if (typeof change.hidden === 'boolean') next.hidden = change.hidden;
  if (typeof change.label === 'string') next.label = userAccounts.cleanLabel(change.label);
  if (Object.keys(next).length) saveAccounts(() => userAccounts.setOverride(userDir, id, next));
});
ipcMain.on('account-remove', (e, id) => {
  const a = listedAccount(id);
  if (!win || e.sender !== win.webContents || !a || !a.removable) return;
  saveAccounts(() => userAccounts.removeAccount(userDir, id));
});
ipcMain.on('account-assign', (e, file) => {
  whileChoosing(e, async () => {
    if (scan.report.files.some((r) => r.canAssign && r.file === file)) await addSettingsFile(file);
  });
});
ipcMain.on('account-pick', (e) => whileChoosing(e, pickSettingsFile));
ipcMain.on('claude-setup', (e) => whileChoosing(e, () => changeStatusLine('setup')));
ipcMain.on('claude-remove', (e) => whileChoosing(e, () => changeStatusLine('remove')));
ipcMain.on('open-setup-guide', () => shell.openExternal(SETUP_GUIDE_URL));
ipcMain.on('quit', () => {
  app.isQuitting = true;
  app.quit();
});
ipcMain.on('hide', () => hideAction());
// ShadowBlack was clicked: bring the whole window to the front (or slide it back out if it is tucked away).
ipcMain.on('mascot-click', (e) => {
  if (!mascot || mascot.window.isDestroyed() || e.sender !== mascot.window.webContents) return;
  showWindow(true); // clicking her always opens the full window (from the pill or the screen edge) and brings it to the front
  mascot.window.moveTop();
});
ipcMain.on('set-collapsed', (_e, v) => setCollapsed(!!v));
// The pill cannot use an OS drag region (that would swallow its click), so the page reports pointer phases
// and the window follows the cursor from here.
ipcMain.on('pill-drag', (_e, phase) => {
  if (!win) return;
  if (phase === 'end' && pillDrag) { // always honoured, even if the window started expanding mid-drag
    pillDrag = null;
    stopEdgeWatch();
    if (!droppedOnRightEdge()) settle();
    return;
  }
  if (!collapsed || animating) return;
  if (phase === 'start') {
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    pillDrag = { cx: c.x, cy: c.y, x: b.x, y: b.y };
    startEdgeWatch();
  } else if (phase === 'move' && pillDrag) {
    const c = screen.getCursorScreenPoint();
    win.setBounds({ x: pillDrag.x + c.x - pillDrag.cx, y: pillDrag.y + c.y - pillDrag.cy, width: PILL_W, height: PILL_H });
  }
});
ipcMain.on('set-pinned', (_e, v) => {
  pinned = !!v;
  if (win) win.setAlwaysOnTop(pinned, 'floating');
  if (mascot) mascot.setOnTop(pinned);
});
let lastContentH = 0;
function resizeToContent() {
  if (lastContentH) ipcMain.emit('content-height', null, lastContentH);
}
ipcMain.on('content-height', (_e, h) => {
  if (!win || !Number.isFinite(h)) return;
  lastContentH = h;
  if (collapsed || animating) return; // the pill has its own size; the panel is sized again when it expands
  const next = panelHeight();
  if (next === lastHeight) return;
  lastHeight = next;
  win.setBounds(anchoredBounds(win.getBounds(), WIDTH, next)); // grows away from the anchored corner
  settle(true); // and the new top-left is what gets remembered
});

app.whenReady().then(() => {
  if (!gotLock) return; // the running copy keeps the tray, window and mascot
  if (IS_MAC && app.dock) app.dock.hide(); // tray-only app: no Dock icon
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  userDir = path.join(app.getPath('appData'), 'PawGauge');
  // The app was called UsageDesk before 0.4.7: copy its settings over once. (Electron has already created this folder for
  // its own caches by now, so test for each file, never for the folder.)
  const oldDir = path.join(app.getPath('appData'), 'UsageDesk');
  try {
    fs.mkdirSync(userDir, { recursive: true });
    for (const f of ['prefs.json', 'history.json', 'accounts.json']) {
      const from = path.join(oldDir, f);
      const to = path.join(userDir, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch (e) {
    console.error('could not migrate settings from the old UsageDesk folder:', e && e.message);
  }
  if (SHOT_LIGHT) nativeTheme.themeSource = 'light';

  prefs = createPrefs(userDir);
  collapsed = !SHOT && prefs.get('collapsed', false) === true;
  setAutoCollapse(!SHOT && prefs.get('autoCollapse', false) === true);
  createWindow();
  if (!SHOT) {
    mascot = createMascot(win, prefs);
    if (collapsed) mascot.sendMode('collapsed');
    win.on('will-move', () => { if (!animating) startEdgeWatch(); }); // fires continually while the header is dragged
    win.on('moved', () => { // fires when a drag by the header ends
      stopEdgeWatch();
      if (!droppedOnRightEdge()) settle();
    });
    screen.on('display-removed', () => { settle(); mascot.sync(); });
    screen.on('display-metrics-changed', () => { settle(); mascot.sync(); });
    settle(); // now that the room ShadowBlack needs above the window is known
  }
  createTray();

  if (!USE_DEMO) {
    scan = scanAccounts(userDir);
    if (!SHOT) statusline.sweep(scan.claudeDir);
    // If our status line is set up, keep its script current (an update may have changed it) and put it back if it is gone.
    if (IS_WINDOWS && !SHOT && statusline.inspect(scan.claudeDir, statusScript()).state === 'ours') {
      try {
        statusline.installScript(scriptSource(), statusScript());
      } catch (e) {
        console.error('could not update the status line script:', e && e.message);
      }
    }
    poller = new Poller(scan.accounts, new History(userDir));
    poller.on('change', pushState);
    poller.on('moved', (account) => setImmediate(() => followMove(account)));
    poller.start();
  }

  win.webContents.on('did-finish-load', () => {
    pushState();
    if (SHOT) {
      setTimeout(async () => {
        try {
          // No clock in screenshots: set beside a commit time, the local time would give away the time zone.
          await win.webContents.executeJavaScript('document.getElementById("updated").style.visibility = "hidden"');
          // Size the window to the content first so the PNG is never cropped.
          const h = await win.webContents.executeJavaScript('document.getElementById("app").offsetHeight');
          win.setContentSize(WIDTH, Math.min(h, screen.getPrimaryDisplay().workArea.height));
          await new Promise((r) => setTimeout(r, 500));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT, img.toPNG());
        } catch (e) {
          console.error('shot failed:', e && e.message);
        }
        app.isQuitting = true;
        app.quit();
      }, LIVE ? 9000 : 2200);
    } else if (!HIDDEN) {
      showWindow();
    }
  });
  if (SHOT) win.showInactive();
});

app.on('window-all-closed', () => {
  /* stay alive in the tray */
});
