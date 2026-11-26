'use strict';
// Providers are code, accounts are data. One entry per provider; any number of accounts can use it.
// url: the provider's own usage/billing page, opened by the link icon on each account.
// To add a service: write a module exporting fetchUsage(account, key) and register it here.
// domains: the only domains (and their subdomains) whose key may be sent to this provider. Match whole domains, never a
// word inside a host name: a relay called "deepseek.example" holds its own key, which must not reach DeepSeek.
// unsupportedDomains: the same service in another region. Its keys belong to servers PawGauge does not call yet.
const providers = {
  anthropic: { name: 'Claude', monogram: 'C', url: 'https://claude.ai/settings/usage', needsKey: false, intervalMs: 20_000, ...require('./anthropic') },
  zai: { name: 'z.ai', monogram: 'Z', url: 'https://z.ai/manage-apikey/subscription', needsKey: true, intervalMs: 180_000, domains: ['z.ai'], unsupportedDomains: ['bigmodel.cn'], ...require('./zai') },
  minimax: { name: 'MiniMax', monogram: 'M', url: 'https://platform.minimax.io/user-center/payment/token-plan', needsKey: true, intervalMs: 180_000, domains: ['minimax.io'], unsupportedDomains: ['minimaxi.com', 'minimax.cn'], ...require('./minimax') },
  deepseek: { name: 'DeepSeek', monogram: 'D', url: 'https://platform.deepseek.com/usage', needsKey: true, intervalMs: 300_000, domains: ['deepseek.com'], ...require('./deepseek') },
};

const within = (host, domains = []) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** { provider, supported } for a base URL's host name, or null for a host no provider owns. */
function classifyHost(hostName) {
  const host = String(hostName).toLowerCase().replace(/\.$/, '');
  for (const [id, p] of Object.entries(providers)) {
    if (within(host, p.domains)) return { provider: id, supported: true };
    if (within(host, p.unsupportedDomains)) return { provider: id, supported: false };
  }
  return null;
}

module.exports = { providers, classifyHost };
