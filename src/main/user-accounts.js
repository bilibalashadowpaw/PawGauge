'use strict';
// Changes PawGauge's own accounts.json for the Accounts screen. The file may be hand-written, so only the fields being
// changed are touched, and a file that cannot be understood is left exactly as it is. Nothing written here is a key, an
// address or a full path: names, provider ids and settings file names only.
const fs = require('fs');
const path = require('path');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function read(userDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(userDir, 'accounts.json'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('accounts.json cannot be read, so it was left unchanged.');
  }
  let data = null;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    /* reported below */
  }
  if (!isObject(data) || (data.accounts !== undefined && !Array.isArray(data.accounts)) || (data.overrides !== undefined && !isObject(data.overrides))) {
    throw new Error('accounts.json is not in the expected format, so it was left unchanged. Fix it, then try again.');
  }
  return data;
}

function write(userDir, data) {
  fs.mkdirSync(userDir, { recursive: true });
  const file = path.join(userDir, 'accounts.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file); // never half a file
}

/** change: { hidden?: boolean, label?: string }. An empty label goes back to the automatic name. */
function setOverride(userDir, id, change) {
  const data = read(userDir);
  const overrides = data.overrides || {};
  const own = Object.prototype.hasOwnProperty.call(overrides, id) && isObject(overrides[id]);
  const entry = own ? { ...overrides[id] } : {};
  if (change.hidden !== undefined) {
    if (change.hidden) entry.hidden = true;
    else delete entry.hidden;
  }
  if (change.label !== undefined) {
    // A hand-written entry can carry its own label, which an empty override leaves in charge.
    if (change.label) entry.label = change.label;
    else delete entry.label;
  }
  const next = { ...overrides, [id]: entry };
  if (!Object.keys(entry).length) delete next[id];
  write(userDir, { ...data, overrides: next });
}

function addAccount(userDir, account) {
  const data = read(userDir);
  const overrides = { ...(data.overrides || {}) };
  delete overrides[account.id]; // an old "hidden" for this id must not swallow the new account
  write(userDir, { ...data, accounts: [...(data.accounts || []), account], ...(data.overrides ? { overrides } : {}) });
}

function removeAccount(userDir, id) {
  const data = read(userDir);
  const overrides = { ...(data.overrides || {}) };
  delete overrides[id];
  write(userDir, { ...data, accounts: (data.accounts || []).filter((a) => !a || a.id !== id), ...(data.overrides ? { overrides } : {}) });
}

/** A name typed in the Accounts screen: one line, at most 40 characters. */
const cleanLabel = (v) => String(v).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 40).trim();

module.exports = { setOverride, addAccount, removeAccount, cleanLabel };
