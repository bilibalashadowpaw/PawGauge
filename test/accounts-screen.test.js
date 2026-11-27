'use strict';
// The Accounts screen: what it lists, what it writes to accounts.json, and which files it may add. Fake keys, fake home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanAccounts, keyFor, planAdd } = require('../src/main/accounts');
const { setOverride, addAccount, removeAccount, cleanLabel } = require('../src/main/user-accounts');

const KEY = 'fake-key-do-not-show';
const cfg = (url, key = KEY) => ({ env: { ...(url ? { ANTHROPIC_BASE_URL: url } : {}), ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}) } });
const ZAI = 'https://api.z.ai/api/anthropic';
const DEEPSEEK = 'https://api.deepseek.com/anthropic';

const homes = [];
test.after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })));

function machine(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-screen-'));
  homes.push(home);
  const write = (rel, body) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  const userDir = path.join(home, 'appdata');
  const scan = () => scanAccounts(userDir, { home, env: {} });
  const saved = () => JSON.parse(fs.readFileSync(path.join(userDir, 'accounts.json'), 'utf8'));
  const plan = (name) => {
    const s = scan();
    return planAdd(s.claudeDir, s.report, name);
  };
  return { home, write, scan, saved, plan, userDir };
}
const listed = (r) => r.report.accounts.map((a) => [a.id, a.hidden, a.label || a.autoLabel]);

test('hidden accounts stay in the list, so they can be shown again', () => {
  const m = machine({ '.claude/settings.a.json': cfg(ZAI, 'a'), '.claude/settings.b.json': cfg(ZAI, 'b') });
  setOverride(m.userDir, 'b', { hidden: true });
  setOverride(m.userDir, 'claude', { hidden: true });
  let r = m.scan();
  assert.deepEqual(r.accounts.map((a) => a.id), ['a']);
  assert.deepEqual(listed(r), [['claude', true, 'Claude'], ['a', false, 'z.ai'], ['b', true, 'z.ai · b']]);

  setOverride(m.userDir, 'b', { hidden: false });
  r = m.scan();
  assert.deepEqual(r.accounts.map((a) => [a.id, a.label]), [['a', 'z.ai · a'], ['b', 'z.ai · b']]);
});

test('a hidden accounts.json entry stays in the list too', () => {
  const m = machine({ 'appdata/accounts.json': { accounts: [{ id: 'w', provider: 'deepseek', env: 'WORK_KEY' }] } });
  setOverride(m.userDir, 'w', { hidden: true });
  const r = m.scan();
  assert.deepEqual(listed(r), [['w', true, 'DeepSeek']]);
  assert.deepEqual([r.report.accounts[0].source, r.report.accounts[0].removable], ['WORK_KEY', true]);
});

test('renaming sets the name, and an empty name goes back to the automatic one', () => {
  const m = machine({ '.claude/settings.a.json': cfg(ZAI) });
  setOverride(m.userDir, 'a', { label: 'Work' });
  assert.equal(m.scan().accounts[1].label, 'Work');
  setOverride(m.userDir, 'a', { label: '' });
  assert.equal(m.scan().accounts[1].label, 'z.ai');
  assert.deepEqual(m.saved().overrides, {});
});

test('saving keeps everything a person wrote by hand', () => {
  const hand = {
    note: 'mine',
    overrides: { a: { label: 'Old', colour: 'blue' }, other: { hidden: true } },
    accounts: [{ id: 'w', provider: 'deepseek', env: 'WORK_KEY', extra: 1 }],
  };
  const m = machine({ 'appdata/accounts.json': `\uFEFF${JSON.stringify(hand)}` });
  setOverride(m.userDir, 'a', { hidden: true });
  addAccount(m.userDir, { id: 'n', provider: 'zai', settings: 'n.json' });
  removeAccount(m.userDir, 'n');
  assert.deepEqual(m.saved(), { ...hand, overrides: { a: { label: 'Old', colour: 'blue', hidden: true }, other: { hidden: true } } });
});

test('an accounts.json that cannot be understood is left exactly as it is', () => {
  for (const text of ['{ "accounts": [', '[1]', '{"accounts": {}}', '{"overrides": []}']) {
    const m = machine({ 'appdata/accounts.json': text });
    for (const change of [() => setOverride(m.userDir, 'a', { hidden: true }), () => addAccount(m.userDir, { id: 'a' }), () => removeAccount(m.userDir, 'a')]) {
      assert.throws(change, /left unchanged/);
    }
    assert.equal(fs.readFileSync(path.join(m.userDir, 'accounts.json'), 'utf8'), text);
  }
});

