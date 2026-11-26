'use strict';
// Fixture state for `npm start -- --demo` and screenshot checks. Never touches the network or any key.
const { urgencyOf, trayLevel } = require('./poller');

function demoState(now = Date.now()) {
  const h = 3600 * 1000;
  const base = (o) => ({
    sourceName: null, plan: null, windows: [], balance: null, daysLeft: null,
    fetchedAt: now, readingAt: null, error: null, kind: 'windows', status: 'ok', ...o,
  });
  const accounts = [
    base({
      id: 'zai-1', provider: 'zai', label: 'z.ai · zai-1', providerName: 'z.ai', monogram: 'Z', plan: 'Max',
      windows: [
        { id: '5h', label: '5h', remainingPct: 85, resetsAt: now + 1.1 * h, detail: '4,200 of 28,000 used' },
        { id: 'week', label: 'Week', remainingPct: 6, resetsAt: now + 92 * h, detail: '131,600 of 140,000 used' },
      ],
    }),
    base({
      id: 'deepseek-2', provider: 'deepseek', label: 'DeepSeek · deepseek-2', providerName: 'DeepSeek', monogram: 'D',
      sourceName: 'settings.deepseek-2.json', status: 'error', error: { kind: 'auth', message: 'Key rejected (401)' },
    }),
    base({
      id: 'claude', provider: 'anthropic', label: 'Claude', providerName: 'Claude', monogram: 'C',
      readingAt: now - 4 * 60 * 1000,
      windows: [
        { id: '5h', label: '5h', remainingPct: 62, resetsAt: now + 2.4 * h, detail: null },
        { id: 'week', label: 'Week', remainingPct: 91, resetsAt: now + 140 * h, detail: null },
      ],
    }),
    base({
      id: 'minimax', provider: 'minimax', label: 'MiniMax', providerName: 'MiniMax', monogram: 'M',
      windows: [
        { id: 'general-interval', label: '5h', remainingPct: 98, resetsAt: now + 0.4 * h, detail: null },
        { id: 'general-week', label: 'Week', remainingPct: 100, resetsAt: now + 67 * h, detail: null },
        { id: 'video-interval', label: 'video Day', minor: true, remainingPct: 100, resetsAt: now + 19 * h, detail: null },
        { id: 'video-week', label: 'video Week', minor: true, remainingPct: 100, resetsAt: now + 67 * h, detail: null },
      ],
    }),
    base({
      id: 'zai-2', provider: 'zai', label: 'z.ai · zai-2', providerName: 'z.ai', monogram: 'Z', plan: 'Pro',
      windows: [
        { id: '5h', label: '5h', remainingPct: 100, resetsAt: null, detail: null },
        { id: 'week', label: 'Week', remainingPct: 100, resetsAt: now + 120 * h, detail: null },
      ],
    }),
    base({
      id: 'deepseek-1', provider: 'deepseek', label: 'DeepSeek · deepseek-1', providerName: 'DeepSeek', monogram: 'D',
      kind: 'balance', balance: { currency: 'CNY', total: 50.00, granted: 0, toppedUp: 50.00, available: true }, daysLeft: 12.4,
    }),
  ].map((a) => ({ ...a, urgency: urgencyOf(a) }));
  return { accounts, updatedAt: now, level: trayLevel(accounts) };
}

module.exports = { demoState };
