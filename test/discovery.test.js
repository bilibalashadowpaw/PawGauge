'use strict';
// Other people's machines: each test builds a fake Claude config folder with fake keys. Nothing here touches the network
// or the real home folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanAccounts, keyFor } = require('../src/main/accounts');
const { Poller } = require('../src/main/poller');

const KEY = 'fake-key-do-not-show';
const cfg = (url, key = KEY) => ({ env: { ...(url ? { ANTHROPIC_BASE_URL: url } : {}), ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}) } });
const ZAI = 'https://api.z.ai/api/anthropic';
const DEEPSEEK = 'https://api.deepseek.com/anthropic';
const MINIMAX = 'https://api.minimax.io/anthropic';

const homes = [];
test.after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })));

/** files: paths relative to the fake home. Strings are written as they are, objects as JSON. */
function machine(files = {}, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-home-'));
  homes.push(home);
  const write = (rel, body) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  const userDir = path.join(home, 'appdata');
  const scan = () => scanAccounts(userDir, { home, env });
  return { home, write, scan };
}
const found = (r) => r.accounts.map((a) => `${a.provider}:${a.id}`);
const reasonFor = (r, file) => {
  const row = r.report.files.find((f) => f.file === file);
  return row && (row.reason || row.status);
};

test('no Claude Code at all: no accounts, not even the Claude row', () => {
  const r = machine().scan();
  assert.deepEqual(found(r), []);
  assert.equal(r.report.dirFound, false);
});

test('plain Claude setup: the Claude row only, and the check says why the file adds nothing', () => {
  const r = machine({ '.claude/settings.json': { model: 'x' } }).scan();
  assert.deepEqual(found(r), ['anthropic:claude']);
  assert.equal(reasonFor(r, 'settings.json'), 'no-base-url');
});

test('named settings files are found', () => {
  const r = machine({ '.claude/settings.work.json': cfg(ZAI), '.claude/settings.alt.json': cfg(MINIMAX, 'other') }).scan();
  assert.deepEqual(found(r), ['anthropic:claude', 'minimax:alt', 'zai:work']);
});

test('the default settings.json is found', () => {
  const r = machine({ '.claude/settings.json': cfg(ZAI) }).scan();
  assert.deepEqual(found(r), ['anthropic:claude', 'zai:default']);
});

test('the same key in settings.json and a named file is one account, under the named id', () => {
  const r = machine({ '.claude/settings.json': cfg(ZAI), '.claude/settings.work.json': cfg(ZAI) }).scan();
  assert.deepEqual(found(r), ['anthropic:claude', 'zai:work']);
  assert.equal(reasonFor(r, 'settings.json'), 'duplicate');
});

test('settings.json already listed in accounts.json is not added a second time', () => {
  const r = machine({
    '.claude/settings.json': cfg(ZAI),
    'appdata/accounts.json': { accounts: [{ id: 'mine', provider: 'zai', settings: 'settings.json' }] },
  }).scan();
  assert.deepEqual(found(r), ['anthropic:claude', 'zai:mine']);
});

test('a settings.default.json does not push settings.json out', () => {
  const r = machine({ '.claude/settings.json': cfg(ZAI, 'a'), '.claude/settings.default.json': cfg(ZAI, 'b') }).scan();
  assert.equal(r.accounts.filter((a) => a.provider === 'zai').length, 2);
});

test('CLAUDE_CONFIG_DIR moves the folder that is searched', () => {
  const m = machine({ 'elsewhere/settings.work.json': cfg(ZAI) });
  const r = scanAccounts(null, { home: m.home, env: { CLAUDE_CONFIG_DIR: path.join(m.home, 'elsewhere') } });
  assert.deepEqual(found(r), ['anthropic:claude', 'zai:work']);
  assert.equal(keyFor(r.accounts[1]), KEY);
});

test('a file saved with a byte-order mark (Windows editors) still loads', () => {
  const r = machine({ '.claude/settings.json': '﻿' + JSON.stringify(cfg(ZAI)) }).scan();
  assert.deepEqual(found(r), ['anthropic:claude', 'zai:default']);
});

test('look-alike and relay hosts are never taken for a provider', () => {
  const hosts = [
    'deepseek.relay.example', 'my-minimax-proxy.example', 'api.deepseek.com.relay.example', 'notdeepseek.com',
    'minimax.io.relay.example', 'fake-z.ai', 'api.z.ai.relay.example', 'llm-gateway.example',
  ];
  for (const host of hosts) {
    const r = machine({ '.claude/settings.x.json': cfg(`https://${host}/v1`) }).scan();
    assert.deepEqual(found(r), ['anthropic:claude'], host);
    assert.equal(reasonFor(r, 'settings.x.json'), 'unknown-host', host);
  }
});

test('mainland China hosts are recognised but not used', () => {
  for (const host of ['open.bigmodel.cn', 'api.minimaxi.com', 'api.minimax.cn']) {
    const r = machine({ '.claude/settings.cn.json': cfg(`https://${host}/anthropic`) }).scan();
    assert.deepEqual(found(r), ['anthropic:claude'], host);
    assert.equal(reasonFor(r, 'settings.cn.json'), 'unsupported-region', host);
  }
});

