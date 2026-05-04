#!/usr/bin/env node
/**
 * Unit tests for instance-colors UMD module.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const path = require('path');
const {
  TAB_COLORS,
  getSessionInstances,
  getTabColor,
} = require(path.join(__dirname, '..', 'src', 'web', 'public', 'instance-colors.js'));

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else    { failed++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Fixture — folderIds preserved on tabs to confirm they don't influence tab color.
const tabs = [
  { id: 't1', name: 'Main',    folderId: 'f1', panes: [
    { slot: 0, sessionId: 'sA' }, { slot: 1, sessionId: 'sB' },
  ]},
  { id: 't2', name: 'Logs',    folderId: 'f1', panes: [
    { slot: 0, sessionId: 'sA' },
  ]},
  { id: 't3', name: 'Sandbox', folderId: 'f2', panes: [
    { slot: 0, sessionId: 'sA' },
  ]},
  { id: 't4', name: 'Loose',   folderId: null, panes: [
    { slot: 2, sessionId: 'sA' },
  ]},
  { id: 't5', name: 'Other',   folderId: null, panes: [] },
];

// 1. TAB_COLORS contract
check('TAB_COLORS has 6 distinct entries',
  TAB_COLORS.length === 6 && new Set(TAB_COLORS).size === 6);

// 2. getSessionInstances finds all instances across all tabs
const instances = getSessionInstances('sA', tabs);
check('getSessionInstances returns 4 entries for sA',
  instances.length === 4,
  'got ' + instances.length);
check('getSessionInstances entries carry tabId and slot only',
  instances.every(i => 'tabId' in i && 'slot' in i && !('folderId' in i)));
check('getSessionInstances finds the ungrouped tab too',
  instances.some(i => i.tabId === 't4' && i.slot === 2));
check('getSessionInstances returns empty for unknown session',
  eq(getSessionInstances('nope', tabs), []));

// 3. getTabColor: GLOBAL positional index across all tabs (folder is irrelevant)
// Global order: [t1, t2, t3, t4, t5] -> red, yellow, green, teal, blue
check('getTabColor t1 (global index 0)', getTabColor('t1', tabs) === 'red');
check('getTabColor t2 (global index 1)', getTabColor('t2', tabs) === 'yellow');
check('getTabColor t3 (global index 2)', getTabColor('t3', tabs) === 'green');
check('getTabColor t4 (global index 3)', getTabColor('t4', tabs) === 'teal');
check('getTabColor t5 (global index 4)', getTabColor('t5', tabs) === 'blue');

// 4. Modulo wraparound at the global level
const longTabs = Array.from({ length: 8 }, (_, i) => ({
  id: 'tw' + i, name: 'T' + i, folderId: null, panes: [],
}));
check('getTabColor wraps at global index 6', getTabColor('tw6', longTabs) === 'red');
check('getTabColor wraps at global index 7', getTabColor('tw7', longTabs) === 'yellow');

// 5. Unknown tab falls back to first colour
check('getTabColor unknown tab falls back to first colour',
  getTabColor('nope', tabs) === 'red');

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed)');
process.exit(failed === 0 ? 0 : 1);
