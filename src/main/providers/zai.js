'use strict';
// z.ai Coding Plan. Undocumented endpoint, verified by probe on 2026-11-20.
// Field names are misleading: `usage` is the LIMIT, `currentValue` is what has been USED.
// unit 3 = hours, unit 6 = weeks (inferred from reset times, matches the 5h + weekly plan windows).
const { ProviderError, getJson, clampPct } = require('./util');

const URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

function windowFor(limit) {
  const { unit, number, type } = limit;
  if (type === 'CREDIT_LIMIT') {
    if (unit === 3) return { id: `${number}h`, label: `${number}h`, order: number };
    if (unit === 6) return { id: number === 1 ? 'week' : `${number}w`, label: number === 1 ? 'Week' : `${number}w`, order: 1000 * number };
  }
  const name = String(type || 'Limit').replace(/_LIMIT$/, '').toLowerCase();
  return { id: `${type}-${unit}-${number}`, label: name.charAt(0).toUpperCase() + name.slice(1), order: 5000 };
}

async function fetchUsage(_account, key) {
  const body = await getJson(URL, key);
  if (body.success === false) throw new ProviderError('shape', String(body.msg || 'Request failed').slice(0, 80));
  const limits = body && body.data && body.data.limits;
  if (!Array.isArray(limits)) throw new ProviderError('shape', 'Unexpected response');

  const windows = limits.map((l) => {
    const w = windowFor(l);
    const used =
      typeof l.usage === 'number' && l.usage > 0 && typeof l.currentValue === 'number'
        ? (l.currentValue / l.usage) * 100
        : typeof l.percentage === 'number'
          ? l.percentage
          : 0;
    return {
      id: w.id,
      label: w.label,
      order: w.order,
      remainingPct: clampPct(100 - used),
      resetsAt: typeof l.nextResetTime === 'number' ? l.nextResetTime : null,
      detail:
        typeof l.currentValue === 'number' && typeof l.usage === 'number'
          ? `${l.currentValue.toLocaleString('en-US')} of ${l.usage.toLocaleString('en-US')} used`
          : null,
    };
  });
  windows.sort((a, b) => a.order - b.order);

  const level = body.data.level ? String(body.data.level) : null;
  return { kind: 'windows', plan: level ? level.charAt(0).toUpperCase() + level.slice(1) : null, windows };
}

module.exports = { fetchUsage };
