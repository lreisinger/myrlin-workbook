'use strict';

/**
 * Git Manager - wraps simple-git for use in API endpoints.
 *
 * All functions accept a workingDir string and perform git operations
 * scoped to that directory. path.resolve() is used to prevent traversal.
 */

const { simpleGit } = require('simple-git');
const path = require('path');

/**
 * Resolve and validate the working directory for git operations.
 * @param {string} workingDir - The workspace working directory
 * @returns {string} The resolved absolute path
 */
function resolveGitDir(workingDir) {
  if (!workingDir || typeof workingDir !== 'string') {
    throw new Error('workingDir is required');
  }
  return path.resolve(workingDir);
}

/**
 * Get the current git status for a working directory.
 * Returns branch name, staged/modified/untracked/deleted files.
 * @param {string} workingDir - Workspace root directory
 * @returns {Promise<object>} Status object with branch and file lists
 */
async function getStatus(workingDir) {
  const git = simpleGit(resolveGitDir(workingDir));
  const status = await git.status();
  return {
    branch: status.current,
    staged: status.staged.map(f => ({ file: f, state: 'staged' })),
    modified: status.modified.map(f => ({ file: f, state: 'modified' })),
    notAdded: status.not_added.map(f => ({ file: f, state: 'untracked' })),
    deleted: status.deleted.map(f => ({ file: f, state: 'deleted' })),
    isClean: status.isClean(),
  };
}

/**
 * Get the commit log for a working directory.
 * @param {string} workingDir - Workspace root directory
 * @param {number} [limit=20] - Maximum number of commits to return (capped at 100)
 * @returns {Promise<Array>} Array of commit objects with hash, author, date, message
 */
async function getLog(workingDir, limit = 20) {
  const git = simpleGit(resolveGitDir(workingDir));
  try {
    const log = await git.log({ maxCount: Math.min(parseInt(limit, 10) || 20, 100) });
    return (log.all || []).map(c => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      author: c.author_name,
      date: c.date,
      message: c.message,
    }));
  } catch (e) {
    // Fresh repo with no commits yet
    if (e.message && e.message.includes('does not have any commits')) return [];
    throw e;
  }
}

/**
 * Get the diff for a specific file in the working directory.
 * @param {string} workingDir - Workspace root directory
 * @param {string} file - File path relative to workingDir
 * @param {boolean} [staged=false] - Whether to show staged diff (vs unstaged)
 * @returns {Promise<string>} The unified diff output
 */
async function getDiff(workingDir, file, staged = false) {
  const git = simpleGit(resolveGitDir(workingDir));
  let diff;
  if (staged) {
    diff = await git.diff(['--cached', '--', file]);
  } else {
    diff = await git.diff(['--', file]);
  }
  return diff || '';
}

/**
 * Get branch information for a working directory.
 * @param {string} workingDir - Workspace root directory
 * @returns {Promise<{current: string, all: string[]}>} Current branch and all branch names
 */
async function getBranches(workingDir) {
  const git = simpleGit(resolveGitDir(workingDir));
  const result = await git.branch(['-a']);
  return {
    current: result.current,
    all: result.all,
  };
}

module.exports = { getStatus, getLog, getDiff, getBranches };
