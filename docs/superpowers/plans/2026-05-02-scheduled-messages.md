# Scheduled Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the scheduled-messages feature per `docs/superpowers/specs/2026-05-02-scheduled-messages-design.md` — a server-side scheduler that fires shell commands into a pty session on a delay or interval, plus a popover UI on each terminal pane header to manage them.

**Architecture:** Pure-JS scheduler module (`src/web/scheduler.js`) using per-schedule `setTimeout`. Persistence to `~/.myrlin/schedules.json` (atomic tmp+rename, debounced 200 ms). Thin HTTP layer in `src/web/server.js` exposing four `/api/sessions/:id/schedules` endpoints. Frontend popover component (`src/web/public/schedules.js`) anchored under a new clock button in each pane header.

**Tech Stack:** Node 18+, Express 5, plain DOM JS (no frontend framework), `crypto.randomUUID()` for IDs, in-process custom test harness (mirrors existing `test/*.test.js` style).

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `src/web/scheduler.js` | new | Scheduler engine: timers, fire flow, persistence, history. No HTTP, no DOM. |
| `src/web/server.js` | edit | Mount 4 endpoints under `/api/sessions/:id/schedules`. Start scheduler in `startServer`, stop in shutdown. |
| `src/web/public/index.html` | edit | Add `<button class="terminal-pane-schedule">` to all 6 pane headers. Add `<script src="schedules.js">`. |
| `src/web/public/styles.css` | edit | Clock button styles + popover styles + count badge. |
| `src/web/public/schedules.js` | new | `SchedulePopover` class: open/close/anchor, tabs, form, list, polling. |
| `src/web/public/app.js` | edit | Wire clock button click → `SchedulePopover.toggle(slotIdx, sessionId)`. Handle close on session-detach. |
| `test/scheduler.test.js` | new | Engine unit tests with injected clock + fake `ptyManager`. |
| `test/scheduler-api.test.js` | new | Spin a tiny Express instance, hit the 4 routes via `http.request`. |

No edits to `pty-manager.js` (engine uses `ptyManager.getSession(id).pty.write(text)`, the same primitive the WebSocket handler uses).

---

## Task Map

| # | Task | Depends on |
|---|------|------------|
| 1 | Scheduler — module surface, persistence, create/list/delete | — |
| 2 | Scheduler — fire flow (success path) | 1 |
| 3 | Scheduler — skip handling, skip-row collapse, history cap | 2 |
| 4 | Scheduler — boot recovery + session-deletion cleanup | 3 |
| 5 | HTTP routes + lifecycle wiring in `server.js` | 4 |
| 6 | Frontend — clock button, popover scaffold, tab switch | 5 |
| 7 | Frontend — Active tab: form, save, list, delete, count badge | 6 |
| 8 | Frontend — History tab, polling, mobile, screenshot | 7 |

---

### Task 1: Scheduler — module surface, persistence, create/list/delete

**Goal:** A `Scheduler` class that loads/saves `~/.myrlin/schedules.json` and supports `create/listActive/listHistory/delete`. No firing yet — `setTimeout` not armed in this task.

**Files:**
- Create: `src/web/scheduler.js`
- Create: `test/scheduler.test.js`

**Acceptance Criteria:**
- [ ] Constructor takes `{ dataFile, ptyManager, store, clock, schedule }` — last three injectable for tests.
- [ ] `create(sessionId, def)` returns a `{ id, sessionId, command, kind, delayMs?, fireAt?, nextFireAt, createdAt }` object, persists it, and validates input.
- [ ] `listActive(sessionId)` returns active schedules for that session, oldest first.
- [ ] `listHistory(sessionId)` returns history rows for that session, newest first.
- [ ] `delete(scheduleId)` removes the schedule and persists.
- [ ] Persistence is atomic (tmp file + rename) and debounced 200 ms.
- [ ] Round-trip: create → new instance → schedule survives.

**Verify:** `node test/scheduler.test.js` → `Results: 8 passed, 0 failed`

**Steps:**

- [ ] **Step 1: Write the failing tests for module surface**

Create `test/scheduler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `node test/scheduler.test.js`
Expected: failure — `Cannot find module '../src/web/scheduler'`.

- [ ] **Step 3: Implement scheduler.js (surface only — no firing)**

Create `src/web/scheduler.js`:

```javascript
/**
 * Scheduled messages engine.
 *
 * Fires shell commands into a pty session on a delay (one-off) or on repeat
 * (recurring). State persists to ~/.myrlin/schedules.json so schedules survive
 * server restarts. The engine is HTTP-agnostic: the route handlers in server.js
 * are thin adapters.
 *
 * Constructor dependencies are injectable so the engine is unit-testable:
 *   - ptyManager: must expose getSession(id) → { alive, pty: { write(s) } }
 *   - store:      EventEmitter (the existing src/state/store Store), for session:deleted
 *   - clock:      { now(): number } — defaults to Date
 *   - schedule:   schedule(fn, ms) → handle; schedule.cancel(handle) — defaults to setTimeout
 *   - dataFile:   absolute path to schedules.json — defaults to ~/.myrlin/schedules.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../utils/data-dir');

const MAX_DELAY_MS = 30 * 86_400_000; // 30 days
const MIN_DELAY_MS = 1_000;           // 1 second
const MAX_COMMAND_BYTES = 2048;
const HISTORY_CAP_PER_SESSION = 50;
const SAVE_DEBOUNCE_MS = 200;

const DEFAULT_CLOCK = { now: () => Date.now() };
function defaultSchedule(fn, ms) { return setTimeout(fn, ms); }
defaultSchedule.cancel = (h) => clearTimeout(h);

class Scheduler {
  constructor({ dataFile, ptyManager, store, clock = DEFAULT_CLOCK, schedule = defaultSchedule } = {}) {
    this.dataFile = dataFile || path.join(getDataDir(), 'schedules.json');
    this.ptyManager = ptyManager;
    this.store = store;
    this.clock = clock;
    this.schedule = schedule;

    /** @type {Object.<string, Schedule>} */
    this._schedules = {};
    /** @type {Object.<string, HistoryRow[]>} */
    this._history = {};
    /** @type {Object.<string, any>} */
    this._timers = {}; // scheduleId -> timer handle

    this._saveTimer = null;
    this._load();
  }

  // ── Persistence ────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        this._schedules = raw.schedules || {};
        this._history = raw.history || {};
      }
    } catch (_) {
      this._schedules = {};
      this._history = {};
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = this.schedule(() => {
      this._saveTimer = null;
      this._writeSync();
    }, SAVE_DEBOUNCE_MS);
  }

  flushSync() {
    if (this._saveTimer) {
      this.schedule.cancel(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeSync();
  }

  _writeSync() {
    const dir = path.dirname(this.dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.dataFile + '.tmp';
    const payload = JSON.stringify({ schedules: this._schedules, history: this._history }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.dataFile);
  }

  // ── CRUD ───────────────────────────────────────────────────────

  /**
   * Validate and create a schedule. Persists asynchronously (debounced).
   * @param {string} sessionId
   * @param {{command:string, kind:'once'|'recurring', delayMs?:number, fireAt?:number}} def
   * @returns {Schedule}
   */
  create(sessionId, def) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId required');
    if (!def || typeof def !== 'object') throw new Error('def required');

    const command = def.command;
    if (typeof command !== 'string' || command.length === 0) throw new Error('command must be a non-empty string');
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) throw new Error('command exceeds 2KB');

    const kind = def.kind;
    if (kind !== 'once' && kind !== 'recurring') throw new Error('kind must be "once" or "recurring"');

    const hasDelay = Number.isFinite(def.delayMs);
    const hasFireAt = Number.isFinite(def.fireAt);
    if (kind === 'recurring' && !hasDelay) throw new Error('recurring requires delayMs');
    if (kind === 'recurring' && hasFireAt) throw new Error('recurring cannot use fireAt');
    if (kind === 'once' && hasDelay && hasFireAt) throw new Error('exactly one of delayMs/fireAt for once');
    if (kind === 'once' && !hasDelay && !hasFireAt) throw new Error('once requires delayMs or fireAt');

    if (hasDelay) {
      if (def.delayMs < MIN_DELAY_MS) throw new Error(`delayMs must be ≥ ${MIN_DELAY_MS}`);
      if (def.delayMs > MAX_DELAY_MS) throw new Error(`delayMs must be ≤ ${MAX_DELAY_MS}`);
    }

    const now = this.clock.now();
    if (hasFireAt && def.fireAt <= now) throw new Error('fireAt must be in the future');

    const id = crypto.randomUUID();
    const nextFireAt = hasFireAt ? def.fireAt : now + def.delayMs;
    const s = {
      id, sessionId, command, kind,
      delayMs: hasDelay ? def.delayMs : undefined,
      fireAt: hasFireAt ? def.fireAt : undefined,
      nextFireAt,
      createdAt: now,
    };
    this._schedules[id] = s;
    this._scheduleSave();
    return s;
  }

  delete(scheduleId) {
    if (!this._schedules[scheduleId]) return false;
    const timer = this._timers[scheduleId];
    if (timer) {
      this.schedule.cancel(timer);
      delete this._timers[scheduleId];
    }
    delete this._schedules[scheduleId];
    this._scheduleSave();
    return true;
  }

  listActive(sessionId) {
    return Object.values(this._schedules)
      .filter(s => s.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listHistory(sessionId) {
    const rows = this._history[sessionId] || [];
    // Stored newest-last; return newest-first
    return [...rows].reverse();
  }

  clearHistory(sessionId) {
    delete this._history[sessionId];
    this._scheduleSave();
  }
}

module.exports = { Scheduler, MIN_DELAY_MS, MAX_DELAY_MS, MAX_COMMAND_BYTES, HISTORY_CAP_PER_SESSION };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node test/scheduler.test.js`
Expected: `Results: 8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/web/scheduler.js test/scheduler.test.js
git commit -m "feat(scheduler): module surface, persistence, create/list/delete

Pure-JS engine with injectable clock, schedule, ptyManager, store. Atomic
debounced persistence to ~/.myrlin/schedules.json. Validation per spec
(2KB cap, 1s..30d delay range, exactly-one-of delayMs/fireAt for once)."
```

---

### Task 2: Scheduler — fire flow (success path)

**Goal:** `start()` arms timers for active schedules; on fire, `pty.write(command + '\r')` is called and a `success` history row is recorded; one-off deletes after fire; recurring re-arms with a fresh `nextFireAt`.

**Files:**
- Modify: `src/web/scheduler.js` (add `start`, `stop`, `_fire`, `_armOne`)
- Modify: `test/scheduler.test.js` (append fire-flow tests)

**Acceptance Criteria:**
- [ ] `start()` arms a `schedule(fn, nextFireAt - now)` for every active schedule.
- [ ] On fire, with an alive pty, `pty.write` receives exactly `command + '\r'`.
- [ ] One-off schedule is removed from `_schedules` after a successful fire.
- [ ] Recurring schedule's `nextFireAt` advances by `delayMs` after a successful fire and a new timer is armed.
- [ ] A `success` history row is appended (with `command`, `firedAt`, `scheduledAt`).
- [ ] `stop()` cancels every armed timer.

**Verify:** `node test/scheduler.test.js` → `Results: 13 passed, 0 failed`

**Steps:**

- [ ] **Step 1: Append fire-flow tests**

Append to `test/scheduler.test.js`, just before the "Results" line:

```javascript
console.log('\n  Scheduler — fire flow (success path)');

test('start() arms a timer for every active schedule', () => {
  const f = makeScheduler();
  f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 5000 });
  f.sched.create('sess-A', { command: 'y', kind: 'recurring', delayMs: 10000 });
  f.sched.start();
  // Two timers armed (excluding the save-debounce timer which uses same `schedule` stub)
  const fireTimers = f.armed.filter(h => h.ms === 5000 || h.ms === 10000);
  assertEqual(fireTimers.length, 2);
});

