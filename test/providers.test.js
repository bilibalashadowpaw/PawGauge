'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
test.afterEach(() => { global.fetch = realFetch; });

const zai = require('../src/main/providers/zai');
const minimax = require('../src/main/providers/minimax');
const deepseek = require('../src/main/providers/deepseek');

const rejects = (p, kind) => assert.rejects(p, (e) => e.kind === kind);

test('z.ai: currentValue is USED, usage is the LIMIT; windows sorted 5h then week', async () => {
  global.fetch = reply(200, { success: true, data: { level: 'pro', limits: [
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 1000, currentValue: 250, nextResetTime: 5 },
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 40, nextResetTime: 3 },
  ] } });
  const r = await zai.fetchUsage({}, 'k');
  assert.deepEqual(r.windows.map((w) => [w.label, w.remainingPct]), [['5h', 60], ['Week', 75]]);
  assert.equal(r.plan, 'Pro');
});

test('z.ai: bad shapes and auth map to typed errors', async () => {
  global.fetch = reply(200, { data: {} });
  await rejects(zai.fetchUsage({}, 'k'), 'shape');
  global.fetch = reply(401, {});
  await rejects(zai.fetchUsage({}, 'k'), 'auth');
  global.fetch = reply(200, 'not json');
  await rejects(zai.fetchUsage({}, 'k'), 'shape');
  global.fetch = reply(302, {});
  await rejects(zai.fetchUsage({}, 'k'), 'http');
});

test('MiniMax: general model is main, others are minor; empty is a shape error', async () => {
  const H = 3600000;
  global.fetch = reply(200, { base_resp: { status_code: 0 }, model_remains: [
    { model_name: 'general', start_time: 0, end_time: 5 * H, current_interval_remaining_percent: 70, current_weekly_remaining_percent: 90, weekly_end_time: 9 },
    { model_name: 'video', start_time: 0, end_time: 24 * H, current_interval_remaining_percent: 50 },
  ] });
  const r = await minimax.fetchUsage({}, 'k');
  assert.deepEqual(r.windows.map((w) => [w.label, !!w.minor]), [['5h', false], ['video Day', true], ['Week', false]]);
  global.fetch = reply(200, { base_resp: { status_code: 0 }, model_remains: [] });
  await rejects(minimax.fetchUsage({}, 'k'), 'shape');
});

test('DeepSeek: string or number balances, picks the funded currency', async () => {
  global.fetch = reply(200, { is_available: true, balance_infos: [
    { currency: 'USD', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' },
    { currency: 'CNY', total_balance: '12.5', granted_balance: '2.5', topped_up_balance: 10 },
  ] });
  const r = await deepseek.fetchUsage({}, 'k');
  assert.equal(r.balance.currency, 'CNY');
  assert.equal(r.balance.total, 12.5);
  assert.equal(r.balance.available, true);
  global.fetch = reply(200, { balance_infos: [] });
  await rejects(deepseek.fetchUsage({}, 'k'), 'shape');
});
