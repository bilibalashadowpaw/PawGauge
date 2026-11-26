'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { urgencyOf, viewLevel, trayLevel, applyOrder } = require('../src/main/poller');
const { levelOfUsed } = require('../src/shared/levels');
const { History } = require('../src/main/history');

const win = (remainingPct) => ({ status: 'ok', kind: 'windows', windows: [{ remainingPct }] });
const DAY = 86400000;

test('urgencyOf: lowest window wins; states have fixed ranks', () => {
  assert.equal(urgencyOf({ status: 'ok', kind: 'windows', windows: [{ remainingPct: 60 }, { remainingPct: 12 }] }), 12);
  assert.equal(urgencyOf({ status: 'loading' }), 99);
  assert.equal(urgencyOf({ status: 'empty' }), 95);
  assert.equal(urgencyOf({ status: 'error' }), 8);
  assert.equal(urgencyOf({ status: 'ok', kind: 'balance', balance: { available: false } }), 0);
  assert.equal(urgencyOf({ status: 'ok', kind: 'balance', balance: { available: true }, daysLeft: 2 }), 12);
  assert.equal(urgencyOf({ status: 'ok', kind: 'balance', balance: { available: true }, daysLeft: null }), 90);
});

test('levelOfUsed: orange at 90% used, red at 100% (the README rule)', () => {
  assert.deepEqual([0, 89.9, 90, 99.9, 100].map(levelOfUsed), ['ok', 'ok', 'warn', 'warn', 'crit']);
});

test('trayLevel follows the same thresholds as the meters; the worst reading wins', () => {
  assert.equal(trayLevel([win(80)]), 'ok');
  assert.equal(trayLevel([win(24)]), 'ok'); // 76% used: the meters are still green, so the tray is too
  assert.equal(trayLevel([win(10)]), 'warn');
  assert.equal(trayLevel([win(0)]), 'crit');
  assert.equal(trayLevel([win(8), win(60)]), 'warn');
  assert.equal(trayLevel([win(8), win(0)]), 'crit');
});

test('trayLevel: balances and errors', () => {
  const bal = (available, daysLeft) => ({ status: 'ok', kind: 'balance', balance: { available }, daysLeft });
  assert.equal(viewLevel(bal(true, null)), 'ok');
  assert.equal(viewLevel(bal(true, 2)), 'warn');
  assert.equal(viewLevel(bal(false, null)), 'crit');
  assert.equal(trayLevel([win(80), { status: 'error', windows: [] }]), 'ok'); // a dead key never paints the tray
});

test('applyOrder: urgency by default, manual order wins, unknown ids last', () => {
  const a = [
    { id: 'a', label: 'A', urgency: 50 },
    { id: 'b', label: 'B', urgency: 10 },
    { id: 'c', label: 'C', urgency: 30 },
  ];
  assert.deepEqual(applyOrder(a, null).map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(applyOrder(a, ['c', 'a']).map((x) => x.id), ['c', 'a', 'b']);
});

function history(points) {
  const h = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-hist-')));
  h.data = { x: points };
  return h;
}

test('History.daysLeft: needs a day of data, estimates from spend rate', () => {
  const now = 100 * DAY;
  assert.equal(history([{ t: now - 3600e3, v: 10 }, { t: now, v: 9 }]).daysLeft('x', now), null); // under a day
  assert.equal(history([{ t: now - 2 * DAY, v: 10 }, { t: now, v: 8 }]).daysLeft('x', now), 8); // 1/day, 8 left
  assert.equal(history([{ t: now - 2 * DAY, v: 10 }, { t: now, v: 10 }]).daysLeft('x', now), null); // no spend
});

test('History.daysLeft: a top-up resets the baseline', () => {
  const now = 100 * DAY;
  const h = history([{ t: now - 4 * DAY, v: 1 }, { t: now - 3 * DAY, v: 50 }, { t: now - 1 * DAY, v: 48 }, { t: now, v: 47 }]);
  assert.equal(h.daysLeft('x', now), 47 / (3 / 3)); // 3 spent over 3 days => 1/day
});