test('fire() writes command + carriage return to alive pty', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', /*alive*/ true);
  const s = f.sched.create('sess-A', { command: 'npm test', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  assertEqual(f.ptyManager.writes.length, 1);
  assertEqual(f.ptyManager.writes[0].id, 'sess-A');
  assertEqual(f.ptyManager.writes[0].data, 'npm test\r');
});

test('one-off schedule deletes after successful fire', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  assertEqual(f.sched.listActive('sess-A').length, 0);
});

test('recurring schedule re-arms with delayMs after fire', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  const handle1 = f.armed.find(h => h.ms === 5000);
  f.clock.advance(5000);
  handle1.fn();
  // Schedule still active, nextFireAt advanced
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
  assertEqual(active[0].nextFireAt, f.clock.now() + 5000);
  // A new timer armed for next fire
  const next = f.armed.filter(h => h.ms === 5000);
  assertEqual(next.length, 2);
});

test('successful fire appends a success history row', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'echo hi', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'success');
  assertEqual(hist[0].command, 'echo hi');
  assertEqual(hist[0].firedAt, f.clock.now());
  assertEqual(hist[0].scheduledAt, s.nextFireAt);
});
```

- [ ] **Step 2: Run; expect new tests fail**

Run: `node test/scheduler.test.js`
Expected: 8 pass, 5 fail (`sched.start is not a function`).

- [ ] **Step 3: Implement `start`, `stop`, `_armOne`, `_fire`**

In `src/web/scheduler.js`, add these methods to the `Scheduler` class (place after `clearHistory`):

```javascript
  // ── Lifecycle ──────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;

    // Arm timer for every active schedule. Boot recovery (Task 4) will
    // pre-process missed schedules before this loop runs.
    for (const id of Object.keys(this._schedules)) {
      this._armOne(id);
    }

    // Subscribe to session deletion (Task 4 implements the handler)
    if (this.store && typeof this.store.on === 'function') {
      this._onSessionDeleted = ({ id }) => this._handleSessionDeleted(id);
      this.store.on('session:deleted', this._onSessionDeleted);
    }
  }

  stop() {
    this._started = false;
    for (const id of Object.keys(this._timers)) {
      this.schedule.cancel(this._timers[id]);
    }
    this._timers = {};
    if (this._saveTimer) {
      this.schedule.cancel(this._saveTimer);
      this._saveTimer = null;
      this._writeSync();
    }
    if (this.store && this._onSessionDeleted) {
      this.store.off('session:deleted', this._onSessionDeleted);
      this._onSessionDeleted = null;
    }
  }

  _armOne(scheduleId) {
    const s = this._schedules[scheduleId];
    if (!s) return;
    const delay = Math.max(0, s.nextFireAt - this.clock.now());
    this._timers[scheduleId] = this.schedule(() => this._fire(scheduleId), delay);
  }

  // ── Fire flow ─────────────────────────────────────────────────

  _fire(scheduleId) {
    const s = this._schedules[scheduleId];
    if (!s) return;
    delete this._timers[scheduleId];

    const session = this.ptyManager && this.ptyManager.getSession(s.sessionId);
    const alive = !!(session && session.alive);
    const scheduledAt = s.nextFireAt;
    const firedAt = this.clock.now();

    if (!alive) {
      // Skip path is implemented in Task 3.
      this._appendHistory(s.sessionId, {
        id: s.id, command: s.command, firedAt, scheduledAt,
        status: 'skipped', skipReason: 'session-not-running', skipCount: 1,
      });
      if (s.kind === 'once') {
        delete this._schedules[s.id];
      } else {
        s.nextFireAt = firedAt + s.delayMs;
        this._armOne(s.id);
      }
      this._scheduleSave();
      return;
    }

    // Success path
    try {
      session.pty.write(s.command + '\r');
    } catch (err) {
      console.error('[Scheduler] pty.write failed:', err.message);
    }

    this._appendHistory(s.sessionId, {
      id: s.id, command: s.command, firedAt, scheduledAt,
      status: 'success', skipReason: null, skipCount: 1,
    });

    if (s.kind === 'once') {
      delete this._schedules[s.id];
    } else {
      s.nextFireAt = firedAt + s.delayMs;
      this._armOne(s.id);
    }
    this._scheduleSave();
  }

  _appendHistory(sessionId, row) {
    if (!this._history[sessionId]) this._history[sessionId] = [];
    this._history[sessionId].push(row);
    // Cap (Task 3 enforces collapse + cap; this naive append is replaced there).
    if (this._history[sessionId].length > HISTORY_CAP_PER_SESSION) {
      this._history[sessionId] = this._history[sessionId].slice(-HISTORY_CAP_PER_SESSION);
    }
  }

  _handleSessionDeleted(_sessionId) {
    // Implemented in Task 4.
  }
