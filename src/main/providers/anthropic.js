'use strict';
// Claude plan. There is no key-based quota API, so Claude Code's status line writes
// ~/.claude/usage-snapshot.json whenever a session reports `rate_limits` (tools/statusline-snapshot.js is a ready-made one).
// Only a live session on the Claude plan produces readings; other backends report nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProviderError, clampPct } = require('./util');

const SNAPSHOT = path.join(os.homedir(), '.claude', 'usage-snapshot.json');

async function fetchUsage() {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'windows', plan: null, windows: [], empty: true };
    throw new ProviderError('shape', 'Snapshot file unreadable');
  }
  const rl = snap && snap.rate_limits;
  const now = Date.now();
  const windows = [];
  const add = (src, id, label, order) => {
    if (!src || typeof src.used_percentage !== 'number') return;
    const resetsAt = typeof src.resets_at === 'number' ? src.resets_at * 1000 : null;
    if (resetsAt !== null && resetsAt < now) return; // Claude Code drops a window once it has reset
    windows.push({ id, label, order, remainingPct: clampPct(100 - src.used_percentage), resetsAt, detail: null });
  };
  if (rl) {
    add(rl.five_hour, '5h', '5h', 5);
    add(rl.seven_day, 'week', 'Week', 1000);
  }
  return {
    kind: 'windows',
    plan: null,
    windows,
    empty: windows.length === 0,
    readingAt: typeof snap.updatedAt === 'number' ? snap.updatedAt : null,
  };
}

module.exports = { fetchUsage };
