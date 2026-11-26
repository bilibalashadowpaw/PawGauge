#!/usr/bin/env node
'use strict';
// Claude Code status line command that feeds PawGauge's Claude row.
// Claude Code pipes a JSON document to the status line on stdin; on a Claude plan it contains `rate_limits`
// (five_hour / seven_day, each with used_percentage and resets_at). This saves that part to
// ~/.claude/usage-snapshot.json, which PawGauge reads. It prints a one-line summary as the status line itself.
// Setup: see "Claude plan usage" in the README.
const fs = require('fs');
const os = require('os');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let ctx = null;
  try {
    ctx = JSON.parse(raw);
  } catch {
    /* not JSON: print nothing */
  }
  const rl = ctx && ctx.rate_limits;
  if (!rl) return; // other backends carry no rate_limits: leave the last snapshot alone
  try {
    const out = path.join(os.homedir(), '.claude', 'usage-snapshot.json');
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), rate_limits: rl }));
    fs.renameSync(tmp, out); // atomic, so PawGauge never reads half a file
  } catch {
    /* the status line must never fail */
  }
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '--');
  process.stdout.write(`5h ${pct(rl.five_hour)} · week ${pct(rl.seven_day)}`);
});