```

- [ ] **Step 4: Run tests, expect green**

Run: `node test/scheduler.test.js`
Expected: `Results: 13 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/web/scheduler.js test/scheduler.test.js
git commit -m "feat(scheduler): fire flow — success path with one-off delete and recurring re-arm"
```

---

### Task 3: Scheduler — skip handling, skip-row collapse, history cap

**Goal:** When the pty is stopped at fire time, append a `skipped: session-not-running` row with collapse semantics (consecutive same-id same-reason rows merge into one with incremented `skipCount`). Verify history cap enforces 50-per-session.

**Files:**
- Modify: `src/web/scheduler.js` (replace `_appendHistory` with collapse-aware version)
- Modify: `test/scheduler.test.js` (append skip + collapse + cap tests)

**Acceptance Criteria:**
- [ ] Pty `alive: false` at fire time → row written with `status: 'skipped'`, `skipReason: 'session-not-running'`.
- [ ] Three consecutive same-id same-reason skip rows produce **one** history row with `skipCount === 3` and `firedAt` updated to the latest.
- [ ] A `success` row between two skip rows breaks the collapse: 1 skip + 1 success + 1 skip = 3 rows.
- [ ] History cap at 50: after 51 appends for one session, only the newest 50 remain.
- [ ] Once-schedule with stopped pty: row appended, then schedule deleted.
- [ ] Recurring schedule with stopped pty: row appended, then re-armed at `now + delayMs`.

**Verify:** `node test/scheduler.test.js` → `Results: 19 passed, 0 failed`

**Steps:**

- [ ] **Step 1: Append skip + collapse tests**

Append to `test/scheduler.test.js` before the Results line:

```javascript
console.log('\n  Scheduler — skip handling');

test('stopped pty fires skipped row, recurring re-arms', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', /*alive*/ false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  f.armed.find(h => h.ms === 5000).fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[0].skipReason, 'session-not-running');
  // Recurring re-armed
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
});

test('stopped pty + once kind deletes the schedule', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  f.sched.start();
  f.armed.find(h => h.ms === 1000).fn();
  assertEqual(f.sched.listActive('sess-A').length, 0);
  assertEqual(f.sched.listHistory('sess-A').length, 1);
});

test('three consecutive same-id skip rows collapse to one with skipCount=3', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // Fire three times in a row
  for (let i = 0; i < 3; i++) {
    f.clock.advance(5000);
    const handle = f.armed.filter(h => h.ms === 5000).pop();
    handle.fn();
  }
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].skipCount, 3);
  assertEqual(hist[0].status, 'skipped');
});

test('success between skips breaks collapse — 3 distinct rows', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // skip
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  // bring pty up, success
  f.ptyManager.setSession('sess-A', true);
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  // pty down again, skip
  f.ptyManager.setSession('sess-A', false);
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 3);
  // Newest first
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[1].status, 'success');
  assertEqual(hist[2].status, 'skipped');
});

test('different schedule ids do not collapse together', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s1 = f.sched.create('sess-A', { command: 'a', kind: 'recurring', delayMs: 5000 });
  const s2 = f.sched.create('sess-A', { command: 'b', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  f.armed.filter(h => h.ms === 5000).forEach(h => h.fn()); // both fire once
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 2);
  assertEqual(hist[0].skipCount, 1);
  assertEqual(hist[1].skipCount, 1);
});

test('history cap: 51 appends → 50 newest retained', () => {
  const f = makeScheduler();
  // Bypass through internal API for speed
  for (let i = 0; i < 51; i++) {
    f.sched._appendHistory('sess-A', {
      id: 'id-' + i, command: 'c-' + i, firedAt: 1000 + i, scheduledAt: 1000 + i,
      status: 'success', skipReason: null, skipCount: 1,
    });
  }
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 50);
  // Newest first → command "c-50"
  assertEqual(hist[0].command, 'c-50');
  // Oldest retained is c-1 (c-0 was pruned)
  assertEqual(hist[hist.length - 1].command, 'c-1');
});
```

- [ ] **Step 2: Run; the collapse tests fail**

Run: `node test/scheduler.test.js`
Expected: 14 pass, 5 fail (collapse not implemented; first skip test may pass).

- [ ] **Step 3: Replace `_appendHistory` with collapse-aware version**

In `src/web/scheduler.js`, replace the existing `_appendHistory` method with:

```javascript
  _appendHistory(sessionId, row) {
    if (!this._history[sessionId]) this._history[sessionId] = [];
    const arr = this._history[sessionId];
    const last = arr[arr.length - 1];
    const canCollapse =
      last
      && last.status === 'skipped'
      && row.status === 'skipped'
      && last.id === row.id
      && last.skipReason === row.skipReason;
    if (canCollapse) {
      last.skipCount = (last.skipCount || 1) + 1;
      last.firedAt = row.firedAt;
    } else {
      arr.push(row);
    }
    if (arr.length > HISTORY_CAP_PER_SESSION) {
      this._history[sessionId] = arr.slice(-HISTORY_CAP_PER_SESSION);
    }
  }
```

- [ ] **Step 4: Run tests, expect all green**

Run: `node test/scheduler.test.js`
Expected: `Results: 19 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/web/scheduler.js test/scheduler.test.js
git commit -m "feat(scheduler): skip handling, history collapse, 50-row cap"
```

---

### Task 4: Scheduler — boot recovery + session-deletion cleanup

**Goal:** On `start()`, schedules whose `nextFireAt < now` are pre-processed: one-offs append `missed-while-down` and delete; recurring advance to `now + delayMs` (no catch-up). When the store emits `session:deleted`, all of that session's schedules and history are cleared.

**Files:**
- Modify: `src/web/scheduler.js` (add boot-recovery loop in `start`, fill in `_handleSessionDeleted`)
- Modify: `test/scheduler.test.js` (append boot-recovery + cleanup tests)

**Acceptance Criteria:**
- [ ] One-off whose `nextFireAt < now` at `start()` time → not armed; one history row with `skipReason: 'missed-while-down'`; schedule removed.
- [ ] Recurring whose `nextFireAt < now` at `start()` time → `nextFireAt` advanced to `now + delayMs`; new timer armed; **no** history row recorded.
- [ ] One-off with `nextFireAt > now` → timer armed, no history row.
- [ ] `store.emit('session:deleted', { id })` removes all that session's active schedules (cancelling timers) and clears its history.

**Verify:** `node test/scheduler.test.js` → `Results: 23 passed, 0 failed`

**Steps:**

- [ ] **Step 1: Append boot-recovery + cleanup tests**

Append to `test/scheduler.test.js`:

```javascript
console.log('\n  Scheduler — boot recovery');

test('start(): missed once → skipped+deleted, no timer armed', () => {
  // Build a state file directly so the next instance boots with stale state
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  const dataFile = path.join(dir, 'schedules.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    schedules: {
      'sched-1': {
        id: 'sched-1', sessionId: 'sess-A', command: 'late',
        kind: 'once', delayMs: 60000,
        nextFireAt: 1000,            // way in the past (vs clock 1.7e12)
        createdAt: 500,
      },
    },
    history: {},
  }));
  const f = makeScheduler({ dataFile });
  f.sched.start();
  assertEqual(f.sched.listActive('sess-A').length, 0);
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[0].skipReason, 'missed-while-down');
});

