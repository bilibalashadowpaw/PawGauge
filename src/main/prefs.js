'use strict';
// Small JSON preference store at %APPDATA%\PawGauge\prefs.json (mascot on/off, manual account order, ...).
// Never holds keys or balances.
const fs = require('fs');
const path = require('path');

function createPrefs(dir) {
  const file = path.join(dir, 'prefs.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    /* first run */
  }
  return {
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set(key, value) {
      if (value === undefined || value === null) delete data[key];
      else data[key] = value;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
      } catch {
        /* best effort */
      }
    },
  };
}

module.exports = { createPrefs };
