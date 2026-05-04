/* ═══════════════════════════════════════════════════════════════
   Instance-color helpers for the session indicator.
   Pure functions over tab data; no DOM dependencies.
   Loaded as a browser <script> AND requireable from Node tests.
   SPDX-License-Identifier: AGPL-3.0-only
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InstanceColors = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAB_COLORS = ['red', 'yellow', 'green', 'teal', 'blue', 'mauve'];

  /**
   * Return one entry per place sessionId is currently open across all tab groups.
   * @param {string} sessionId
   * @param {Array<{id:string, panes:Array<{slot:number,sessionId:string}>}>} tabGroups
   * @returns {Array<{tabId:string, slot:number}>}
   */
  function getSessionInstances(sessionId, tabGroups) {
    const out = [];
    if (!sessionId || !Array.isArray(tabGroups)) return out;
    for (const tab of tabGroups) {
      const panes = (tab && tab.panes) || [];
      for (const p of panes) {
        if (p && p.sessionId === sessionId) {
          out.push({ tabId: tab.id, slot: p.slot });
        }
      }
    }
    return out;
  }

  /**
   * Return the tab's positional colour. Index is the tab's global position
   * across all tab groups (regardless of folder), wrapping modulo the palette.
   */
  function getTabColor(tabId, tabGroups) {
    const idx = (tabGroups || []).findIndex(g => g.id === tabId);
    return TAB_COLORS[(idx >= 0 ? idx : 0) % TAB_COLORS.length];
  }

  return { TAB_COLORS, getSessionInstances, getTabColor };
});