test('start(): missed recurring → advanced, armed, no history row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  const dataFile = path.join(dir, 'schedules.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    schedules: {
      'sched-2': {
        id: 'sched-2', sessionId: 'sess-A', command: 'tick',
        kind: 'recurring', delayMs: 5000,
        nextFireAt: 1000,
        createdAt: 500,
      },
    },
    history: {},
  }));
  const f = makeScheduler({ dataFile });
  f.sched.start();
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
  assertEqual(active[0].nextFireAt, f.clock.now() + 5000);
  // Timer armed
  assert(f.armed.some(h => h.ms === 5000), 'timer armed for recurring');
  // No history row
  assertEqual(f.sched.listHistory('sess-A').length, 0);
});

test('start(): future once → timer armed for the remaining delay', () => {
  const f = makeScheduler();
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 30_000 });
  f.sched.start();
  assert(f.armed.some(h => h.ms === 30_000), 'expected 30s timer armed');
});

console.log('\n  Scheduler — store cleanup');

test('session:deleted clears that session\'s schedules and history', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.create('sess-B', { command: 'y', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // Drop a history row for sess-A
  f.armed.filter(h => h.ms === 5000)[0].fn();
  assert(f.sched.listActive('sess-A').length > 0);
  assert(f.sched.listHistory('sess-A').length > 0);
  // Emit deletion
  f.store.emit('session:deleted', { id: 'sess-A' });
  assertEqual(f.sched.listActive('sess-A').length, 0);
  assertEqual(f.sched.listHistory('sess-A').length, 0);
  // sess-B untouched
  assertEqual(f.sched.listActive('sess-B').length, 1);
});
```

- [ ] **Step 2: Run; expect new tests to fail**

Run: `node test/scheduler.test.js`
Expected: 19 pass, 4 fail.

- [ ] **Step 3: Implement boot recovery in `start()`**

In `src/web/scheduler.js`, replace the existing `start()` method with:

```javascript
  start() {
    if (this._started) return;
    this._started = true;

    // Boot recovery: pre-process schedules whose nextFireAt has elapsed.
    const now = this.clock.now();
    for (const id of Object.keys(this._schedules)) {
      const s = this._schedules[id];
      if (s.nextFireAt < now) {
        if (s.kind === 'once') {
          this._appendHistory(s.sessionId, {
            id: s.id, command: s.command,
            firedAt: now, scheduledAt: s.nextFireAt,
            status: 'skipped', skipReason: 'missed-while-down', skipCount: 1,
          });
          delete this._schedules[id];
        } else {
          // recurring: no catch-up, advance to now + delayMs
          s.nextFireAt = now + s.delayMs;
        }
      }
    }
    this._scheduleSave();

    // Arm timers for everything still active
    for (const id of Object.keys(this._schedules)) {
      this._armOne(id);
    }

    // Subscribe to store cleanup
    if (this.store && typeof this.store.on === 'function') {
      this._onSessionDeleted = ({ id }) => this._handleSessionDeleted(id);
      this.store.on('session:deleted', this._onSessionDeleted);
    }
  }
```

And replace the placeholder `_handleSessionDeleted`:

```javascript
  _handleSessionDeleted(sessionId) {
    let changed = false;
    for (const id of Object.keys(this._schedules)) {
      if (this._schedules[id].sessionId === sessionId) {
        const timer = this._timers[id];
        if (timer) this.schedule.cancel(timer);
        delete this._timers[id];
        delete this._schedules[id];
        changed = true;
      }
    }
    if (this._history[sessionId]) {
      delete this._history[sessionId];
      changed = true;
    }
    if (changed) this._scheduleSave();
  }
```

- [ ] **Step 4: Run tests, expect green**

Run: `node test/scheduler.test.js`
Expected: `Results: 23 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/web/scheduler.js test/scheduler.test.js
git commit -m "feat(scheduler): boot recovery (missed-while-down) + session-deletion cleanup"
```

---

### Task 5: HTTP routes + lifecycle wiring in `server.js`

**Goal:** Mount `GET/POST/DELETE /api/sessions/:id/schedules` and `DELETE /api/sessions/:id/schedules/history`. Construct one shared `Scheduler` and call `start()` after `ptyManager` is wired in `startServer`. Stop on shutdown. Cover with HTTP tests.

**Files:**
- Modify: `src/web/server.js` (add routes; wire start/stop)
- Create: `test/scheduler-api.test.js`

**Acceptance Criteria:**
- [ ] `GET /api/sessions/:id/schedules` returns `{ active: [], history: [] }` for unknown session.
- [ ] `POST` creates a schedule and returns `{ schedule }`. Validation rejections return HTTP 400 with `{ error }`.
- [ ] `DELETE /api/sessions/:id/schedules/:scheduleId` returns `{ success: true }`; subsequent GET excludes it.
- [ ] `DELETE /api/sessions/:id/schedules/history` clears history and returns `{ success: true }`.
- [ ] All 4 routes require auth (return 401 without it).
- [ ] `startServer()` constructs a Scheduler with the live `ptyManager` and `store`, calls `scheduler.start()`. Shutdown calls `scheduler.stop()`.
- [ ] Unknown sessionId on POST returns 404.

**Verify:** `node test/scheduler-api.test.js` → `Results: 8 passed, 0 failed`

**Steps:**

- [ ] **Step 1: Write the API test file**

Create `test/scheduler-api.test.js`:

```javascript
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
```

- [ ] **Step 2: Run; expect failure (`scheduler-routes` missing)**

Run: `node test/scheduler-api.test.js`
Expected: cannot find `'../src/web/scheduler-routes'`.

- [ ] **Step 3: Create the routes module**

Create `src/web/scheduler-routes.js`:

```javascript
/**
 * HTTP route adapters for the scheduler engine.
 * Mounted by server.js (production) and by test/scheduler-api.test.js (tests).
 */

function mountScheduleRoutes(app, { requireAuth, scheduler, store }) {
  app.get('/api/sessions/:id/schedules', requireAuth, (req, res) => {
    res.json({
      active: scheduler.listActive(req.params.id),
      history: scheduler.listHistory(req.params.id),
    });
  });

  app.post('/api/sessions/:id/schedules', requireAuth, (req, res) => {
    const sessionId = req.params.id;
    if (!store.getSession(sessionId)) {
      return res.status(404).json({ error: 'session not found' });
    }
    try {
      const schedule = scheduler.create(sessionId, req.body || {});
      res.json({ schedule });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id/schedules/history', requireAuth, (req, res) => {
    scheduler.clearHistory(req.params.id);
    res.json({ success: true });
  });

  app.delete('/api/sessions/:id/schedules/:scheduleId', requireAuth, (req, res) => {
    const ok = scheduler.delete(req.params.scheduleId);
    if (!ok) return res.status(404).json({ error: 'schedule not found' });
    res.json({ success: true });
  });
}

module.exports = { mountScheduleRoutes };
```

Note: the `history` DELETE route is registered **before** the `:scheduleId` DELETE route so Express matches it first.

- [ ] **Step 4: Wire the scheduler into `server.js`**

In `src/web/server.js`, locate `let _ptyManager = null;` (around line 7993). After the `attachPtyWebSocket` block where `_ptyManager` is set (around line 8044), add:

```javascript
  // ── Scheduler ───────────────────────────────────────────────
  const { Scheduler } = require('./scheduler');
  const _scheduler = new Scheduler({ ptyManager: _ptyManager, store: getStore() });
  _scheduler.start();
  // expose for shutdown handler below
  _ptyManager._scheduler = _scheduler;
```

Then, in the shutdown handler that already calls `_ptyManager.destroyAll()` (around line 8050), add a sibling line just before it:

```javascript
    if (_ptyManager && _ptyManager._scheduler) {
      try { _ptyManager._scheduler.stop(); } catch (_) {}
    }
```

Also, near the top of `server.js` (where other route imports occur — search for `setupPushRoutes(app, ...)` around line 322), add the schedule routes mount:

```javascript
const { mountScheduleRoutes } = require('./scheduler-routes');
// Will be called inside startServer after _scheduler is constructed.
```

Then inside `startServer`, immediately after `_scheduler.start();`, mount the routes:

```javascript
  mountScheduleRoutes(app, { requireAuth, scheduler: _scheduler, store: getStore() });
```

- [ ] **Step 5: Run API tests, expect green**

Run: `node test/scheduler-api.test.js`
Expected: `Results: 8 passed, 0 failed`.

Also re-run engine tests to confirm nothing regressed:

Run: `node test/scheduler.test.js`
Expected: `Results: 23 passed, 0 failed`.

- [ ] **Step 6: Smoke-test against the running server**

Start the server: `npm run gui:bare`. In another shell, with a real auth token (read from `~/.myrlin/config.json`):

```bash
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.myrlin/config.json','utf8')).tokens[0])")
SID="<an existing session id from the GUI>"
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:3456/api/sessions/$SID/schedules" | head
```

Should print `{"active":[],"history":[]}`. Stop the server (Ctrl+C).

- [ ] **Step 7: Commit**

```bash
git add src/web/scheduler-routes.js src/web/server.js test/scheduler-api.test.js
git commit -m "feat(scheduler): HTTP routes and server lifecycle wiring"
```

---

### Task 6: Frontend — clock button, popover scaffold, tab switch

**Goal:** Add a clock button to all 6 pane headers (HTML + CSS), and a `SchedulePopover` class skeleton in `schedules.js` that opens a positioned popover with two tabs (`Active` / `History`) under the clock when clicked. Click outside or Esc closes it. No data yet.

**Files:**
- Modify: `src/web/public/index.html` (add clock button × 6, register `<script src="schedules.js">`)
- Modify: `src/web/public/styles.css` (clock button hover-reveal + popover styles)
- Create: `src/web/public/schedules.js`
- Modify: `src/web/public/app.js` (wire clock click)

**Acceptance Criteria:**
- [ ] Hovering an active pane reveals a clock button between `.terminal-pane-pinnedoc` and `.terminal-pane-close`.
- [ ] Clicking the clock opens a popover positioned just below it.
- [ ] Popover has two tabs (`Active` / `History`); clicking switches the visible body.
- [ ] Esc or clicking outside closes the popover.
- [ ] Clicking another pane's clock moves the popover to that pane (single shared instance).
- [ ] No console errors on page load.

**Verify:** Manual — start `npm run gui:bare`, open `http://localhost:3456`, attach a session to a pane, hover header, click clock. Popover opens with both tabs. Clicking History switches the body. Esc closes.

**Steps:**

- [ ] **Step 1: Add the clock button to all 6 pane headers**

In `src/web/public/index.html`, for each of the 6 `.terminal-pane-header` blocks (lines 542, 592, 642, 692, 742, 792), insert this button immediately after the `.terminal-pane-pinnedoc` button and before `.terminal-pane-close`:

```html
<button class="terminal-pane-schedule btn btn-ghost btn-icon btn-sm" title="Scheduled messages" hidden>
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><polyline points="8 4 8 8 10.5 9.5"/></svg>
  <span class="pane-schedule-count" hidden>0</span>
</button>
```

Then, near the end of `index.html` (just before `</body>`, after the existing `<script>` tags that load `terminal.js` and `app.js`), add:

```html
<script src="schedules.js"></script>
```

- [ ] **Step 2: Add CSS for the clock button + popover**

Append to `src/web/public/styles.css` (place near the existing `.terminal-pane-pinnedoc` rules):

```css
/* ─── Schedule clock button ────────────────────────────── */
.terminal-pane-schedule { position: relative; }
.terminal-pane-schedule .pane-schedule-count {
  position: absolute; top: -2px; right: -2px;
  min-width: 14px; height: 14px; padding: 0 3px;
  background: var(--mauve); color: var(--base);
  border-radius: 7px; font-size: 9px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}

/* ─── Schedule popover ─────────────────────────────────── */
.schedule-popover {
  position: absolute;
  z-index: 10004;
  width: 360px; max-width: calc(100vw - 16px);
  background: var(--surface0);
  border: 1px solid var(--surface1);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-family: var(--font-sans, "Plus Jakarta Sans"), sans-serif;
  font-size: 13px;
  color: var(--text);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.schedule-popover-tabs {
  display: flex; border-bottom: 1px solid var(--surface1);
  background: var(--mantle);
}
.schedule-popover-tab {
  flex: 1; padding: 8px 12px; text-align: center;
  background: transparent; border: 0; color: var(--subtext0);
  cursor: pointer; font-size: 12px; font-weight: 600;
  transition: background 150ms, color 150ms;
}
.schedule-popover-tab:hover { background: var(--surface1); color: var(--text); }
.schedule-popover-tab.active {
  color: var(--mauve);
  box-shadow: inset 0 -2px 0 var(--mauve);
}
.schedule-popover-body {
  padding: 12px;
  max-height: 60vh;
  overflow-y: auto;
}

/* ─── Schedule popover form (Task 7) ──────────────────── */
.schedule-form { display: flex; flex-direction: column; gap: 8px; }
.schedule-form label { font-size: 11px; color: var(--subtext1); }
.schedule-form input[type="text"],
.schedule-form input[type="number"],
.schedule-form input[type="datetime-local"],
.schedule-form select {
  width: 100%; padding: 6px 8px;
  background: var(--base); color: var(--text);
  border: 1px solid var(--surface1); border-radius: var(--radius-sm);
  font: inherit;
}
.schedule-form .row { display: flex; gap: 6px; align-items: center; }
.schedule-form .row > * { flex: 0 0 auto; }
.schedule-form .row .num { width: 64px; }
.schedule-form .row .unit { width: 80px; }
.schedule-form .actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
}

/* ─── Schedule list rows ──────────────────────────────── */
.schedule-list { margin-top: 12px; border-top: 1px solid var(--surface1); padding-top: 8px; }
.schedule-list-header {
  font-size: 11px; color: var(--subtext0); text-transform: uppercase;
  letter-spacing: 0.05em; margin-bottom: 4px;
}
.schedule-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 4px; border-radius: var(--radius-sm);
}
.schedule-row:hover { background: var(--surface1); }
.schedule-row .glyph { width: 14px; text-align: center; opacity: 0.8; }
.schedule-row .label { flex: 1; font-family: var(--font-mono, "JetBrains Mono"), monospace; font-size: 12px; }
.schedule-row .when { color: var(--subtext0); font-size: 11px; }
.schedule-row .trash {
  background: transparent; border: 0; color: var(--subtext0);
  cursor: pointer; padding: 2px 4px; border-radius: 4px;
}
.schedule-row .trash:hover { color: var(--red); background: var(--surface2); }
.schedule-empty { color: var(--subtext0); font-size: 12px; padding: 8px 0; text-align: center; }
```

- [ ] **Step 3: Implement the popover scaffold**

Create `src/web/public/schedules.js`:

```javascript
/**
 * Schedule popover — anchors under a pane's clock button and shows a small
 * Active / History form + list. One shared instance, repositioned on each open.
 *
 * Usage: SchedulePopover.toggle(anchorEl, sessionId)
 *        SchedulePopover.close()
 */
(function () {
  'use strict';

  const SchedulePopover = {
    el: null,                // root popover element
    activeTab: 'active',     // 'active' | 'history'
    sessionId: null,
    anchor: null,
    _docHandlers: null,

    toggle(anchorEl, sessionId) {
      if (this.el && this.anchor === anchorEl) {
        this.close();
        return;
      }
      this.open(anchorEl, sessionId);
    },

    open(anchorEl, sessionId) {
      this.sessionId = sessionId;
      this.anchor = anchorEl;
      if (!this.el) this._build();
      this._setTab('active');
      this._reposition();
      this._render();
      this._installDocHandlers();
    },

    close() {
      if (!this.el) return;
      this.el.remove();
      this.el = null;
      this.sessionId = null;
      this.anchor = null;
      this._removeDocHandlers();
    },

    _build() {
      const root = document.createElement('div');
      root.className = 'schedule-popover';
      root.innerHTML = `
        <div class="schedule-popover-tabs">
          <button class="schedule-popover-tab active" data-tab="active">Active</button>
          <button class="schedule-popover-tab" data-tab="history">History</button>
        </div>
        <div class="schedule-popover-body" data-body></div>
      `;
      root.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.schedule-popover-tab');
        if (tabBtn) {
          this._setTab(tabBtn.dataset.tab);
          this._render();
        }
      });
      // Stop clicks inside from bubbling to the document outside-handler
      root.addEventListener('mousedown', (e) => e.stopPropagation());
      document.body.appendChild(root);
      this.el = root;
    },

    _setTab(tab) {
      this.activeTab = tab;
      this.el.querySelectorAll('.schedule-popover-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
    },

    _reposition() {
      if (!this.el || !this.anchor) return;
      const r = this.anchor.getBoundingClientRect();
      const margin = 4;
      const popW = this.el.offsetWidth || 360;
      let left = r.left;
      let top = r.bottom + margin;
      // Clamp inside viewport
      const maxLeft = window.innerWidth - popW - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    },

    _render() {
      const body = this.el.querySelector('[data-body]');
      if (this.activeTab === 'active') {
        body.innerHTML = `<div class="schedule-empty">Active form — coming next task</div>`;
      } else {
        body.innerHTML = `<div class="schedule-empty">History — coming in task 8</div>`;
      }
    },

    _installDocHandlers() {
      const onKey = (e) => { if (e.key === 'Escape') this.close(); };
      const onMouse = (e) => {
        if (!this.el) return;
        if (this.el.contains(e.target)) return;
        if (this.anchor && this.anchor.contains(e.target)) return;
        this.close();
      };
      const onResize = () => this._reposition();
      document.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onMouse);
      window.addEventListener('resize', onResize);
      this._docHandlers = { onKey, onMouse, onResize };
    },

    _removeDocHandlers() {
      if (!this._docHandlers) return;
      document.removeEventListener('keydown', this._docHandlers.onKey);
      document.removeEventListener('mousedown', this._docHandlers.onMouse);
      window.removeEventListener('resize', this._docHandlers.onResize);
      this._docHandlers = null;
    },
  };

  window.SchedulePopover = SchedulePopover;
})();
```

- [ ] **Step 4: Wire the clock click in `app.js`**

In `src/web/public/app.js`, locate the per-pane wiring loop near line 9901 (`panes.forEach((pane, slotIdx) => { ... })`). Find the existing pinned-notes wire-up around line 10103:

```javascript
            this._showPinnedNotesModal(slotIdx);
```

Just after the pinned-notes button block, add a new block for the clock button:

```javascript
        // Schedule button: open the popover anchored to the clock
        const scheduleBtn = pane.querySelector('.terminal-pane-schedule');
        if (scheduleBtn) {
          scheduleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tp = this.terminalPanes[slotIdx];
            if (!tp || !tp.sessionId) return;
            window.SchedulePopover.toggle(scheduleBtn, tp.sessionId);
          });
        }
```

Also, in `openTerminalInPane` (~line 10208), where `uploadBtn2.hidden = false;` is set, add:

```javascript
    const scheduleBtn2 = paneEl.querySelector('.terminal-pane-schedule');
    if (scheduleBtn2) scheduleBtn2.hidden = false;
```

And in `closeTerminalPane` / `onFatalError` paths (`paneEl.classList.add('terminal-pane-empty')`), make sure to re-hide. Search for `.terminal-pane-upload` hiding logic — anywhere it sets `uploadBtn.hidden = true` add the equivalent for `.terminal-pane-schedule`. Also call `window.SchedulePopover && window.SchedulePopover.close()` if the closed pane was the popover anchor's pane.

- [ ] **Step 5: Manual verify**

Restart the server: `npm run gui:bare`. Open http://localhost:3456. Attach any session to a pane. Hover the header — clock button visible. Click — popover opens with two tabs and a placeholder body. Click `History` — body changes. Press Esc — closes. Click clock again — opens. Click in another pane's clock — popover moves.

Open DevTools console — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/index.html src/web/public/styles.css src/web/public/schedules.js src/web/public/app.js
git commit -m "feat(ui): clock button + schedule popover scaffold (tabs only, no data)"
```

---

### Task 7: Frontend — Active tab: form, save, list, delete, count badge

**Goal:** Active tab renders the create form (command, when radio, repeat checkbox, save/cancel) and the list of active schedules with trash buttons. Saving POSTs to the API, deleting with confirm DELETEs. The count badge on the clock button reflects `active.length`.

**Files:**
- Modify: `src/web/public/schedules.js`

**Acceptance Criteria:**
- [ ] Form: text input for command; "when" radios `( ) in [N] [unit ▾]` and `( ) at [datetime-local]`; `Repeat` checkbox enabled only when "in" mode; Cancel + Save buttons.
- [ ] Save calls `POST /api/sessions/:id/schedules` with `{ command, kind, delayMs|fireAt }` derived per the spec mapping; failure → red error text below the form (no toast); success → form clears, list refreshes.
- [ ] Active list shows each schedule as `[icon] command · [when]   [🗑]`, where icon is `⏱` for once and `⟳` for recurring; "when" is `in 4m 12s` for once, `every 5m` for recurring (relative-time updated once per second while popover is open).
- [ ] Trash → `confirm('Delete this schedule?')` → DELETE; list refreshes.
- [ ] Count badge on the clock button shows `active.length` when > 0; hidden when 0.
- [ ] Cancel clears the form (does not close the popover).

**Verify:** Manual — see Step 6 below.

**Steps:**

- [ ] **Step 1: Replace `_render` with the active-tab implementation and add helpers**

In `src/web/public/schedules.js`, replace `_render` and add the helpers below. The full updated module (replace previous `_render` and add new methods inside the SchedulePopover object):

```javascript
    _render() {
      const body = this.el.querySelector('[data-body]');
      if (this.activeTab === 'active') {
        body.innerHTML = this._renderActive();
        this._wireFormHandlers(body);
        this._refreshList();
      } else {
        body.innerHTML = `<div class="schedule-empty">History — coming in task 8</div>`;
      }
    },

    _renderActive() {
      return `
        <form class="schedule-form" data-form>
          <label>Command
            <input type="text" name="command" maxlength="2048" placeholder="e.g. npm test" required />
          </label>
          <label>When</label>
          <div class="row">
            <label><input type="radio" name="when" value="in" checked /> in</label>
            <input class="num" type="number" name="delayN" min="1" value="5" />
            <select class="unit" name="delayUnit">
              <option value="s">sec</option>
              <option value="m" selected>min</option>
              <option value="h">hr</option>
              <option value="d">day</option>
            </select>
          </div>
          <div class="row">
            <label><input type="radio" name="when" value="at" /> at</label>
            <input type="datetime-local" name="fireAt" />
          </div>
          <label class="row">
            <input type="checkbox" name="repeat" />
            <span>Repeat (use the delay above as the interval)</span>
          </label>
          <div class="form-error" data-form-error style="color: var(--red); font-size: 11px; min-height: 14px;"></div>
          <div class="actions">
            <button type="button" data-cancel class="btn btn-ghost btn-sm">Cancel</button>
            <button type="submit" data-save class="btn btn-primary btn-sm">Save</button>
          </div>
        </form>
        <div class="schedule-list" data-list></div>
      `;
    },

    _wireFormHandlers(body) {
      const form = body.querySelector('[data-form]');
      const errorEl = body.querySelector('[data-form-error]');
      const repeatBox = form.querySelector('input[name="repeat"]');
      const inMode = () => form.querySelector('input[name="when"]:checked').value === 'in';
      const updateRepeatEnable = () => {
        repeatBox.disabled = !inMode();
        if (!inMode()) repeatBox.checked = false;
      };
      form.querySelectorAll('input[name="when"]').forEach(r => r.addEventListener('change', updateRepeatEnable));
      updateRepeatEnable();

      form.querySelector('[data-cancel]').addEventListener('click', () => {
        form.reset();
        errorEl.textContent = '';
        updateRepeatEnable();
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        const fd = new FormData(form);
        const command = (fd.get('command') || '').toString();
        const when = fd.get('when');
        const repeat = !!fd.get('repeat');
        let body;
        if (when === 'in') {
          const n = Number(fd.get('delayN'));
          const unit = fd.get('delayUnit');
          const ms = SchedulePopover._unitToMs(n, unit);
          if (!Number.isFinite(ms) || ms < 1000) { errorEl.textContent = 'Delay must be at least 1 second'; return; }
          body = { command, kind: repeat ? 'recurring' : 'once', delayMs: ms };
        } else {
          const ts = fd.get('fireAt');
          if (!ts) { errorEl.textContent = 'Pick a date/time'; return; }
          const fireAt = new Date(ts).getTime();
          if (!Number.isFinite(fireAt)) { errorEl.textContent = 'Invalid date/time'; return; }
          body = { command, kind: 'once', fireAt };
        }
        try {
          const res = await SchedulePopover._fetch('POST', '', body);
          if (!res.ok) {
            errorEl.textContent = (res.json && res.json.error) || `Save failed (${res.status})`;
            return;
          }
          form.reset();
          updateRepeatEnable();
          await this._refreshList();
          this._refreshBadge();
        } catch (err) {
          errorEl.textContent = err.message || 'Network error';
        }
      });
    },

    async _refreshList() {
      const listEl = this.el && this.el.querySelector('[data-list]');
      if (!listEl) return;
      const res = await SchedulePopover._fetch('GET', '');
      if (!res.ok) {
        listEl.innerHTML = `<div class="schedule-empty">Failed to load (${res.status})</div>`;
        return;
      }
      const active = (res.json && res.json.active) || [];
      this._latestActive = active;
      this._renderList(listEl, active);
      this._refreshBadge(active.length);
      this._restartTicker();
    },

    _renderList(listEl, active) {
      if (active.length === 0) {
        listEl.innerHTML = `<div class="schedule-empty">No active schedules</div>`;
        return;
      }
      const rows = active.map(s => `
        <div class="schedule-row" data-id="${s.id}">
          <span class="glyph">${s.kind === 'once' ? '⏱' : '⟳'}</span>
          <span class="label">${escapeHtml(s.command)}</span>
          <span class="when" data-when data-next="${s.nextFireAt}" data-kind="${s.kind}" data-delay="${s.delayMs || 0}"></span>
          <button class="trash" title="Delete">🗑</button>
        </div>
      `).join('');
      listEl.innerHTML = `<div class="schedule-list-header">Active (${active.length})</div>${rows}`;
      listEl.querySelectorAll('.trash').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const row = btn.closest('.schedule-row');
          if (!row) return;
          if (!window.confirm('Delete this schedule?')) return;
          const id = row.dataset.id;
          await SchedulePopover._fetch('DELETE', '/' + id);
          await this._refreshList();
        });
      });
      this._tickRelativeLabels(listEl);
    },

    _tickRelativeLabels(listEl) {
      const now = Date.now();
      listEl.querySelectorAll('[data-when]').forEach(el => {
        const next = Number(el.dataset.next);
        const kind = el.dataset.kind;
        const delay = Number(el.dataset.delay);
        if (kind === 'recurring') {
          el.textContent = '· every ' + SchedulePopover._fmtDuration(delay);
        } else {
          const ms = next - now;
          el.textContent = '· in ' + SchedulePopover._fmtDuration(ms);
        }
      });
    },

    _restartTicker() {
      if (this._tickerHandle) clearInterval(this._tickerHandle);
      this._tickerHandle = setInterval(() => {
        const listEl = this.el && this.el.querySelector('[data-list]');
        if (!listEl) return;
        this._tickRelativeLabels(listEl);
      }, 1000);
    },

    _refreshBadge(count) {
      if (!this.anchor) return;
      const badge = this.anchor.querySelector('.pane-schedule-count');
      if (!badge) return;
      const n = Number.isFinite(count) ? count : (this._latestActive ? this._latestActive.length : 0);
      if (n > 0) {
        badge.textContent = String(n);
        badge.hidden = false;
      } else {
        badge.textContent = '';
        badge.hidden = true;
      }
    },

    _unitToMs(n, unit) {
      const map = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      const u = map[unit];
      if (!u) return NaN;
      return Math.floor(n * u);
    },

    _fmtDuration(ms) {
      if (ms <= 0) return 'now';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      const d = Math.floor(h / 24);
      return d + 'd ' + (h % 24) + 'h';
    },

    async _fetch(method, suffix, body) {
      const url = `/api/sessions/${encodeURIComponent(this.sessionId)}/schedules${suffix}`;
      const opts = {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      };
      // Reuse the app's auth-token convention (read from window.appState if available)
      const token = (window.app && window.app.state && window.app.state.token) || window.AUTH_TOKEN;
      if (token) opts.headers.authorization = 'Bearer ' + token;
      if (body) opts.body = JSON.stringify(body);
      let res;
      try { res = await fetch(url, opts); } catch (err) { throw err; }
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, json };
    },
  };

  // Local helper outside the object literal for HTML escape
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
```

Note: `escapeHtml` lives outside the IIFE-wrapped object — keep the existing `(function () { 'use strict'; ... })()` wrapper and place `escapeHtml` as a `const` inside the wrapper (above `const SchedulePopover = ...`).

- [ ] **Step 2: Update close() to clear the ticker**

Replace the existing `close()` with:

```javascript
    close() {
      if (!this.el) return;
      if (this._tickerHandle) { clearInterval(this._tickerHandle); this._tickerHandle = null; }
      this.el.remove();
      this.el = null;
      this.sessionId = null;
      this.anchor = null;
      this._removeDocHandlers();
    },
