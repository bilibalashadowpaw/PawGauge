'use strict';
// Accounts are data. Auto-discovered from Claude Code's settings files (~/.claude, or CLAUDE_CONFIG_DIR): settings.json and
// settings.*.json, where the base URL's domain picks the provider. Plus an optional %APPDATA%\PawGauge\accounts.json:
//   {
//     "overrides": { "zai-1": { "label": "z.ai main", "hidden": false } },
//     "accounts":  [ { "id": "work-ds", "provider": "deepseek", "label": "DeepSeek work", "env": "DEEPSEEK_WORK_KEY" },
//                    { "id": "zai-3", "provider": "zai", "settings": "settings.zai-3.json" } ]
//   }
// Keys are read at fetch time (never cached, never written anywhere) so a fixed key is picked up on the next poll.
// Every scan also returns a report of what was looked at and why anything was skipped. It is shown in the window, so it
// holds file names, provider ids, host names and reason codes only: never a key, a whole URL or the user's home path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { providers, classifyHost } = require('./providers');
const { ProviderError } = require('./providers/util');

/** { data } on success, { error: 'missing' | 'unreadable' } otherwise. */
function readJson(file) {
  try {
    // Some Windows editors save with a byte-order mark, which JSON.parse rejects.
    return { data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

const envOf = (cfg) => (cfg && cfg.env) || {};
const keyIn = (env) => env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null;

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function shortPath(dir, home) {
  const rel = path.relative(home, dir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : path.basename(dir);
}

/** One settings file: { account, key } if it is a usable account, otherwise { reason, host?, provider? }. */
function inspect(file) {
  const { data, error } = readJson(file);
  if (error) return { reason: 'unreadable' };
  const env = envOf(data);
  if (!env.ANTHROPIC_BASE_URL) return { reason: 'no-base-url' };
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  if (!host) return { reason: 'bad-url' };
  const match = classifyHost(host);
  if (!match) return { reason: 'unknown-host', host };
  if (!match.supported) return { reason: 'unsupported-region', host, provider: match.provider };
  const key = keyIn(env);
  if (!key) return { reason: 'no-key', provider: match.provider };
  return { account: { provider: match.provider }, key };
}

function discover(dir, userAccounts, report) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
    report.dirFound = true;
  } catch {
    /* no Claude config folder */
  }
  const named = names.filter((f) => /^settings\..+\.json$/.test(f) && !/\.bak/.test(f)).sort();
  // The default file goes last: when it repeats a named file's key, the named file keeps the account (and its history).
  const files = names.includes('settings.json') ? [...named, 'settings.json'] : named;

  const out = [];
  const seenKeys = new Map(); // provider + key -> file; lives only for this scan
  for (const f of files) {
    const r = inspect(path.join(dir, f));
    const row = { file: f, status: 'skipped', reason: r.reason, host: r.host, provider: r.provider };
    report.files.push(row);
    if (!r.account) continue;
    const { provider } = r.account;
    row.provider = provider;
    const fingerprint = `${provider}\n${r.key}`;
    let id = f.replace(/^settings\./, '').replace(/\.json$/, '');
    if (f === 'settings.json') {
      if (userAccounts.some((a) => a.settings === f)) {
        row.reason = 'listed';
        continue;
      }
      if (seenKeys.has(fingerprint)) {
        row.reason = 'duplicate';
        row.sameAs = seenKeys.get(fingerprint);
        continue;
      }
      id = out.some((a) => a.id === 'default') ? 'default-settings' : 'default';
    }
    seenKeys.set(fingerprint, f);
    row.status = 'found';
    row.id = id;
    out.push({ id, provider, settings: f, discovered: true });
  }
  return out;
}

/**
 * The key for one account, read now. A settings file can be repointed at another service while PawGauge runs (switching
 * tools rewrite settings.json), so the file's current address is checked every time: a key only ever goes to the provider
 * it was configured for.
 */
function keyFor(account) {
  if (account.env) return process.env[account.env] || null;
  if (!account.settings) return null;
  const env = envOf(readJson(path.join(account.claudeDir, account.settings)).data);
  const key = keyIn(env);
  if (!key) return null;
  if (!env.ANTHROPIC_BASE_URL) {
    // Written by hand in accounts.json, the user has said whose key this is. Found automatically, the address was the proof.
    if (account.discovered) throw new ProviderError('moved', 'Settings file changed');
    return key;
  }
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  const match = host && classifyHost(host);
  if (!match || match.provider !== account.provider) throw new ProviderError('moved', 'Settings file points elsewhere');
  if (!match.supported) throw new ProviderError('region', 'Region not supported yet');
  return key;
}

function scanAccounts(userDir, { env = process.env, home = os.homedir() } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const report = { dir: shortPath(claudeDir, home), dirFound: false, files: [] };

  const userFile = userDir ? readJson(path.join(userDir, 'accounts.json')) : { error: 'missing' };
  if (userFile.error === 'unreadable') report.files.push({ file: 'accounts.json', status: 'skipped', reason: 'unreadable' });
  const user = userFile.data || {};
  const overrides = user.overrides || {};
  const userAccounts = (Array.isArray(user.accounts) ? user.accounts : []).filter(Boolean);

  const discovered = discover(claudeDir, userAccounts, report);
  // The Claude row needs Claude Code: its config folder, or a snapshot left by the status line (always in ~/.claude).
  const hasClaude = report.dirFound || fs.existsSync(path.join(home, '.claude', 'usage-snapshot.json'));
  const list = [...(hasClaude ? [{ id: 'claude', provider: 'anthropic' }] : []), ...discovered, ...userAccounts];

  const seen = new Set();
  const accounts = list.filter((a) => {
    const own = userAccounts.includes(a);
    if (!a.id || !providers[a.provider]) {
      if (own) report.files.push({ file: 'accounts.json', status: 'skipped', reason: a.id ? 'unknown-provider' : 'no-id', id: a.id });
      return false;
    }
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    if (!(overrides[a.id] && overrides[a.id].hidden)) {
      if (own) report.files.push({ file: 'accounts.json', status: 'found', provider: a.provider, id: a.id });
      return true;
    }
    const row = report.files.find((r) => r.status === 'found' && r.id === a.id);
    if (row) Object.assign(row, { status: 'skipped', reason: 'hidden' });
    return false;
  });

  const perProvider = {};
  for (const a of accounts) perProvider[a.provider] = (perProvider[a.provider] || 0) + 1;

  for (const row of report.files) if (providers[row.provider]) row.providerName = providers[row.provider].name;

  return {
    report,
    accounts: accounts.map((a) => {
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
        claudeDir,
        discovered: discovered.includes(a),
      };
    }),
  };
}

module.exports = { scanAccounts, keyFor };
