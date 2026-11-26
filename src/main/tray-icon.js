'use strict';
// Tray icon: the app icon (ShadowBlack peeking round a meter), with the meter coloured by the worst account state.
// The PNGs come from tools/make_icon.py; Electron picks the @<scale>x file that matches the display scaling.
const path = require('path');
const { nativeImage } = require('electron');

const LEVELS = ['ok', 'warn', 'crit'];

function trayIcon(level) {
  const name = LEVELS.includes(level) ? level : 'ok';
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray', `tray-${name}.png`));
}

module.exports = { trayIcon };