```

- [ ] **Step 3: Confirm token plumbing**

Look up how the existing frontend authenticates fetches. In `src/web/public/app.js`, search for `Bearer ` or `authorization`:

```bash
grep -n "Bearer\|authorization" src/web/public/app.js | head
```

If the app stores the token at `this.state.token` (instance level), expose it as `window.app = this` in the constructor or use the same global the app already uses for fetches. **If a different convention is in use, replace the `token = ...` line in `_fetch` to match.**

- [ ] **Step 4: Verify count badge updates on session attach**

In `app.js`, after `openTerminalInPane` finishes wiring (after the `tp.onMobileModeChange` block), call:

```javascript
    // Initial schedule-count fetch so the badge reflects existing schedules.
    if (window.SchedulePopover && tp.sessionId) {
      const scheduleBtn3 = paneEl.querySelector('.terminal-pane-schedule');
      if (scheduleBtn3) {
        fetch(`/api/sessions/${encodeURIComponent(tp.sessionId)}/schedules`, {
          headers: { authorization: 'Bearer ' + (this.state.token || '') },
          credentials: 'same-origin',
        }).then(r => r.json()).then(data => {
          const n = (data && data.active) ? data.active.length : 0;
          const badge = scheduleBtn3.querySelector('.pane-schedule-count');
          if (badge) {
            badge.textContent = n > 0 ? String(n) : '';
            badge.hidden = !(n > 0);
          }
        }).catch(() => {});
      }
    }
