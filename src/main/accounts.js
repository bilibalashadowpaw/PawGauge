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
  if (!env.ANTHROPIC_BASE_URL) return { reason: 'no-base-url', hasKey: !!keyIn(env) };
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
    // A file named by a usable accounts.json entry belongs to that entry: it is not added a second time.
    const listed = userAccounts.some((a) => a.settings === f && a.id && providers[a.provider]);
    if (listed) row.reason = 'listed';
    if (!r.account) {
      if (!listed && r.hasKey) row.canAssign = true;
      continue;
    }
    const { provider } = r.account;
    row.provider = provider;
    const fingerprint = `${provider}\n${r.key}`;
    if (listed) {
      seenKeys.set(fingerprint, f);
      continue;
    }
    let id = f.replace(/^settings\./, '').replace(/\.json$/, '');
    if (f === 'settings.json') {
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
    // needsAddress: added from the Accounts screen because of its address, so losing the address ends that too.
    if (account.discovered || account.needsAddress) throw new ProviderError('moved', 'Settings file changed');
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

  const isHidden = (a) => !!(overrides[a.id] && overrides[a.id].hidden);
  const seen = new Set();
  const every = list.filter((a) => {
    const own = userAccounts.includes(a);
    if (!a.id || !providers[a.provider]) {
      if (own) report.files.push({ file: 'accounts.json', status: 'skipped', reason: a.id ? 'unknown-provider' : 'no-id', id: a.id });
      return false;
    }
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    if (!isHidden(a)) {
      if (own) report.files.push({ file: 'accounts.json', status: 'found', provider: a.provider, id: a.id });
      return true;
    }
    const row = report.files.find((r) => r.status === 'found' && r.id === a.id);
    if (row) Object.assign(row, { status: 'skipped', reason: 'hidden' });
    return true;
  });
  const accounts = every.filter((a) => !isHidden(a));

  const perProvider = {};
  for (const a of accounts) perProvider[a.provider] = (perProvider[a.provider] || 0) + 1;
  // The name an account gets when nobody has typed one. A hidden account counts itself in, as it would be if shown.
  const autoLabel = (a) => {
    const p = providers[a.provider];
    const total = (perProvider[a.provider] || 0) + (isHidden(a) ? 1 : 0);
    return a.label || (total > 1 ? `${p.name} · ${a.id}` : p.name);
  };
  const typed = (a) => (overrides[a.id] && overrides[a.id].label) || '';

  // For the Accounts screen: every account, hidden ones too, so each can be shown again or renamed.
  report.accounts = every.map((a) => ({
    id: a.id,
    provider: a.provider,
    providerName: providers[a.provider].name,
    label: typed(a),
    autoLabel: autoLabel(a),
    source: a.settings ? path.basename(a.settings) : a.env || null,
    hidden: isHidden(a),
    removable: userAccounts.includes(a),
  }));

  for (const row of report.files) if (providers[row.provider]) row.providerName = providers[row.provider].name;

  return {
    report,
    claudeDir,
    accounts: accounts.map((a) => {
      const p = providers[a.provider];
      return {
        id: a.id,
        provider: a.provider,
        label: typed(a) || autoLabel(a),
        providerName: p.name,
        monogram: p.monogram,
        settings: a.settings || null,
        env: a.env || null,
        sourceName: a.settings || a.env || null,
        claudeDir,
        discovered: discovered.includes(a),
        needsAddress: !!a.needsAddress,
      };
    }),
  };
}

/**
 * What "add this settings file" would do. name: a file directly inside Claude Code's folder. Returns
 *   { error }                      it cannot be used, and why
 *   { account }                    its address says which service it belongs to
 *   { account, choose: [ids] }     it has a key but no address: only the user can say whose, and must confirm it
 */
function planAdd(claudeDir, report, name) {
  if (typeof name !== 'string' || name !== path.basename(name) || /[\\/]/.test(name) || !/\.json$/i.test(name)) {
    return { error: 'Choose a .json file that is directly inside Claude Code\'s folder.' };
  }
  const inUse = report.accounts.some((a) => a.source === name);
  if (inUse) return { error: `${name} is already in the list.` };
  const same = report.files.find((r) => r.file === name && r.reason === 'duplicate');
  if (same) return { error: `${name} holds the same account as ${same.sameAs}.` };

  const r = inspect(path.join(claudeDir, name));
  const taken = new Set(report.accounts.map((a) => a.id));
  const stem = name.replace(/\.json$/i, '').replace(/^settings\./, '').replace(/[^\w.-]+/g, '-') || 'account';
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;

  if (r.account) return { account: { id, provider: r.account.provider, settings: name, needsAddress: true } };
  if (r.reason === 'no-base-url' && r.hasKey) {
    return { account: { id, settings: name }, choose: Object.keys(providers).filter((p) => providers[p].needsKey) };
  }
  const why = {
    unreadable: 'is not valid JSON, or cannot be read.',
    'no-base-url': 'has no API key in it.',
    'bad-url': 'has an API address that is not a valid URL.',
    'unknown-host': `points at ${r.host}, which is not a service PawGauge supports.`,
    'unsupported-region': `points at ${r.host}. That region is not supported yet.`,
    'no-key': 'has no API key in it.',
  };
  return { error: `${name} ${why[r.reason] || 'cannot be used.'}` };
}

module.exports = { scanAccounts, keyFor, planAdd };
