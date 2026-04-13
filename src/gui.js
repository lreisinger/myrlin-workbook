#!/usr/bin/env node
/**
 * Claude Workspace Manager - GUI Entry Point
 *
 * Starts the Express web server and opens the browser.
 * Use --demo to seed sample workspaces and sessions on first run.
 *
 * Usage:
 *   node src/gui.js           Launch the web GUI
 *   node src/gui.js --demo    Launch with demo data (if store is empty)
 *
 * Environment:
 *   PORT=3456                 Override the default port
 */

// ─── EPIPE Protection ─────────────────────────────────────
// When the parent process (e.g. a shell or pipe) disappears, writes to
// stdout/stderr throw EPIPE. Without this handler, EPIPE becomes an
// uncaughtException, and the exception handler's console.error() throws
// another EPIPE, creating an infinite cascade that kills the server.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const { getStore } = require('./state/store');
const { startServer, getPtyManager } = require('./web/server');
const { backupFrontend } = require('./web/backup');
const { generateStartupToken } = require('./web/auth');

// ─── Initialize Store ──────────────────────────────────────

const store = getStore();

// ─── Demo Data Seeding ─────────────────────────────────────

if (process.argv.includes('--demo')) {
  // Only seed if there are no existing workspaces
  if (store.getAllWorkspacesList().length === 0) {
    const ws1 = store.createWorkspace({
      name: 'Project Alpha',
      description: 'Frontend application',
    });
    const ws2 = store.createWorkspace({
      name: 'Backend API',
      description: 'Backend services',
    });
    const ws3 = store.createWorkspace({
      name: 'Documentation',
      description: 'Docs & guides',
    });

    // Use platform-appropriate demo paths (PTY manager validates and falls back to homedir)
    const path = require('path');
    const home = require('os').homedir();
    const demoBase = path.join(home, 'Projects');

    store.createSession({
      name: 'ui-components',
      workspaceId: ws1.id,
      workingDir: path.join(demoBase, 'project-alpha'),
      topic: 'React components',
    });
    store.createSession({
      name: 'state-mgmt',
      workspaceId: ws1.id,
      workingDir: path.join(demoBase, 'project-alpha', 'state'),
      topic: 'State management',
    });
    store.createSession({
      name: 'api-routes',
      workspaceId: ws2.id,
      workingDir: path.join(demoBase, 'backend-api'),
      topic: 'REST endpoints',
    });
    store.createSession({
      name: 'db-migrations',
      workspaceId: ws2.id,
      workingDir: path.join(demoBase, 'backend-api', 'db'),
      topic: 'Database schema',
    });
    store.createSession({
      name: 'readme-update',
      workspaceId: ws3.id,
      workingDir: path.join(demoBase, 'docs'),
      topic: 'README overhaul',
    });
    store.createSession({
      name: 'api-docs',
      workspaceId: ws3.id,
      workingDir: path.join(demoBase, 'docs', 'api'),
      topic: 'API reference',
    });

    store.save();
    console.log('Demo data seeded.');
  }
}

// ─── Start Server ──────────────────────────────────────────

const port = parseInt(process.env.PORT, 10) || 3456;
const host = process.env.CWM_HOST || '127.0.0.1';
const server = startServer(port, host);

const startupToken = generateStartupToken();
const authUrl = `http://${host}:${port}?token=${encodeURIComponent(startupToken)}`;
console.log(`CWM GUI running at ${authUrl}`);
console.log('Press Ctrl+C to stop.');

// Snapshot frontend files as "last known good" on successful start
backupFrontend();

// ─── Open Browser ────────────────────────────────────────────
// Skip auto-open when running headless (e.g., marketing capture pipeline)
// --cdp flag launches browser with Chrome DevTools Protocol remote debugging
// so the visual-qa MCP server can screenshot and inspect the UI.

/**
 * Open a URL in the default browser, cross-platform.
 * Windows: 'start', macOS: 'open', Linux/WSL: 'xdg-open'.
 * @param {string} url - The URL to open
 * @param {Function} [callback] - Optional error callback
 */