```

- [ ] **Step 5: Manual verify**

Restart the server. Attach a session to a pane. Click clock. Form appears. Type `echo hi`, leave defaults (5 min), uncheck repeat, click Save. Form clears, list shows `⏱ echo hi · in 5m 0s [🗑]`, badge shows `1`. Click trash, confirm — list clears, badge gone.

Test recurring: type `date`, set delay to `5 sec`, check Repeat, Save. List shows `⟳ date · every 5s`. Wait ~10 seconds and watch the actual terminal pane — you should see `date` typed and executed every 5 seconds. Trash to clean up.

Test absolute time: type `pwd`, switch to "at" radio, pick 2 minutes from now, leave Repeat unchecked (and verify it's disabled). Save. Wait — command appears in the pane after 2 minutes.

Test validation: empty command → `command must be a non-empty string`. Delay 0 sec → form-side error.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/schedules.js src/web/public/app.js
git commit -m "feat(ui): schedule popover Active tab — form, list, save, delete, count badge"
```

---

### Task 8: Frontend — History tab + polling + final polish + screenshot

**Goal:** History tab renders the last N executions with status icons and skip-collapse rendering. Popover polls `GET /api/sessions/:id/schedules` every 5 s while open. Mobile and pane-close edge cases handled. Capture screenshot.

