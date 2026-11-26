'use strict';
// ShadowBlack perch: a transparent, click-through window whose bottom edge is flush with the top edge of the
// PawGauge window. It follows the main window (move, resize, show, hide) and receives a "mood" from usage state.
const path = require('path');
const { app, BrowserWindow, powerMonitor, screen } = require('electron');

const IDLE_STATES = ['awake', 'drowsy', 'asleep'];

const HEIGHT = 130;
const WIDTH = 392; // her own width, whatever the size of the window she sits on
const OFFSCREEN_SLACK = 20; // her window's top rows are empty, so a little of it may hang above the screen

function createMascot(mainWin, prefs) {
  let enabled = prefs.get('mascot', true) !== false;
  let mode = 'expanded'; // expanded | collapsing | collapsed | expanding
  let compact = false; // smaller on the collapsed pill: her click area shrinks with her

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'mascot-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Chromium counts a transparent, unfocused window as hidden and slows its timers to one tick a second,
      // which made her duck/rise timings drift. Her page is tiny, so keep it running at full speed.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, '..', 'mascot', 'index.html'));

  let lastMood = null;
  let lastMsg = { mood: 'loading', night: false, refilled: false };
  let idle = 'awake';

  // Tucked: the main window is off the screen edge and she waits alone in the bottom corner of that display's work area
  // (above the taskbar). Clicking her brings the window back.
  let dock = null; // { x, y, width, height } work area, or null
  let dockSide = 'right';
  const DOCK_W = 80; // docked window: just her side-peek sprite, flush with the screen's right edge
  const DOCK_H = 140;

  function sync() {
    if (win.isDestroyed()) return;
    if (dock && enabled) {
      win.setBounds({ x: dockSide === 'left' ? dock.x : dock.x + dock.width - DOCK_W, y: dock.y + dock.height - DOCK_H, width: DOCK_W, height: DOCK_H });
      if (!win.isVisible()) win.showInactive();
      return;
    }
    if (!enabled || !mainWin.isVisible()) {
      if (win.isVisible()) win.hide();
      return;
    }
    const b = mainWin.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    if (b.y - HEIGHT < wa.y - OFFSCREEN_SLACK) { // no room above the window: she would be off-screen
      if (win.isVisible()) win.hide();
      return;
    }
    win.setBounds({ x: Math.round(b.x + b.width / 2 - WIDTH / 2), y: b.y - HEIGHT, width: WIDTH, height: HEIGHT });
    if (!win.isVisible()) win.showInactive();
  }

  // Tells the page about expand/collapse so she can duck behind the edge while the window moves, then rise again.
  function sendMode(m) {
    mode = m;
    compact = m === 'collapsed';
    if (!win.isDestroyed()) win.webContents.send('mode', { mode });
  }

  function sendMood(level, ready) {
    const hour = new Date().getHours();
    const msg = {
      mood: process.env.UD_MOOD || (ready ? level : 'loading'), // UD_MOOD: manual override for design checks
      night: hour >= 22 || hour < 6,
      refilled: false,
    };
    // Quota recovered (warn/crit -> ok): celebrate once.
    if ((lastMood === 'warn' || lastMood === 'crit') && msg.mood === 'ok') msg.refilled = true;
    lastMood = msg.mood;
    lastMsg = msg;
    push({});
  }

  function push(extra) {
    if (!win.isDestroyed()) win.webContents.send('mood', { ...lastMsg, idle, ...extra });
  }

  // Activity: system-wide input idle time drives drowsy (90 s) and asleep (5 min); returning wakes her with a stretch.
  const idleTimer = setInterval(() => {
    if (win.isDestroyed() || !enabled) return;
    const s = powerMonitor.getSystemIdleTime();
    const forced = !app.isPackaged && IDLE_STATES.includes(process.env.UD_IDLE) ? process.env.UD_IDLE : null; // dev-only override for design checks
    const next = forced || (s >= 300 ? 'asleep' : s >= 90 ? 'drowsy' : 'awake');
    if (next === idle) return;
    const woke = idle !== 'awake' && next === 'awake';
    idle = next;
    push({ woke, refilled: false });
  }, 4000);

  // Cursor: her head follows it a little, and she only catches clicks while the cursor is over her.
  let lastDx = 0;
  let catching = false;
  const cursorTimer = setInterval(() => {
    if (win.isDestroyed() || !enabled || !win.isVisible()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    if (dock) return; // docked: her window is tiny and always clickable (see setDock)
    const cx = b.x + b.width / 2;
    const dx = Math.max(-1, Math.min(1, (c.x - cx) / 500));
    if (Math.abs(dx - lastDx) > 0.04) {
      lastDx = dx;
      win.webContents.send('look', dx);
    }
    const half = compact ? 58 : 75; // she is drawn at 78% on the pill, so her click area shrinks too
    const over = c.x > cx - half && c.x < cx + half && c.y > b.y + (compact ? 52 : 30) && c.y < b.y + b.height;
    if (over !== catching) {
      catching = over;
      win.setIgnoreMouseEvents(!over);
    }
  }, 120);
  win.on('closed', () => {
    clearInterval(idleTimer);
    clearInterval(cursorTimer);
  });

  // The page registers its listener after load, so replay the latest mood then.
  win.webContents.on('did-finish-load', () => {
    push({ refilled: false });
    if (mode === 'collapsed') win.webContents.send('mode', { mode }); // started on the pill: no expand hop on launch
  });

  for (const ev of ['show', 'hide', 'move', 'resize']) mainWin.on(ev, sync);

  return {
    window: win,
    sync,
    sendMood,
    sendMode,
    isEnabled: () => enabled,
    setEnabled(on) {
      enabled = on;
      prefs.set('mascot', on);
      sync();
    },
    setOnTop: (on) => !win.isDestroyed() && win.setAlwaysOnTop(dock ? true : on, 'floating'), // docked: never buried, she is the only handle
    setDock(workArea, side = 'right') {
      dock = workArea;
      dockSide = side;
      if (dock) win.setAlwaysOnTop(true, 'floating');
      catching = !!dock;
      win.setIgnoreMouseEvents(!dock); // docked: no hover test, she takes clicks the whole time
      if (!win.isDestroyed()) win.webContents.send('mode', { mode: dock ? 'tucked' : 'untucked', side: dockSide });
      sync();
    },
    destroy: () => !win.isDestroyed() && win.destroy(),
    HEIGHT,
  };
}

module.exports = { createMascot, MASCOT_HEIGHT: HEIGHT };
