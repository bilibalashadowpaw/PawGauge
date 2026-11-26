'use strict';
// The one definition of "how worried to look", shared by the main process (tray icon, ShadowBlack's mood) and the page
// (meters, the pill). Loaded with require() in main and with a <script> tag in the page.
(function (root) {
  const WARN_USED = 90; // orange at 90% used
  const CRIT_USED = 100; // red when it is all gone
  const LOW_DAYS = 3; // a prepaid balance with under this many days left counts as low

  /** 'ok' | 'warn' | 'crit' for a percentage USED. */
  const levelOfUsed = (used) => (used >= CRIT_USED ? 'crit' : used >= WARN_USED ? 'warn' : 'ok');

  const api = { WARN_USED, CRIT_USED, LOW_DAYS, levelOfUsed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LEVELS = api;
})(this);
