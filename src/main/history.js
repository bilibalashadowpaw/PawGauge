'use strict';
// Balance history for pay-as-you-go accounts, so we can estimate "days left at current spend".
// Stored in %APPDATA%\PawGauge\history.json. Only balances and timestamps, never keys.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 30 * 24 * 3600 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;
const MIN_SPAN_MS = 24 * 3600 * 1000; // need a day of data before estimating

class History {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  record(id, total, now = Date.now()) {
    const arr = (this.data[id] = (this.data[id] || []).filter((p) => now - p.t < KEEP_MS));
    const last = arr[arr.length - 1];
    if (last && now - last.t < MIN_GAP_MS && last.v === total) return;
    if (last && now - last.t < MIN_GAP_MS && total <= last.v) {
      last.t = now;
      last.v = total;
    } else {
      arr.push({ t: now, v: total });
    }
    this.save();
  }

  /** Days of balance left at the spend rate since the last top-up, or null if there isn't enough data. */
  daysLeft(id, now = Date.now()) {
    const arr = this.data[id] || [];
    let start = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i].v > arr[i - 1].v + 0.005) start = i; // top-up resets the baseline
    const seg = arr.slice(start);
    if (seg.length < 2) return null;
    const first = seg[0];
    const last = seg[seg.length - 1];
    const span = last.t - first.t;
    const spent = first.v - last.v;
    if (span < MIN_SPAN_MS || spent <= 0.005) return null;
    const perDay = spent / (span / 86400000);
    return last.v / perDay;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      /* history is best effort */
    }
  }
}

module.exports = { History };
