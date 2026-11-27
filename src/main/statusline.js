'use strict';
// Sets up and removes the Claude Code status line that saves plan usage for the Claude row. This is the one place
// PawGauge changes a Claude Code file, and settings.json can hold an API key, so the rules are strict:
//   - only on a click that the user confirmed (main.js), or when PawGauge is uninstalled (removal only);
//   - only the top-level "statusLine" entry changes: it is cut or inserted as text, every other byte stays;
//   - another status line is never replaced or removed;
//   - a file that is not a JSON object, or changed since the user saw the question, is left alone;
//   - no backup copy is made, and nothing read from the file is returned except the state below.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const SCRIPT_NAME = 'pawgauge-statusline.ps1';
const OURS = /^powershell -NoProfile -ExecutionPolicy Bypass -File "[^"]*\/pawgauge-statusline\.ps1"$/;

/**
 * Claude Code runs this through Git Bash when it is installed, otherwise PowerShell, so it must mean the same in both:
 * forward slashes, and no character that either shell would expand inside double quotes.
 */
function commandFor(scriptPath) {
  const file = scriptPath.replace(/\\/g, '/');
  if (/["`$\r\n“”„]/.test(file)) return null;
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`;
}

const entryFor = (scriptPath) => ({ type: 'command', command: commandFor(scriptPath) });

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** { text: null, data: {} } when there is no file; throws when it cannot be read as a JSON object. */
function load(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { text: null, data: {} };
    throw new Error('unreadable');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('unreadable'); // not UTF-8: rewriting would damage it
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (!isObject(data)) throw new Error('unreadable');
  return { text, data };
}

/**
 * state: 'no-claude' | 'unreadable' | 'none' | 'ours' | 'ours-old' (our entry, another script path) | 'other'.
 * hooksDisabled: Claude Code then runs no status line from this file.
 */
function inspect(claudeDir, scriptPath) {
  if (!fs.existsSync(claudeDir)) return { state: 'no-claude', hooksDisabled: false };
  let data;
  try {
    ({ data } = load(path.join(claudeDir, 'settings.json')));
  } catch {
    return { state: 'unreadable', hooksDisabled: false };
  }
  const hooksDisabled = data.disableAllHooks === true;
  const line = data.statusLine;
  if (line === undefined) return { state: 'none', hooksDisabled };
  const command = isObject(line) && typeof line.command === 'string' ? line.command : '';
  if (!OURS.test(command)) return { state: 'other', hooksDisabled };
  return { state: command === commandFor(scriptPath) ? 'ours' : 'ours-old', hooksDisabled };
}

/* ---------- editing the text of a JSON object that has already parsed ---------- */
const skipSpace = (s, i) => {
  while (/\s/.test(s[i])) i++;
  return i;
};
function endOfString(s, i) {
  for (i++; s[i] !== '"'; i++) if (s[i] === '\\') i++;
  return i + 1;
}
function endOfValue(s, i) {
  if (s[i] === '"') return endOfString(s, i);
  if (s[i] !== '{' && s[i] !== '[') {
    while (i < s.length && !/[\s,}\]]/.test(s[i])) i++;
    return i;
  }
  let depth = 0;
  do {
    if (s[i] === '"') {
      i = endOfString(s, i);
      continue;
    }
    if (s[i] === '{' || s[i] === '[') depth++;
    else if (s[i] === '}' || s[i] === ']') depth--;
    i++;
  } while (depth);
  return i;
}
/** The top-level members: [{ key, start, end }], plus where the object's braces are. */
function outline(s) {
  const open = s.indexOf('{');
  const members = [];
  let i = skipSpace(s, open + 1);
  while (s[i] === '"') {
    const start = i;
    const keyEnd = endOfString(s, i);
    const key = JSON.parse(s.slice(start, keyEnd));
    const end = endOfValue(s, skipSpace(s, skipSpace(s, keyEnd) + 1)); // past the colon
    members.push({ key, start, end });
    i = skipSpace(s, end);
    if (s[i] === ',') i = skipSpace(s, i + 1);
  }
  return { open, close: i, members };
}

function withoutEntry(s) {
  const { open, close, members } = outline(s);
  const at = members.findIndex((m) => m.key === 'statusLine');
  if (at < 0) return s;
  if (at > 0) return s.slice(0, members[at - 1].end) + s.slice(members[at].end);
  if (members.length > 1) return s.slice(0, members[0].start) + s.slice(members[1].start);
  return s.slice(0, open + 1) + s.slice(close);
}

function withEntry(s, entry) {
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  const { open, close, members } = outline(s);
  const first = members[0] && /(?:^|\n)([ \t]+)$/.exec(s.slice(open + 1, members[0].start));
  const indent = first ? first[1] : '  ';
  const body = JSON.stringify(entry, null, indent).split('\n').join(eol + indent);
  const member = `"statusLine": ${body}`;
  if (!members.length) return `${s.slice(0, open + 1)}${eol}${indent}${member}${eol}${s.slice(close)}`;
  const last = members[members.length - 1].end;
  const oneLine = !s.slice(open, close).includes('\n');
  return `${s.slice(0, last)},${oneLine ? ' ' : eol + indent}${member}${s.slice(last)}`;
}

/** Works out the change without making it. action: 'setup' | 'remove'. Throws if this state does not allow it. */
function plan(claudeDir, scriptPath, action) {
  const { state } = inspect(claudeDir, scriptPath);
  const allowed = action === 'setup' ? ['none', 'ours-old'] : ['ours', 'ours-old'];
  if (!allowed.includes(state)) throw new Error('Claude Code\'s settings.json has changed, so nothing was done. Open Accounts again to see its state.');
  const entry = action === 'setup' ? entryFor(scriptPath) : null;
  if (entry && !entry.command) throw new Error('The path to PawGauge\'s script has a character a status line command cannot carry.');
  const file = path.join(claudeDir, 'settings.json');
  const { text, data } = load(file);

  const expected = { ...data };
  delete expected.statusLine;
  if (entry) expected.statusLine = entry;

  let next;
  if (text === null) next = `${JSON.stringify(expected, null, 2)}\n`;
  else {
    const bom = text.startsWith('﻿') ? '﻿' : '';
    let body = withoutEntry(text.slice(bom.length));
    if (entry) body = withEntry(body, entry);
    next = bom + body;
  }
  // The text edit has to mean exactly "the same settings, with this one entry changed", or nothing is written.
  if (!isDeepStrictEqual(JSON.parse(next.replace(/^﻿/, '')), expected)) {
    throw new Error('settings.json is laid out in a way PawGauge cannot edit safely, so it was left unchanged.');
  }
  return { file, before: text, after: next, entry };
}

/** Writes a plan, unless the file is no longer what the plan was made from. */
function apply({ file, before, after }) {
  let now;
  try {
    now = load(file).text;
  } catch {
    now = undefined;
  }
  if (now !== before) throw new Error('settings.json changed while the question was open, so nothing was written. Try again.');
  const target = before === null ? file : fs.realpathSync(file); // keep a linked settings.json linked
  const tmp = `${target}.${process.pid}.pawgauge.tmp`;
  try {
    fs.writeFileSync(tmp, after, { mode: before === null ? 0o600 : fs.statSync(target).mode });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true }); // it holds a copy of the settings: never leave it behind
  }
}

/** A crash between writing and renaming would leave a copy of the settings behind: delete any such file. */
function sweep(claudeDir, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(claudeDir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!/^settings\.json\.\d+\.pawgauge\.tmp$/.test(f)) continue;
    const file = path.join(claudeDir, f);
    try {
      if (now - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file);
    } catch {
      /* gone already, or in use */
    }
  }
}

/** The script is run from a copy in PawGauge's own data folder, which stays put when the app is moved or updated. */
function installScript(source, scriptPath) {
  const wanted = fs.readFileSync(source);
  try {
    if (fs.readFileSync(scriptPath).equals(wanted)) return;
  } catch {
    /* not there yet */
  }
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, wanted);
}

module.exports = { SCRIPT_NAME, commandFor, inspect, plan, apply, sweep, installScript };