test('every skipped file says why', () => {
  const r = machine({
    '.claude/settings.nokey.json': cfg(ZAI, null),
    '.claude/settings.broken.json': '{ "env": ',
    '.claude/settings.badurl.json': cfg('not a url'),
    '.claude/settings.bak.json': cfg(ZAI),
  }).scan();
  assert.equal(reasonFor(r, 'settings.nokey.json'), 'no-key');
  assert.equal(reasonFor(r, 'settings.broken.json'), 'unreadable');
  assert.equal(reasonFor(r, 'settings.badurl.json'), 'bad-url');
});

test('accounts.json mistakes and hidden accounts show up in the check', () => {
  const broken = machine({ 'appdata/accounts.json': '{ nope' }).scan();
  assert.equal(reasonFor(broken, 'accounts.json'), 'unreadable');
  const hidden = machine({ '.claude/settings.work.json': cfg(ZAI), 'appdata/accounts.json': { overrides: { work: { hidden: true } } } }).scan();
  assert.deepEqual(found(hidden), ['anthropic:claude']);
  assert.equal(reasonFor(hidden, 'settings.work.json'), 'hidden');
});

test('the check never carries a key, and never the full home path', () => {
  const m = machine({
    '.claude/settings.json': cfg(ZAI),
    '.claude/settings.work.json': cfg(ZAI),
    '.claude/settings.relay.json': cfg(`https://user:${KEY}@relay.example/v1`),
    '.claude/settings.broken.json': `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${KEY}" `,
  });
  const text = JSON.stringify(m.scan().report);
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes(path.basename(m.home)));
});

/* ---------- the key is re-read on every poll, so the address is checked on every poll too ---------- */
const refuses = (account, kind) => assert.throws(() => keyFor(account), (e) => e.kind === kind);

test('a settings file switched to another service while running gives up no key', () => {
  const m = machine({ '.claude/settings.json': cfg(ZAI) });
  const account = m.scan().accounts[1];
  assert.equal(keyFor(account), KEY);
  for (const url of [DEEPSEEK, 'https://relay.example/v1', 'not a url']) {
    m.write('.claude/settings.json', cfg(url, 'someone-elses-key'));
    refuses(account, 'moved');
  }
  m.write('.claude/settings.json', cfg(null, 'an-anthropic-key')); // back to plain Claude, with its own API key
  refuses(account, 'moved');
});

test('an accounts.json entry cannot send a relay or China key to the international service', () => {
  const m = machine({
    '.claude/settings.relay.json': cfg('https://relay.example/v1'),
    '.claude/settings.cn.json': cfg('https://api.minimaxi.com/anthropic'),
    '.claude/settings.bare.json': cfg(null),
    'appdata/accounts.json': {
      accounts: [
        { id: 'r', provider: 'deepseek', settings: 'settings.relay.json' },
        { id: 'c', provider: 'minimax', settings: 'settings.cn.json' },
        { id: 'b', provider: 'deepseek', settings: 'settings.bare.json' },
      ],
    },
  });
  const by = Object.fromEntries(m.scan().accounts.map((a) => [a.id, a]));
  refuses(by.r, 'moved');
  refuses(by.c, 'region');
  assert.equal(keyFor(by.b), KEY); // no address in the file: the user named the provider themselves
});

test('a rescan adds new accounts, keeps readings, and drops a gone one even with its request in flight', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  const body = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5' }] };
  const waiting = [];
  global.fetch = () => new Promise((resolve) => waiting.push(() => resolve({ status: 200, ok: true, text: async () => JSON.stringify(body) })));
  const settle = async () => {
    waiting.splice(0).forEach((answer) => answer());
    await new Promise((r) => setImmediate(r));
  };

  const m = machine({ '.claude/settings.a.json': cfg(DEEPSEEK, 'a'), '.claude/settings.b.json': cfg(DEEPSEEK, 'b') });
  const only = () => m.scan().accounts.filter((a) => a.provider === 'deepseek');
  const poller = new Poller(only(), { record() {}, daysLeft: () => null });
  t.after(() => poller.stop());
  poller.accounts.forEach((a) => poller._loop(a));
  await settle();

  const inFlight = poller.refreshAll();
  fs.rmSync(path.join(m.home, '.claude', 'settings.b.json'));
  m.write('.claude/settings.c.json', cfg(DEEPSEEK, 'c'));
  const added = poller.setAccounts(only());
  assert.deepEqual(added.map((a) => a.id), ['c']);
  assert.deepEqual(poller.snapshot().accounts.map((a) => [a.id, a.status]).sort(), [['a', 'ok'], ['c', 'loading']]);
  await settle(); // b's late answer must not bring it back
  await inFlight;
  assert.deepEqual(poller.snapshot().accounts.map((a) => a.id).sort(), ['a', 'c']);
  assert.deepEqual([...poller.timers.keys()].sort(), ['a', 'c']);
});
