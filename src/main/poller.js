'use strict';
const { EventEmitter } = require('events');
const { providers } = require('./providers');
const { ProviderError } = require('./providers/util');
const { keyFor } = require('./accounts');

const { levelOfUsed, LOW_DAYS } = require('../shared/levels');

function urgencyOf(v) {
  if (v.status === 'loading') return 99;
  if (v.status === 'empty') return 95;
  if (v.status === 'error') return 8;
  if (v.kind === 'balance' && v.balance) {
    if (!v.balance.available) return 0;
    if (v.daysLeft !== null && v.daysLeft < LOW_DAYS) return 12;
    return 90;
  }
  const rem = (v.windows || []).map((w) => w.remainingPct);
  return rem.length ? Math.min(...rem) : 95;
}

const RANK = { ok: 0, warn: 1, crit: 2 };

/** Level of one reading, by the same rule as the meters. */
function viewLevel(v) {
  if (v.kind === 'balance' && v.balance) {
    if (!v.balance.available) return 'crit';
    return v.daysLeft != null && v.daysLeft < LOW_DAYS ? 'warn' : 'ok';
  }
  return (v.windows || []).reduce((worst, w) => {
    const l = levelOfUsed(100 - w.remainingPct);
    return RANK[l] > RANK[worst] ? l : worst;
  }, 'ok');
}

/** 'ok' | 'warn' | 'crit' for the tray icon and ShadowBlack. Errors are deliberately excluded (a dead key must not paint the tray amber forever). */
function trayLevel(views) {
  let level = 'ok';
  for (const v of views) {
    if (v.status !== 'ok') continue;
    const l = viewLevel(v);
    if (RANK[l] > RANK[level]) level = l;
  }
  return level;
}

/** Manual order wins when set (unknown ids go last, by urgency); otherwise urgency order. */
function applyOrder(accounts, order) {
  const byUrgency = [...accounts].sort((x, y) => x.urgency - y.urgency || x.label.localeCompare(y.label));
  if (!Array.isArray(order) || !order.length) return byUrgency;
  const rank = new Map(order.map((id, i) => [id, i]));
  return byUrgency.sort((x, y) => (rank.has(x.id) ? rank.get(x.id) : 1e6) - (rank.has(y.id) ? rank.get(y.id) : 1e6));
}

class Poller extends EventEmitter {
  constructor(accounts, history) {
    super();
    this.accounts = accounts;
    this.history = history;
    this.timers = new Map();
    this.views = new Map(accounts.map((a) => [a.id, this._blank(a)]));
    this.updatedAt = 0;
    this.order = null;
  }

  _blank(a) {
    return {
      id: a.id,
      provider: a.provider,
      label: a.label,
      providerName: a.providerName,
      monogram: a.monogram,
      sourceName: a.sourceName,
      status: 'loading',
      kind: 'windows',
      plan: null,
      windows: [],
      balance: null,
      daysLeft: null,
      fetchedAt: null,
      readingAt: null,
      error: null,
    };
  }

  start() {
    this.accounts.forEach((a, i) => setTimeout(() => this._loop(a), i * 350));
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Take a fresh scan: unchanged accounts keep their reading and timer, new ones start polling, gone ones stop. */
  setAccounts(next) {
    const same = (a, b) => a.id === b.id && a.provider === b.provider && a.settings === b.settings && a.env === b.env && a.claudeDir === b.claudeDir;
    const added = [];
    const accounts = next.map((a) => {
      const old = this.accounts.find((o) => same(o, a));
      if (!old) {
        added.push(a);
        return a;
      }
      Object.assign(old, a); // same object, so its running loop carries on
      Object.assign(this.views.get(old.id), { label: old.label });
      return old;
    });
    for (const o of this.accounts) {
      if (accounts.includes(o)) continue;
      clearTimeout(this.timers.get(o.id));
      this.timers.delete(o.id);
    }
    this.views = new Map(accounts.map((a) => [a.id, added.includes(a) ? this._blank(a) : this.views.get(a.id)]));
    this.accounts = accounts;
    this.emit('change');
    added.forEach((a) => this._loop(a));
    return added;
  }

  /** skip: accounts that setAccounts has just started, which are polling already. */
  async refreshAll(skip = []) {
    await Promise.all(this.accounts.filter((a) => !skip.includes(a)).map((a) => this._poll(a)));
  }

  async _loop(a) {
    if (!this.accounts.includes(a)) return; // dropped by a rescan
    await this._poll(a);
    if (!this.accounts.includes(a)) return;
    this.timers.set(a.id, setTimeout(() => this._loop(a), providers[a.provider].intervalMs));
  }

  async _poll(a) {
    const p = providers[a.provider];
    const prev = this.views.get(a.id);
    try {
      let key = null;
      if (p.needsKey) {
        key = keyFor(a);
        if (!key) throw new ProviderError('nokey', 'No key found');
      }
      const r = await p.fetchUsage(a, key);
      if (!this.accounts.includes(a)) return; // a rescan dropped it while the request was in flight
      const view = {
        ...this._blank(a),
        ...r,
        status: r.empty ? 'empty' : 'ok',
        fetchedAt: Date.now(),
        error: null,
      };
      if (r.kind === 'balance' && r.balance) {
        this.history.record(a.id, r.balance.total);
        view.daysLeft = this.history.daysLeft(a.id);
      }
      this.views.set(a.id, view);
    } catch (e) {
      if (!this.accounts.includes(a)) return;
      const kind = e instanceof ProviderError ? e.kind : 'network';
      const message = e instanceof ProviderError ? e.message : 'Unexpected error';
      // Keep the last good reading visible (dimmed by the UI) next to the error.
      this.views.set(a.id, { ...prev, status: 'error', error: { kind, message } });
    }
    this.updatedAt = Date.now();
    this.emit('change');
  }

  snapshot() {
    const accounts = [...this.views.values()].map((v) => ({ ...v, urgency: urgencyOf(v) }));
    return { accounts: applyOrder(accounts, this.order), updatedAt: this.updatedAt, level: trayLevel(accounts), manualOrder: !!(this.order && this.order.length) };
  }
}

module.exports = { Poller, urgencyOf, viewLevel, trayLevel, applyOrder };