function openBrowser(url, callback) {
  const { exec } = require('child_process');
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err && callback) callback(err);
    else if (err) console.log(`Could not auto-open browser. Visit ${url} manually.`);
  });
}

/**
 * Launch a specific browser with CDP remote debugging enabled, cross-platform.
 * Tries Chrome first, then Edge (Windows) / Chromium (Linux), then falls back to default browser.
 * @param {string} url - The URL to open
 * @param {number} cdpPort - Chrome DevTools Protocol debugging port
 */
function openBrowserWithCDP(url, cdpPort) {
  const { exec } = require('child_process');
  const platform = process.platform;

  // Platform-specific browser launch commands for CDP
  const attempts = [];
  if (platform === 'win32') {
    attempts.push(`start "" chrome --remote-debugging-port=${cdpPort} "${url}"`);
    attempts.push(`start "" msedge --remote-debugging-port=${cdpPort} "${url}"`);
  } else if (platform === 'darwin') {
    attempts.push(`open -a "Google Chrome" "${url}" --args --remote-debugging-port=${cdpPort}`);
    attempts.push(`open -a "Chromium" "${url}" --args --remote-debugging-port=${cdpPort}`);
  } else {
    attempts.push(`google-chrome --remote-debugging-port=${cdpPort} "${url}"`);
    attempts.push(`chromium-browser --remote-debugging-port=${cdpPort} "${url}"`);
    attempts.push(`chromium --remote-debugging-port=${cdpPort} "${url}"`);
  }

  // Try each in sequence, fall back to default browser if all fail
  function tryNext(index) {
    if (index >= attempts.length) {
      console.log(`Could not launch browser with CDP. Open manually with --remote-debugging-port=${cdpPort}`);
      openBrowser(url);
      return;
    }
    exec(attempts[index], (err) => {
      if (err) tryNext(index + 1);
    });
  }
  tryNext(0);
}

if (!process.env.CWM_NO_OPEN) {
  const cdpEnabled = process.argv.includes('--cdp');
  const cdpPort = parseInt(process.env.CDP_PORT, 10) || 9222;
  const url = authUrl;

  if (cdpEnabled) {
    openBrowserWithCDP(url, cdpPort);
    console.log(`CDP remote debugging enabled on port ${cdpPort}`);
    console.log(`Visual QA MCP can connect at localhost:${cdpPort}`);
  } else {
    openBrowser(url);
  }
}

// ─── RSS Logger ───────────────────────────────────────────
// Periodic RSS logging so we can trace memory in server.log
const _rssLogger = setInterval(() => {
  const mem = process.memoryUsage();
  const ptyManager = getPtyManager();
  const ptySessions = ptyManager ? ptyManager.listSessions().length : 0;
  try {
    console.log(`[RSS] ${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB pty=${ptySessions}`);
  } catch (_) {}
}, 60000);
_rssLogger.unref();

// ─── Graceful Shutdown ─────────────────────────────────────

process.on('SIGINT', () => {
  const ptyManager = getPtyManager();
  if (ptyManager) ptyManager.destroyAll();
  store.save();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  const ptyManager = getPtyManager();
  if (ptyManager) ptyManager.destroyAll();
  store.save();
  server.close();
  process.exit(0);
});

// ─── Global Error Handlers ───────────────────────────────
// Prevent stray rejected promises or uncaught exceptions from
// crashing the server (exit code 1). Log to crash.log and continue.

const { logError, logWarning } = require('./crash-logger');

process.on('unhandledRejection', (reason) => {
  logWarning('server', 'Unhandled promise rejection', reason);
  try { console.error('[Server] Unhandled promise rejection:', reason); } catch (_) {}
});

process.on('uncaughtException', (err) => {
  logError('server', 'Uncaught exception', err);
  // Guard: console.error can throw EPIPE if stdout is broken, which triggers
  // another uncaughtException, creating an infinite cascade that kills the process.
  try { console.error('[Server] Uncaught exception:', err); } catch (_) {}
});
