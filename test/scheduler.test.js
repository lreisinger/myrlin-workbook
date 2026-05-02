#!/usr/bin/env node
/**
 * Tests for src/web/scheduler.js — engine with injected clock + fake ptyManager.
 * Usage: node test/scheduler.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\n    ${err.message}\x1b[0m`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\n    ${err.message}\x1b[0m`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertDeepEqual(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Test fixtures ─────────────────────────────────────────────
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    set: (t) => { now = t; },
  };
}

function makePtyManager() {
  const writes = [];
  const sessions = new Map();
  return {
    writes,
    setSession(id, alive) {
      sessions.set(id, { alive, pty: { write: (data) => writes.push({ id, data }) } });
    },
    removeSession(id) { sessions.delete(id); },
    getSession(id) { return sessions.get(id); },
  };
}

function makeStore() {
  const ee = new EventEmitter();
  return ee;
}

function makeScheduler({ clock = makeClock(), ptyManager = makePtyManager(), store = makeStore(), dataFile } = {}) {
  if (!dataFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
    dataFile = path.join(dir, 'schedules.json');
  }
  // Lazy-require so each test gets a fresh module (caches no state — but be safe).
  delete require.cache[require.resolve('../src/web/scheduler')];
  const { Scheduler } = require('../src/web/scheduler');
  // schedule(fn, ms) is the timer abstraction — tests pass a stub that records calls.
  const armed = [];
  const schedule = (fn, ms) => {
    const handle = { fn, ms, cancelled: false };
    armed.push(handle);
    return handle;
  };
  schedule.cancel = (handle) => { handle.cancelled = true; };
  return {
    sched: new Scheduler({ dataFile, ptyManager, store, clock, schedule }),
    clock, ptyManager, store, dataFile, armed,
  };
}

console.log('\n  Scheduler — surface + persistence');

test('create() returns full schedule with id, persists', () => {
  const { sched, clock, dataFile } = makeScheduler();
  const def = { command: 'npm test', kind: 'once', delayMs: 60_000 };
  const s = sched.create('sess-A', def);
  assert(s.id && s.id.length > 0, 'id present');
  assertEqual(s.sessionId, 'sess-A');
  assertEqual(s.command, 'npm test');
  assertEqual(s.kind, 'once');
  assertEqual(s.delayMs, 60_000);
  assertEqual(s.nextFireAt, clock.now() + 60_000);
  assertEqual(s.createdAt, clock.now());
  sched.flushSync();
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assertEqual(Object.keys(raw.schedules).length, 1);
});

test('listActive() returns only that session, oldest first', () => {
  const { sched, clock } = makeScheduler();
  const a = sched.create('sess-A', { command: 'one', kind: 'once', delayMs: 1000 });
  clock.advance(10);
  const b = sched.create('sess-A', { command: 'two', kind: 'once', delayMs: 1000 });
  clock.advance(10);
  sched.create('sess-B', { command: 'other', kind: 'once', delayMs: 1000 });
  const list = sched.listActive('sess-A');
  assertEqual(list.length, 2);
  assertEqual(list[0].id, a.id);
  assertEqual(list[1].id, b.id);
});

test('delete() removes and persists', () => {
  const { sched, dataFile } = makeScheduler();
  const s = sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  sched.delete(s.id);
  sched.flushSync();
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assertEqual(Object.keys(raw.schedules).length, 0);
});

test('create() validates kind', () => {
  const { sched } = makeScheduler();
  let threw = false;
  try { sched.create('s', { command: 'x', kind: 'forever', delayMs: 1000 }); }
  catch (_) { threw = true; }
  assert(threw, 'should reject invalid kind');
});

test('create() validates command non-empty and ≤2KB', () => {
  const { sched } = makeScheduler();
  let threw = 0;
  try { sched.create('s', { command: '', kind: 'once', delayMs: 1000 }); } catch (_) { threw++; }
  try { sched.create('s', { command: 'x'.repeat(2049), kind: 'once', delayMs: 1000 }); } catch (_) { threw++; }
  assertEqual(threw, 2);
});

test('create() validates delayMs range', () => {
  const { sched } = makeScheduler();
  let threw = 0;
  try { sched.create('s', { command: 'x', kind: 'once', delayMs: 999 }); } catch (_) { threw++; }
  try { sched.create('s', { command: 'x', kind: 'once', delayMs: 31 * 86400000 }); } catch (_) { threw++; }
  assertEqual(threw, 2);
});

test('create() with absolute fireAt computes nextFireAt = fireAt', () => {
  const { sched, clock } = makeScheduler();
  const at = clock.now() + 5_000;
  const s = sched.create('sess-A', { command: 'x', kind: 'once', fireAt: at });
  assertEqual(s.fireAt, at);
  assertEqual(s.nextFireAt, at);
});

test('round-trip: persisted schedules survive reload', () => {
  const fixture = makeScheduler();
  fixture.sched.create('sess-A', { command: 'persist me', kind: 'recurring', delayMs: 60_000 });
  fixture.sched.flushSync();
  // Reload from same dataFile in a fresh instance
  delete require.cache[require.resolve('../src/web/scheduler')];
  const { Scheduler } = require('../src/web/scheduler');
  const fresh = new Scheduler({
    dataFile: fixture.dataFile,
    ptyManager: fixture.ptyManager,
    store: fixture.store,
    clock: fixture.clock,
    schedule: () => ({ cancelled: false }),
  });
  assertEqual(fresh.listActive('sess-A').length, 1);
  assertEqual(fresh.listActive('sess-A')[0].command, 'persist me');
});

console.log(`\n  Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
