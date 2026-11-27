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
    // Always ~/.claude, even when CLAUDE_CONFIG_DIR moves the settings: the app is not started from your shell, so a
    // fixed place is the one both sides are sure to agree on.
    const out = path.join(os.homedir(), '.claude', 'usage-snapshot.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Claude Code cancels a run that is still going when a new update arrives, which can strand a temporary file.
    for (const f of fs.readdirSync(path.dirname(out))) {
      if (!/^usage-snapshot\.json\.\d+\.tmp$/.test(f)) continue;
      const old = path.join(path.dirname(out), f);
      try {
        if (Date.now() - fs.statSync(old).mtimeMs > 60_000) fs.unlinkSync(old);
      } catch {
        /* another run got there first */
      }
    }
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), rate_limits: rl }));
    fs.renameSync(tmp, out); // atomic, so PawGauge never reads half a file
  } catch {
    /* the status line must never fail */
  }
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '--');
  process.stdout.write(`5h ${pct(rl.five_hour)} · week ${pct(rl.seven_day)}`);
});