**Files:**
- Modify: `src/web/public/schedules.js` (history rendering, poller, mobile)
- Modify: `src/web/public/styles.css` (mobile-specific tweak)
- Modify: `src/web/public/app.js` (close popover when its pane closes)
- Create: `screenshots/scheduled-messages.png` (manual)

**Acceptance Criteria:**
- [ ] History tab lists rows newest-first.
- [ ] Success rows show `✓ command · 5m ago`. Skip rows show `⊘ Skipped 12 — session not running` (or `· missed while server down`) with a relative timestamp.
- [ ] If `skipCount === 1`, the row shows `⊘ Skipped — session not running` (singular). If > 1, shows `⊘ Skipped <n> — ...`.
- [ ] While the popover is open, it re-fetches every 5 seconds and re-renders the visible tab.
- [ ] When the pane hosting the popover's anchor closes, the popover closes.
- [ ] On mobile (`@media (max-width: 768px)`) the clock button stays visible (unlike `.terminal-pane-upload`).
- [ ] Screenshot captured at `screenshots/scheduled-messages.png`.

**Verify:** Manual — see Step 5.

**Steps:**

- [ ] **Step 1: Implement history rendering and the poller**

In `src/web/public/schedules.js`:

Replace the `History — coming in task 8` placeholder branch in `_render` with:

```javascript
      } else {
        body.innerHTML = `<div class="schedule-list" data-history></div>`;
        this._refreshHistory();
      }
```

Add these methods to the SchedulePopover object:

```javascript
    async _refreshHistory() {
      const histEl = this.el && this.el.querySelector('[data-history]');
      if (!histEl) return;
      const res = await SchedulePopover._fetch('GET', '');
      if (!res.ok) {
        histEl.innerHTML = `<div class="schedule-empty">Failed to load (${res.status})</div>`;
        return;
      }
      const rows = (res.json && res.json.history) || [];
      if (rows.length === 0) {
        histEl.innerHTML = `<div class="schedule-empty">No history yet</div>`;
        return;
      }
      const now = Date.now();
      histEl.innerHTML = rows.map(r => {
        const ago = SchedulePopover._fmtAgo(now - r.firedAt);
        if (r.status === 'success') {
          return `<div class="schedule-row">
            <span class="glyph" style="color:var(--green)">✓</span>
            <span class="label">${escapeHtml(r.command)}</span>
            <span class="when">· ${ago}</span>
          </div>`;
        }
        const reason =
          r.skipReason === 'session-not-running' ? 'session not running'
          : r.skipReason === 'missed-while-down' ? 'missed while server down'
          : 'skipped';
        const count = r.skipCount > 1 ? `Skipped ${r.skipCount} — ${reason}` : `Skipped — ${reason}`;
        return `<div class="schedule-row">
          <span class="glyph" style="color:var(--peach)">⊘</span>
          <span class="label" style="color:var(--subtext0)">${count}</span>
          <span class="when">· ${ago}</span>
        </div>`;
      }).join('');
    },

    _fmtAgo: (function () {
      return function (ms) {
        if (ms < 60_000) return Math.max(1, Math.floor(ms / 1000)) + 's ago';
        if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
        if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
        return Math.floor(ms / 86_400_000) + 'd ago';
      };
    })(),

    _startPoller() {
      this._stopPoller();
      this._pollHandle = setInterval(() => {
        if (!this.el) return;
        if (this.activeTab === 'active') this._refreshList();
        else this._refreshHistory();
      }, 5000);
    },

    _stopPoller() {
      if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
    },
```

Update `open()` to start the poller, and `close()` to stop it:

```javascript
    open(anchorEl, sessionId) {
      this.sessionId = sessionId;
      this.anchor = anchorEl;
      if (!this.el) this._build();
      this._setTab('active');
      this._reposition();
      this._render();
      this._installDocHandlers();
      this._startPoller();
    },

    close() {
      if (!this.el) return;
      if (this._tickerHandle) { clearInterval(this._tickerHandle); this._tickerHandle = null; }
      this._stopPoller();
      this.el.remove();
      this.el = null;
      this.sessionId = null;
      this.anchor = null;
      this._removeDocHandlers();
    },
```

- [ ] **Step 2: Mobile media-query carve-out**

The existing block at the end of `styles.css` hides `.terminal-pane-upload` under `@media (max-width: 768px)`. The clock button is in the header (not a floating button), so it remains visible by default. No CSS change needed — verify by inspection.

- [ ] **Step 3: Close popover when its pane closes**

In `src/web/public/app.js`, find `closeTerminalPane(slotIdx)` (search for that method). At the very top of the function (before any other logic), add:

```javascript
    // If our schedule popover is anchored on this pane's clock, close it.
    if (window.SchedulePopover && window.SchedulePopover.anchor) {
      const paneEl = document.getElementById(`term-pane-${slotIdx}`);
      if (paneEl && paneEl.contains(window.SchedulePopover.anchor)) {
        window.SchedulePopover.close();
      }
    }
```

Apply the same guard in `tp.onFatalError` (the existing fatal-error close path inside `openTerminalInPane`).

Also hide the `.terminal-pane-schedule` button when the pane goes empty (mirroring how upload is hidden):

```javascript
      const scheduleBtn3 = deadPane.querySelector('.terminal-pane-schedule');
      if (scheduleBtn3) scheduleBtn3.hidden = true;
```

- [ ] **Step 4: Take a screenshot**

Restart the server. Attach any session to a pane. Click the clock. Click "Save" on a sample form (e.g. `echo demo`, in 30 sec, no repeat). Take a screenshot showing the popover open with at least one active schedule.

```bash
mkdir -p screenshots
# Use any tool: macOS Cmd+Shift+4, Linux gnome-screenshot, Windows snipping tool, etc.
# Save to: screenshots/scheduled-messages.png
```

(If the project has a Playwright screenshot script, prefer that.)

- [ ] **Step 5: Manual end-to-end verify**

1. Reload page. Hover header → clock visible. Click clock → popover opens.
2. Save a recurring schedule `date` every 5 sec. Watch the terminal: `date` is typed and executed every 5 seconds.
3. Switch to History tab → see `✓ date · 5s ago` entries appearing.
4. Stop the pty (Ctrl+C the claude session, or close & reopen pane to detach).
5. Wait through several intervals. History shows `⊘ Skipped <n> — session not running` collapsed into one row with growing `n`.
6. Close popover (Esc). Re-open. Last state restored.
7. Restart the server. Re-open page. Active schedule still listed. Recurring continues to fire.
8. Delete the schedule via trash. Confirm. Gone from active.
9. Click `Active` → `History` rapidly multiple times: no console errors, no leaked timers (DevTools Performance / "Setup intervals" sanity check).

- [ ] **Step 6: Commit**

```bash
git add src/web/public/schedules.js src/web/public/app.js screenshots/scheduled-messages.png
git commit -m "feat(ui): schedule popover History tab + 5s polling + screenshot"
```

- [ ] **Step 7: Final regression sweep**

```bash
npm test                                 # store + module tests still green
node test/scheduler.test.js              # 23 passed
node test/scheduler-api.test.js          # 8 passed
```

If anything is red, fix and re-commit before finishing.

---

## Verification Summary

After all 8 tasks, the feature is complete when:

- [ ] `node test/scheduler.test.js` → 23 passed
- [ ] `node test/scheduler-api.test.js` → 8 passed
- [ ] `npm test` (existing tests) — still green
- [ ] Manual scenarios from Task 8 step 5 all pass
- [ ] `screenshots/scheduled-messages.png` exists
- [ ] `~/.myrlin/schedules.json` exists after the first save and is valid JSON
- [ ] All commits land on `feat/schedule-messages` branch