test('a typed name is one short line', () => {
  assert.equal(cleanLabel('  Work\naccount\u0007 '), 'Work account');
  assert.equal(cleanLabel('x'.repeat(100)).length, 40);
});

test('a named file that is also in accounts.json is counted once, under that entry', () => {
  const m = machine({
    '.claude/settings.a.json': cfg(ZAI),
    '.claude/settings.json': cfg(ZAI),
    'appdata/accounts.json': { accounts: [{ id: 'mine', provider: 'zai', settings: 'settings.a.json' }] },
  });
  assert.deepEqual(m.scan().accounts.map((a) => a.id), ['claude', 'mine']);
});

test('only a bare file name inside the Claude folder can be added', () => {
  const m = machine({ 'outside.json': cfg(ZAI), '.claude/sub/deep.json': cfg(ZAI) });
  for (const name of ['../outside.json', '..\\outside.json', 'sub/deep.json', path.join(m.home, 'outside.json'), 'notes.txt', '', null]) {
    assert.match(m.plan(name).error, /directly inside/, String(name));
  }
});

test('a file whose address names a service is added for that service only, and stops if the address goes', () => {
  const m = machine({ '.claude/work.json': cfg(DEEPSEEK) });
  const plan = m.plan('work.json');
  assert.deepEqual(plan, { account: { id: 'work', provider: 'deepseek', settings: 'work.json', needsAddress: true } });
  addAccount(m.userDir, plan.account);
  const account = m.scan().accounts.find((a) => a.id === 'work');
  assert.equal(keyFor(account), KEY);
  m.write('.claude/work.json', cfg(null, 'an-anthropic-key'));
  assert.throws(() => keyFor(account), (e) => e.kind === 'moved');
  assert.match(m.plan('work.json').error, /already in the list/);
});

test('a key with no address has to be assigned by the user; nothing is chosen for them', () => {
  const m = machine({ '.claude/settings.bare.json': cfg(null), '.claude/settings.empty.json': cfg(null, null) });
  const rows = Object.fromEntries(m.scan().report.files.map((r) => [r.file, !!r.canAssign]));
  assert.deepEqual(rows, { 'settings.bare.json': true, 'settings.empty.json': false });
  const plan = m.plan('settings.bare.json');
  assert.deepEqual(plan.account, { id: 'bare', settings: 'settings.bare.json' });
  assert.deepEqual(plan.choose, ['zai', 'minimax', 'deepseek']);
  assert.match(m.plan('settings.empty.json').error, /no API key/);

  addAccount(m.userDir, { ...plan.account, provider: 'zai' });
  const r = m.scan();
  assert.deepEqual(r.accounts.map((a) => a.id), ['claude', 'bare']);
  assert.deepEqual(r.report.files.filter((x) => x.canAssign), []);
});

test('relays, other regions and broken files are refused with the reason', () => {
  const m = machine({
    '.claude/relay.json': cfg('https://deepseek.relay.example/v1'),
    '.claude/cn.json': cfg('https://api.minimaxi.com/anthropic'),
    '.claude/broken.json': '{',
  });
  assert.match(m.plan('relay.json').error, /not a service PawGauge supports/);
  assert.match(m.plan('cn.json').error, /region is not supported/);
  assert.match(m.plan('broken.json').error, /not valid JSON/);
  assert.match(m.plan('gone.json').error, /cannot be read|not valid JSON/);
});

test('a new account gets its own id even when the file name repeats one', () => {
  const m = machine({ '.claude/settings.work.json': cfg(ZAI, 'a'), '.claude/work.json': cfg(DEEPSEEK, 'b') });
  assert.equal(m.plan('work.json').account.id, 'work-2');
});

test('what the screen receives never carries a key or the full home path', () => {
  const m = machine({ '.claude/settings.a.json': cfg(ZAI), '.claude/settings.bare.json': cfg(null) });
  addAccount(m.userDir, { id: 'x', provider: 'zai', settings: path.join(m.home, 'elsewhere', 'x.json') });
  const text = JSON.stringify(m.scan().report);
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes(path.basename(m.home)));
});
