/**
 * td CLI Adapter
 *
 * Wraps the `td` task management CLI (github.com/marcus/td) for use in Myrlin Workbook.
 * All commands are run in the context of a specific repo directory (cwd), where td
 * stores its database at .todos/db.sqlite.
 *
 * Output format: td supports --json on most commands. We use JSON output wherever
 * available for reliable parsing, falling back to stdout text parsing where needed.
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execFileAsync = promisify(execFile);

// Default binary name; can be overridden via env or settings
const DEFAULT_TD_BINARY = process.env.TD_BINARY || 'td';

/**
 * Run a td command in the given working directory.
 * @param {string} binary - path or name of the td binary
 * @param {string[]} args
 * @param {string} cwd - repo directory (where .todos/ lives)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runTd(binary, args, cwd) {
  return execFileAsync(binary, args, { cwd, timeout: 15000 });
}

/**
 * Check whether the td binary is installed and runnable.
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<boolean>}
 */
async function isAvailable(binary = DEFAULT_TD_BINARY) {
  try {
    await execFileAsync(binary, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether td has been initialised in a given directory.
 * (Presence of .todos/ directory is the indicator.)
 * @param {string} cwd
 * @returns {boolean}
 */
function isInitialized(cwd) {
  return fs.existsSync(path.join(cwd, '.todos'));
}

/**
 * Run `td init` in cwd to create the .todos/ database.
 * @param {string} cwd
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<string>} stdout output
 */
async function init(cwd, binary = DEFAULT_TD_BINARY) {
  const { stdout } = await runTd(binary, ['init'], cwd);
  return stdout.trim();
}

/**
 * List td issues, optionally filtered by status.
 * Uses --json flag for reliable parsing.
 *
 * @param {string} cwd
 * @param {Object} [filters]
 * @param {string} [filters.status] - 'open' | 'in_progress' | 'in_review' | 'blocked' | 'closed'
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<Array<{id:string, title:string, status:string, type:string, priority:string}>>}
 */
async function listIssues(cwd, filters = {}, binary = DEFAULT_TD_BINARY) {
  const args = ['list', '--json'];
  if (filters.status) args.push('--status', filters.status);
  const { stdout } = await runTd(binary, args, cwd);
  const parsed = JSON.parse(stdout);
  // td --json returns either an array, { issues: [...] }, or null (empty repo)
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : (parsed.issues || []);
}

/**
 * Create a new td issue.
 * @param {string} cwd
 * @param {string} title
 * @param {Object} [opts]
 * @param {string} [opts.type='task'] - 'task' | 'feature' | 'bug'
 * @param {string} [opts.priority] - 'P1' | 'P2' | 'P3'
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<string>} The new issue ID (e.g. 'td-5q')
 */
async function createIssue(cwd, title, opts = {}, binary = DEFAULT_TD_BINARY) {
  const args = ['create', title];
  if (opts.type) args.push('--type', opts.type);
  if (opts.priority) args.push('--priority', opts.priority);
  const { stdout } = await runTd(binary, args, cwd);
  // Output: "CREATED: td-5q\nTitle: ..."
  const match = stdout.match(/CREATED:\s*(\S+)/i);
  if (!match) throw new Error(`td create returned unexpected output: ${stdout.trim()}`);
  return match[1];
}

/**
 * Get full details for a single issue, including handoff history and log.
 * @param {string} cwd
 * @param {string} issueId
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<Object>} Parsed issue object
 */
async function showIssue(cwd, issueId, binary = DEFAULT_TD_BINARY) {
  try {
    const { stdout } = await runTd(binary, ['show', issueId, '--json'], cwd);
    return JSON.parse(stdout);
  } catch {
    // Fall back to non-JSON show for display purposes
    const { stdout } = await runTd(binary, ['show', issueId], cwd);
    return { id: issueId, raw: stdout.trim() };
  }
}

/**
 * Get rich context for an issue (decisions, handoffs, file list).
 * Returns plain text suitable for pre-populating a worktree task description.
 * @param {string} cwd
 * @param {string} issueId
 * @param {string} [binary=DEFAULT_TD_BINARY]
 * @returns {Promise<string>}
 */
async function getContext(cwd, issueId, binary = DEFAULT_TD_BINARY) {
  const { stdout } = await runTd(binary, ['context', issueId], cwd);
  return stdout.trim();
}

/**
 * Delete a td issue.
 * @param {string} cwd
 * @param {string} issueId
 * @param {string} [binary=DEFAULT_TD_BINARY]
 */
async function deleteIssue(cwd, issueId, binary = DEFAULT_TD_BINARY) {
  await runTd(binary, ['delete', issueId], cwd);
}

/**
 * Mark a td issue as started (in_progress).
 * Called when a worktree task is created from a td issue.
 * @param {string} cwd
 * @param {string} issueId
 * @param {string} [binary=DEFAULT_TD_BINARY]
 */
async function startIssue(cwd, issueId, binary = DEFAULT_TD_BINARY) {
  await runTd(binary, ['start', issueId], cwd);
}

/**
 * Log a progress entry on a td issue.
 * @param {string} cwd
 * @param {string} message
 * @param {Object} [opts]
 * @param {boolean} [opts.decision] - Log as a decision
 * @param {boolean} [opts.blocker] - Log as a blocker
 * @param {string} [binary=DEFAULT_TD_BINARY]
 */
async function logProgress(cwd, message, opts = {}, binary = DEFAULT_TD_BINARY) {
  const args = ['log'];
  if (opts.decision) args.push('--decision');
  if (opts.blocker) args.push('--blocker');
  args.push(message);
  await runTd(binary, args, cwd);
}

module.exports = {
  DEFAULT_TD_BINARY,
  isAvailable,
  isInitialized,
  init,
  listIssues,
  createIssue,
  showIssue,
  getContext,
  deleteIssue,
  startIssue,
  logProgress,
};
