'use strict';

class ProviderError extends Error {
  /** kind: 'auth' | 'network' | 'http' | 'shape' | 'nokey' | 'moved' | 'region' */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function getJson(url, key) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'PawGauge/0.1',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'manual', // a quota endpoint never needs to redirect; never follow one, so the key can never be sent elsewhere
    });
  } catch (e) {
    throw new ProviderError('network', e && e.name === 'TimeoutError' ? 'Timed out' : 'Network unreachable');
  }
  if (res.status >= 300 && res.status < 400) throw new ProviderError('http', 'Unexpected redirect');
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `Key rejected (${res.status})`);
  if (!res.ok) throw new ProviderError('http', `Provider returned ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('shape', 'Unexpected response');
  }
}

const clampPct = (n) => Math.max(0, Math.min(100, n));

module.exports = { ProviderError, getJson, clampPct };
