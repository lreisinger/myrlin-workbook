'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Map of file extensions to CodeMirror language names.
 */
const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript',
  json: 'json',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  sh: 'shell', bash: 'shell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  xml: 'xml',
  txt: 'text',
};

/**
 * Directory names to skip when building the file tree.
 * Prevents traversal into version control internals and build artifacts.
 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.DS_Store', '__pycache__',
  '.next', 'dist', 'build', '.cache',
]);

/**
 * Validate that the resolved target path stays within root.
 * Throws if path traversal is detected.
 *
 * @param {string} root - Absolute workspace root path
 * @param {string} relPath - Relative path from client
 * @returns {string} Resolved absolute path
 */
function validatePath(root, relPath) {
  if (!root || typeof root !== 'string') throw new Error('root is required');
  const resolved = path.resolve(root, relPath || '');
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * GET /api/files/tree
 * Returns directory entries (dirs and files) for a given subpath within the
 * workspace root. Skips .git, node_modules, and other build artifacts.
 *
 * @param {string} workingDir - Workspace root directory
 * @param {string} [subpath=''] - Relative subpath to list
 * @returns {Promise<{path: string, entries: Array}>}
 */
async function getTree(workingDir, subpath = '') {
  const root = path.resolve(workingDir);
  const target = validatePath(root, subpath);

  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // Skip hidden files/dirs (dot-files) at root level
    if (subpath === '' && entry.name.startsWith('.')) continue;
    const relPath = subpath ? path.join(subpath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path: relPath, type: 'dir' });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      result.push({ name: entry.name, path: relPath, type: 'file', ext });
    }
  }

  // Sort: directories first, then files, each group sorted alphabetically
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: subpath || '/', entries: result };
}

/**
 * GET /api/files/content
 * Returns file content as UTF-8 text with a language hint for CodeMirror.
 * Rejects files larger than 1MB.
 *
 * @param {string} workingDir - Workspace root directory
 * @param {string} file - Relative path to the file
 * @returns {Promise<{content: string, language: string, size: number, path: string}>}
 */
async function getContent(workingDir, file) {
  if (!file) throw new Error('file is required');
  const root = path.resolve(workingDir);
  const target = validatePath(root, file);

  const stat = await fs.promises.stat(target);
  if (stat.size > 1024 * 1024) throw new Error('File too large (> 1MB)');

  const content = await fs.promises.readFile(target, 'utf8');
  const ext = path.extname(file).slice(1).toLowerCase();
  return {
    content,
    language: EXT_TO_LANG[ext] || 'text',
    size: stat.size,
    path: file,
  };
}

/**
 * POST /api/files/save
 * Atomically writes file content by writing to a temp file then renaming.
 * Creates parent directories if they don't exist.
 *
 * @param {string} workingDir - Workspace root directory
 * @param {string} file - Relative path to the file
 * @param {string} content - UTF-8 text content to write
 * @returns {Promise<{ok: boolean}>}
 */
async function saveContent(workingDir, file, content) {
  if (!file) throw new Error('file is required');
  if (typeof content !== 'string') throw new Error('content must be a string');
  const root = path.resolve(workingDir);
  const target = validatePath(root, file);

  // Ensure parent directory exists
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  // Atomic write: write to temp file then rename into place
  const tmp = target + '.tmp.' + Date.now();
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, target);

  return { ok: true };
}

module.exports = { getTree, getContent, saveContent };
