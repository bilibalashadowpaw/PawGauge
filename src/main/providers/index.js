'use strict';
// Providers are code, accounts are data. One entry per provider; any number of accounts can use it.
// url: the provider's own usage/billing page, opened by the link icon on each account.
// To add a service: write a module exporting fetchUsage(account, key) and register it here.
const providers = {
  anthropic: { name: 'Claude', monogram: 'C', url: 'https://claude.ai/settings/usage', needsKey: false, intervalMs: 20_000, ...require('./anthropic') },
  zai: { name: 'z.ai', monogram: 'Z', url: 'https://z.ai/manage-apikey/subscription', needsKey: true, intervalMs: 180_000, host: /(^|\.)z\.ai$/, ...require('./zai') },
  minimax: { name: 'MiniMax', monogram: 'M', url: 'https://platform.minimax.io/user-center/payment/token-plan', needsKey: true, intervalMs: 180_000, host: /minimax/, ...require('./minimax') },
  deepseek: { name: 'DeepSeek', monogram: 'D', url: 'https://platform.deepseek.com/usage', needsKey: true, intervalMs: 300_000, host: /deepseek/, ...require('./deepseek') },
};

function providerForHost(host) {
  for (const [id, p] of Object.entries(providers)) if (p.host && p.host.test(host)) return id;
  return null;
}

module.exports = { providers, providerForHost };
