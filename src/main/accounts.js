'use strict';
// Accounts are data. Auto-discovered from ~/.claude/settings.*.json (base URL host picks the provider),
// plus an optional %APPDATA%\PawGauge\accounts.json:
//   {
//     "overrides": { "zai-1": { "label": "z.ai main", "hidden": false } },
//     "accounts":  [ { "id": "work-ds", "provider": "deepseek", "label": "DeepSeek work", "env": "DEEPSEEK_WORK_KEY" },
//                    { "id": "zai-3", "provider": "zai", "settings": "settings.zai-3.json" } ]
//   }
// Keys are read at fetch time (never cached, never written anywhere) so a fixed key is picked up on the next poll.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { providers, providerForHost } = require('./providers');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function discover() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(CLAUDE_DIR).filter((f) => /^settings\..+\.json$/.test(f) && !/\.bak/.test(f));
  } catch {
    /* no ~/.claude */
  }
  for (const f of files.sort()) {
    const cfg = readJson(path.join(CLAUDE_DIR, f));
    const base = cfg && cfg.env && cfg.env.ANTHROPIC_BASE_URL;
    if (!base) continue;
    let host;
    try {
      host = new URL(base).hostname;
    } catch {
      continue;
    }
    const provider = providerForHost(host);
    if (!provider) continue;
    const hasKey = !!(cfg.env.ANTHROPIC_AUTH_TOKEN || cfg.env.ANTHROPIC_API_KEY);
    if (!hasKey) continue;
    out.push({ id: f.replace(/^settings\./, '').replace(/\.json$/, ''), provider, settings: f });
  }
  return out;
}

function keyFor(account) {
  if (account.env) return process.env[account.env] || null;
  if (account.settings) {
    const cfg = readJson(path.join(CLAUDE_DIR, account.settings));
    const e = (cfg && cfg.env) || {};
    return e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY || null;
  }
  return null;
}

function loadAccounts(userDir) {
  const user = (userDir && readJson(path.join(userDir, 'accounts.json'))) || {};
  const overrides = user.overrides || {};
  const list = [{ id: 'claude', provider: 'anthropic' }, ...discover(), ...(Array.isArray(user.accounts) ? user.accounts : [])];

  const seen = new Set();
  const accounts = list.filter((a) => {
    if (!a.id || !providers[a.provider] || seen.has(a.id)) return false;
    seen.add(a.id);
    return !(overrides[a.id] && overrides[a.id].hidden);
  });

  const perProvider = {};
  for (const a of accounts) perProvider[a.provider] = (perProvider[a.provider] || 0) + 1;

  return accounts.map((a) => {
    const p = providers[a.provider];
    const label =
      (overrides[a.id] && overrides[a.id].label) ||
      a.label ||
      (perProvider[a.provider] > 1 ? `${p.name} · ${a.id}` : p.name);
    return {
      id: a.id,
      provider: a.provider,
      label,
      providerName: p.name,
      monogram: p.monogram,
      settings: a.settings || null,
      env: a.env || null,
      sourceName: a.settings || a.env || null,
    };
  });
}

module.exports = { loadAccounts, keyFor };
