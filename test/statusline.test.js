'use strict';
// Claude usage setup: the only code that changes a Claude Code file. Everything runs in a throwaway folder with a fake
// key. The last tests run the real PowerShell script and the real command line (Windows only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPT_NAME, commandFor, inspect, plan, apply, sweep, installScript } = require('../src/main/statusline');

const KEY = 'fake-key-do-not-show';
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sl-'));
  dirs.push(root);
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude);
  const file = path.join(claude, 'settings.json');
  if (text !== undefined) fs.writeFileSync(file, text);
  const script = path.join(root, 'app data', SCRIPT_NAME);
  const read = () => fs.readFileSync(file, 'utf8');
  const state = () => inspect(claude, script).state;
  const run = (action) => apply(plan(claude, script, action));
  return { root, claude, file, script, read, state, run };
}

const HAND = [
  `{\n  "env": { "ANTHROPIC_AUTH_TOKEN": "${KEY}" },\n  "permissions": {"allow":["Bash(ls:*)"]},\n  "big": 12345678901234567890\n}\n`,
  `\uFEFF{\r\n\t"model": "a \\"quoted\\" } brace",\r\n\t"hooks": [ { "statusLine": 1 } ]\r\n}\r\n`,
  '{"model":"x"}',
  '{}',
  '  {\n  }  \n',
];

test('setting up adds only the status line, and removing it gives back every byte', () => {
  for (const text of HAND) {
    const s = setup(text);
    assert.equal(s.state(), 'none');
    s.run('setup');
    assert.equal(s.state(), 'ours', JSON.stringify(text));
    const after = JSON.parse(s.read().replace(/^\uFEFF/, ''));
    assert.deepEqual(after.statusLine, { type: 'command', command: commandFor(s.script) });
    s.run('remove');
    // An object with nothing in it closes up; anything with settings in it comes back exactly.
    if (text.includes(':')) assert.equal(s.read(), text);
    else assert.deepEqual(JSON.parse(s.read()), {});
    assert.deepEqual(fs.readdirSync(s.claude), ['settings.json'], 'no backup or temporary copy');
  }
});

test('with no settings.json, one is created holding just the status line', () => {
  const s = setup();
  s.run('setup');
  assert.deepEqual(Object.keys(JSON.parse(s.read())), ['statusLine']);
});

test('an entry in the middle or at the start of the file is removed cleanly', () => {
  const s = setup('{}');
  const mine = JSON.stringify({ type: 'command', command: commandFor(s.script) });
  for (const text of [`{"statusLine": ${mine}, "a": 1}`, `{"a": 1, "statusLine": ${mine}, "b": 2}`]) {
    fs.writeFileSync(s.file, text);
    s.run('remove');
    assert.ok(!s.read().includes('statusLine'));
    assert.equal(JSON.parse(s.read()).a, 1);
  }
});

test('another status line is never replaced or removed', () => {
  for (const line of [
    { type: 'command', command: 'node "~/.claude/mine.js"' },
    { type: 'command', command: `${commandFor('C:/x/pawgauge-statusline.ps1')} | tee log` },
    'text',
    null,
  ]) {
    const text = JSON.stringify({ statusLine: line });
    const s = setup(text);
    assert.equal(s.state(), 'other');
    for (const action of ['setup', 'remove']) assert.throws(() => s.run(action), /nothing was done/);
    assert.equal(s.read(), text);
  }
});

test('our entry with an old script path is recognised, updated and removable', () => {
  const s = setup(JSON.stringify({ statusLine: { type: 'command', command: commandFor('C:/old place/pawgauge-statusline.ps1') } }));
  assert.equal(s.state(), 'ours-old');
  s.run('setup');
  assert.equal(s.state(), 'ours');
});

test('a file that cannot be read as settings is left alone', () => {
  const latin1 = Buffer.from('{"name":"caf\xe9"}', 'latin1');
  for (const bad of ['{ "a": ', '[1]', 'null', latin1]) {
    const s = setup(bad);
    assert.equal(s.state(), 'unreadable');
    assert.throws(() => s.run('setup'), /nothing was done/);
    assert.deepEqual(fs.readFileSync(s.file), Buffer.from(bad));
  }
});

test('a repeated statusLine key cannot be edited safely, so nothing is written', () => {
  const s = setup('{"statusLine": 1, "a": 2, "statusLine": ' + JSON.stringify({ type: 'command', command: commandFor('C:/x/pawgauge-statusline.ps1') }) + '}');
  const before = s.read();
  assert.throws(() => s.run('remove'), /cannot edit safely/);
  assert.equal(s.read(), before);
});

test('a file that changed after the question was asked is not overwritten', () => {
  const s = setup('{"a": 1}');
  const change = plan(s.claude, s.script, 'setup');
  fs.writeFileSync(s.file, '{"a": 2}');
  assert.throws(() => apply(change), /changed while the question was open/);
  assert.equal(s.read(), '{"a": 2}');
});

test('what is shown before setup holds the new entry only, nothing from the file', () => {
  const s = setup(HAND[0]);
  const change = plan(s.claude, s.script, 'setup');
  assert.ok(!JSON.stringify(change.entry).includes(KEY));
  assert.deepEqual(Object.keys(change.entry), ['type', 'command']);
  assert.ok(!JSON.stringify(inspect(s.claude, s.script)).includes(KEY));
});

