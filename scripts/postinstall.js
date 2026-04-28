#!/usr/bin/env node
/**
 * Postinstall script: fix node-pty spawn-helper permissions on macOS/Linux.
 *
 * The prebuilt spawn-helper binary in node-pty's package ships without
 * execute permission (mode 644 instead of 755), causing posix_spawnp to
 * fail with "posix_spawnp failed" on first PTY spawn.
 *
 * This is a known node-pty packaging issue. We work around it here by
 * locating node-pty (wherever npm/npx hoisted it), finding all prebuilt
 * spawn-helper binaries across platform dirs, and setting them to 755.
 *
 * See: https://github.com/therealarthur/myrlin-workbook/issues/4
 */
'use strict';

if (process.platform === 'win32') {
  process.exit(0);
}

const path = require('path');
const fs = require('fs');

/**
 * Locate node-pty's package directory using require.resolve.
 * Works regardless of where npm/npx/yarn placed it (hoisted, nested,
 * pnp-virtual, etc.). Returns null if node-pty isn't installed.
 */
function findNodePtyDir() {
  try {
    const ptyMain = require.resolve('node-pty', { paths: [path.join(__dirname, '..')] });
    let dir = path.dirname(ptyMain);
    // Walk up until we find package.json with "name": "node-pty"
    for (let i = 0; i < 8; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
          if (json && json.name === 'node-pty') return dir;
        } catch (_) {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_) {}
  return null;
}

const ptyDir = findNodePtyDir();
if (!ptyDir) {
  // node-pty not installed yet (rare during postinstall); skip silently.
  process.exit(0);
}

const prebuildsDir = path.join(ptyDir, 'prebuilds');
if (!fs.existsSync(prebuildsDir)) {
  process.exit(0);
}

try {
  const platforms = fs.readdirSync(prebuildsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const platform of platforms) {
    const helper = path.join(prebuildsDir, platform.name, 'spawn-helper');
    if (fs.existsSync(helper)) {
      try {
        fs.chmodSync(helper, 0o755);
      } catch (_) {
        // Non-fatal: runtime fix will catch this on first PTY spawn
      }
    }
  }
} catch (_) {
  // Non-fatal
}
