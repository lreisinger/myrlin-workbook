#!/usr/bin/env node
/**
 * HTTP tests for /api/sessions/:id/schedules.
 *
 * Mounts a minimal Express app with just the scheduler routes attached. Auth
 * is a tiny pass-through so we can focus on validation + plumbing.
 *
 * Usage: node test/scheduler-api.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\n    ${err.message}\x1b[0m`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function req(server, method, urlPath, { token = 'good', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch (_) { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function buildHarness({ knownSessions = ['sess-A'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-api-'));
  const dataFile = path.join(dir, 'schedules.json');
  delete require.cache[require.resolve('../src/web/scheduler')];
  const { Scheduler } = require('../src/web/scheduler');
  const ptyManager = {
    sessions: new Map(knownSessions.map(id => [id, { alive: true, pty: { write() {} } }])),
    getSession(id) { return this.sessions.get(id); },
  };
  const store = Object.assign(new EventEmitter(), {
    getSession(id) { return knownSessions.includes(id) ? { id } : null; },
  });
  const sched = new Scheduler({ dataFile, ptyManager, store });
  sched.start();

  const app = express();
  app.use(express.json());
  // Tiny fake auth middleware: header `authorization: Bearer good` passes.
  function requireAuth(req, res, next) {
    if ((req.headers.authorization || '') === 'Bearer good') return next();
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Mount the routes (test imports the same factory used by server.js)
  delete require.cache[require.resolve('../src/web/scheduler-routes')];
  const { mountScheduleRoutes } = require('../src/web/scheduler-routes');
  mountScheduleRoutes(app, { requireAuth, scheduler: sched, store });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, sched, store, ptyManager, dataFile }));
  });
}

(async () => {
  console.log('\n  Schedule API');

  await test('GET unknown session → 200, empty active+history', async () => {
    const h = await buildHarness();
    const r = await req(h.server, 'GET', '/api/sessions/sess-A/schedules');
    assertEqual(r.status, 200);
    assertEqual(r.body.active.length, 0);
    assertEqual(r.body.history.length, 0);
    h.server.close(); h.sched.stop();
  });

  await test('GET without auth → 401', async () => {
    const h = await buildHarness();
    const r = await req(h.server, 'GET', '/api/sessions/sess-A/schedules', { token: null });
    assertEqual(r.status, 401);
    h.server.close(); h.sched.stop();
  });

  await test('POST creates schedule, GET returns it', async () => {
    const h = await buildHarness();
    const create = await req(h.server, 'POST', '/api/sessions/sess-A/schedules', {
      body: { command: 'npm test', kind: 'once', delayMs: 60_000 },
    });
    assertEqual(create.status, 200);
    assert(create.body.schedule.id);
    const list = await req(h.server, 'GET', '/api/sessions/sess-A/schedules');
    assertEqual(list.body.active.length, 1);
    assertEqual(list.body.active[0].command, 'npm test');
    h.server.close(); h.sched.stop();
  });

  await test('POST validation: empty command → 400', async () => {
    const h = await buildHarness();
    const r = await req(h.server, 'POST', '/api/sessions/sess-A/schedules', {
      body: { command: '', kind: 'once', delayMs: 60_000 },
    });
    assertEqual(r.status, 400);
    assert(r.body.error);
    h.server.close(); h.sched.stop();
  });

  await test('POST validation: delayMs below 1s → 400', async () => {
    const h = await buildHarness();
    const r = await req(h.server, 'POST', '/api/sessions/sess-A/schedules', {
      body: { command: 'x', kind: 'once', delayMs: 100 },
    });
    assertEqual(r.status, 400);
    h.server.close(); h.sched.stop();
  });

  await test('POST unknown session → 404', async () => {
    const h = await buildHarness({ knownSessions: ['sess-A'] });
    const r = await req(h.server, 'POST', '/api/sessions/sess-MISSING/schedules', {
      body: { command: 'x', kind: 'once', delayMs: 60_000 },
    });
    assertEqual(r.status, 404);
    h.server.close(); h.sched.stop();
  });

  await test('DELETE schedule removes it', async () => {
    const h = await buildHarness();
    const c = await req(h.server, 'POST', '/api/sessions/sess-A/schedules', {
      body: { command: 'x', kind: 'once', delayMs: 60_000 },
    });
    const id = c.body.schedule.id;
    const d = await req(h.server, 'DELETE', `/api/sessions/sess-A/schedules/${id}`);
    assertEqual(d.status, 200);
    assertEqual(d.body.success, true);
    const list = await req(h.server, 'GET', '/api/sessions/sess-A/schedules');
    assertEqual(list.body.active.length, 0);
    h.server.close(); h.sched.stop();
  });

  await test('DELETE history clears history block', async () => {
    const h = await buildHarness();
    h.sched._appendHistory('sess-A', {
      id: 'x', command: 'cmd', firedAt: 1, scheduledAt: 1,
      status: 'success', skipReason: null, skipCount: 1,
    });
    h.sched.flushSync();
    const r = await req(h.server, 'DELETE', '/api/sessions/sess-A/schedules/history');
    assertEqual(r.status, 200);
    const list = await req(h.server, 'GET', '/api/sessions/sess-A/schedules');
    assertEqual(list.body.history.length, 0);
    h.server.close(); h.sched.stop();
  });

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