test('states: no Claude folder, and hooks switched off', () => {
  const s = setup('{"disableAllHooks": true}');
  assert.deepEqual(inspect(s.claude, s.script), { state: 'none', hooksDisabled: true });
  assert.equal(inspect(path.join(s.root, 'nowhere'), s.script).state, 'no-claude');
});

test('a script path a shell would expand is refused', () => {
  for (const p of ['C:/a$b/x.ps1', 'C:/a`b/x.ps1', 'C:/a"b/x.ps1', 'C:/a\u201cb/x.ps1']) assert.equal(commandFor(p), null);
  assert.equal(commandFor('C:\\Jo Zo\u00eb & co\\x.ps1'), 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Jo Zo\u00eb & co/x.ps1"');
});

test('a temporary copy of the settings stranded by a crash is deleted; nothing else is', () => {
  const s = setup('{}');
  const names = ['settings.json.12.pawgauge.tmp', 'settings.json.34.pawgauge.tmp', 'settings.json.bak', 'notes.tmp'];
  for (const n of names) fs.writeFileSync(path.join(s.claude, n), 'x');
  for (const n of names.filter((x) => x !== names[1])) fs.utimesSync(path.join(s.claude, n), new Date(0), new Date(0));
  sweep(s.claude);
  assert.deepEqual(fs.readdirSync(s.claude).sort(), ['notes.tmp', 'settings.json', 'settings.json.34.pawgauge.tmp', 'settings.json.bak']);
  sweep(path.join(s.root, 'nowhere'));
});

test('the Node script saves the limits and clears only stale temporary files', () => {
  const s = setup('{}');
  const snapshot = path.join(s.claude, 'usage-snapshot.json');
  for (const n of ['usage-snapshot.json.1.tmp', 'usage-snapshot.json.2.tmp']) fs.writeFileSync(path.join(s.claude, n), 'x');
  fs.utimesSync(`${snapshot}.1.tmp`, new Date(0), new Date(0));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'statusline-snapshot.js')], {
    input: JSON.stringify({ rate_limits: LIMITS }),
    env: { ...process.env, HOME: s.root, USERPROFILE: s.root },
  });
  assert.deepEqual([r.status, r.stdout.toString('utf8')], [0, '5h 39% \u00b7 week 9%']);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot, 'utf8')).rate_limits, LIMITS);
  assert.deepEqual(fs.readdirSync(s.claude).sort(), ['settings.json', 'usage-snapshot.json', 'usage-snapshot.json.2.tmp']);
});

/* ---------- the real script ---------- */
const SOURCE = path.join(__dirname, '..', 'tools', 'statusline-snapshot.ps1');
const windows = { skip: process.platform !== 'win32' && 'Windows only' };
const LIMITS = { five_hour: { used_percentage: 38.5, resets_at: 1900000000 }, seven_day: { used_percentage: 9, resets_at: 1900500000 } };
const gitBash = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '';

test('the PowerShell script is plain ASCII, as Windows PowerShell needs', () => {
  assert.ok(fs.readFileSync(SOURCE).every((b) => b < 128));
});

test('the script saves the limits, prints the summary, and never fails', windows, () => {
  const s = setup('{}');
  // A folder with a space and a non-ASCII letter, run through the exact command that goes into settings.json.
  const script = path.join(s.root, 'Zo\u00eb data & more', SCRIPT_NAME);
  installScript(SOURCE, script);
  const home = path.join(s.root, 'home');
  const snapshot = path.join(home, '.claude', 'usage-snapshot.json');
  const shells = [['powershell.exe', ['-NoProfile', '-Command']], ...(fs.existsSync(gitBash) ? [[gitBash, ['-c']]] : [])];
  for (const [shell, flags] of shells) {
    const send = (input) => spawnSync(shell, [...flags, commandFor(script)], { input, env: { ...process.env, USERPROFILE: home }, timeout: 60_000 });
    fs.rmSync(home, { recursive: true, force: true });

    for (const quiet of ['not json', '', JSON.stringify({ model: 'x' })]) {
      const r = send(quiet);
      assert.deepEqual([r.status, r.stdout.toString('utf8').trim()], [0, ''], `${shell}: ${quiet}`);
      assert.ok(!fs.existsSync(snapshot));
    }
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const stale = `${snapshot}.999.tmp`;
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, new Date(0), new Date(0));
    for (let i = 0; i < 2; i++) { // the second run replaces an existing snapshot
      const r = send(JSON.stringify({ cwd: 'C:/Zo\u00eb', rate_limits: LIMITS }));
      assert.deepEqual([r.status, r.stdout.toString('utf8').trim()], [0, '5h 39% \u00b7 week 9%'], shell);
      const saved = JSON.parse(fs.readFileSync(snapshot, 'utf8')); // no byte-order mark: the app does not strip one
      assert.deepEqual(saved.rate_limits, LIMITS);
      assert.ok(Math.abs(Date.now() - saved.updatedAt) < 60_000);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(snapshot)), ['usage-snapshot.json']);
  }
});
