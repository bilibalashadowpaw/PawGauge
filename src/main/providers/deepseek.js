'use strict';
// DeepSeek: pay-as-you-go balance (documented endpoint). No windows, just money left.
// Balances arrive as strings in one doc version and numbers in another, so both are accepted.
const { ProviderError, getJson } = require('./util');

const URL = 'https://api.deepseek.com/user/balance';

async function fetchUsage(_account, key) {
  const body = await getJson(URL, key);
  const infos = body && body.balance_infos;
  if (!Array.isArray(infos)) throw new ProviderError('shape', 'Unexpected response');

  const rows = infos.map((i) => ({
    currency: String(i.currency || ''),
    total: Number(i.total_balance),
    granted: Number(i.granted_balance),
    toppedUp: Number(i.topped_up_balance),
  }));
  // Show the currency that actually holds money; fall back to the first row.
  const primary = rows.find((r) => r.total > 0) || rows[0];
  if (!primary || Number.isNaN(primary.total)) throw new ProviderError('shape', 'No balance in response');

  return {
    kind: 'balance',
    plan: null,
    balance: {
      currency: primary.currency,
      total: primary.total,
      granted: primary.granted,
      toppedUp: primary.toppedUp,
      available: body.is_available !== false && primary.total > 0,
    },
  };
}

module.exports = { fetchUsage };
