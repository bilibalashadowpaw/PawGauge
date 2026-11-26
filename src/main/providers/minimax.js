'use strict';
// MiniMax Token Plan. Undocumented endpoint, verified by probe on 2026-11-20.
// The *_total_count / *_usage_count fields came back 0, so only the *_remaining_percent fields are used.
// Times are epoch milliseconds.
const { ProviderError, getJson, clampPct } = require('./util');

const URL = 'https://api.minimax.io/v1/token_plan/remains';

function intervalLabel(m) {
  const hours = Math.round((m.end_time - m.start_time) / 3600000);
  if (hours === 5) return { label: '5h', order: 5 };
  if (hours === 24) return { label: 'Day', order: 24 };
  return { label: `${hours}h`, order: hours };
}

async function fetchUsage(_account, key) {
  const body = await getJson(URL, key);
  const base = body && body.base_resp;
  if (base && base.status_code !== 0) throw new ProviderError('shape', String(base.status_msg || 'Request failed').slice(0, 80));
  const models = body && body.model_remains;
  if (!Array.isArray(models)) throw new ProviderError('shape', 'Unexpected response');

  const windows = [];
  for (const m of models) {
    const primary = m.model_name === 'general';
    const prefix = primary ? '' : `${m.model_name} `;
    const iv = intervalLabel(m);
    if (typeof m.current_interval_remaining_percent === 'number') {
      windows.push({
        id: `${m.model_name}-interval`,
        label: prefix + iv.label,
        order: (primary ? 0 : 100) + iv.order,
        minor: !primary,
        remainingPct: clampPct(m.current_interval_remaining_percent),
        resetsAt: typeof m.end_time === 'number' ? m.end_time : null,
        detail: null,
      });
    }
    if (typeof m.current_weekly_remaining_percent === 'number') {
      windows.push({
        id: `${m.model_name}-week`,
        label: prefix + 'Week',
        order: (primary ? 0 : 100) + 1000,
        minor: !primary,
        remainingPct: clampPct(m.current_weekly_remaining_percent),
        resetsAt: typeof m.weekly_end_time === 'number' ? m.weekly_end_time : null,
        detail: null,
      });
    }
  }
  if (!windows.length) throw new ProviderError('shape', 'No quota windows in response');
  windows.sort((a, b) => a.order - b.order);
  return { kind: 'windows', plan: null, windows };
}

module.exports = { fetchUsage };
