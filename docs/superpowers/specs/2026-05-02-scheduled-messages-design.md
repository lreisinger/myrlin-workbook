# Scheduled Messages — Design Spec

**Status:** approved
**Branch:** `feat/schedule-messages`
**Date:** 2026-05-02

## Goal

Let a user queue a shell command to be sent into a specific pty session on a delay (one-off) or on repeat (recurring). Schedules survive server restarts. Created and managed from a small popover anchored to the terminal pane header.

## Scope

- Server-side scheduler that fires by writing the command + `\r` to `session.pty.write()`.
- Schedule binding is to the **pty session** (`sessionId`), not the pane slot. Schedules continue to fire even when no UI client is attached or the pane is closed; the pty's existing scrollback captures the output.
- One popover UI, anchored under a clock button added to every terminal pane header.
- Persisted state survives server restart.

Out of scope for v1: editing existing schedules, cron-style wall-clock recurrence (e.g. "every weekday 09:00"), bracketed-paste / multi-line commands, push-based UI updates (polling is fine), per-user config of history cap.

## Modules & Boundaries

| File | Role | Status |
|------|------|--------|
| `src/web/scheduler.js` | Engine: timers, fire flow, persistence | new |
| `src/web/server.js` | Mount 4 HTTP endpoints | edit |
| `src/web/public/schedules.js` | Popover component (`SchedulePopover` class) | new |
| `src/web/public/app.js` | Wire clock button + per-pane popover toggle + count badge | edit |
| `src/web/public/index.html` | Add `<button class="terminal-pane-schedule">` to each of the 6 pane headers; load `schedules.js` | edit |
| `src/web/public/styles.css` | Clock button + popover styles (Catppuccin tokens) | edit |
| `test/scheduler.test.js` | Engine unit tests | new |
| `test/scheduler-api.test.js` | HTTP route tests | new |
| `test/run.js` | Register the two new test files | edit |

`scheduler.js` does **not** know about Express or HTTP. Route handlers in `server.js` are thin adapters. The engine is unit-testable with a fake pty manager and an injectable clock.

`pty-manager.js` is **not** modified. The scheduler calls `ptyManager.getSession(sessionId).pty.write(text)` — the same primitive the WebSocket input handler uses.

## Data Model

Single file: `~/.myrlin/schedules.json` (separate from `workspaces.json`).

```jsonc
{
  "schedules": {
    "<id>": {
      "id":         "uuid",
      "sessionId":  "string",
      "command":    "string",        // bytes written before "\r"
      "kind":       "once" | "recurring",

      // exactly one of these is the timing source
      "delayMs":    1234567,         // for "once" delay-mode AND for "recurring" interval
      "fireAt":     1714650000000,   // ms epoch; "once" absolute-mode only

      "nextFireAt": 1714650000000,   // ms epoch (computed; recurring updates each fire)
      "createdAt":  1714649000000
    }
  },
  "history": {
    "<sessionId>": [
      {
        "id":          "uuid",       // schedule id at fire time (may no longer be active)
        "command":     "string",     // snapshotted — survives schedule deletion
        "firedAt":     1714650000000,
        "scheduledAt": 1714650000000,
        "status":      "success" | "skipped",
        "skipReason":  "session-not-running" | "missed-while-down" | null,
        "skipCount":   1             // ≥1; consecutive same-(id, reason) skips collapse
      }
    ]
  }
}
```

Notes:

- One `kind` flag, two timing fields. `delayMs` covers both "once after 5m" and "every 5m"; `fireAt` only exists for absolute one-offs.
- History rows snapshot `command` so deleting an active schedule doesn't blank old entries.
- Skip collapsing happens at write time. On a skip, if the most recent history row for that session has `status === 'skipped'`, same `id`, and same `skipReason`, increment `skipCount` and update `firedAt`; else append.
- History trims to **50 newest rows per session** on every append.

## Scheduler Engine

`scheduler.js` exports a singleton `Scheduler`. `server.js` calls `scheduler.start()` after `ptyManager` is wired and `scheduler.stop()` on shutdown.

### `start()` — boot recovery

1. Read `~/.myrlin/schedules.json`. If missing, init empty and save.
2. For each active schedule:
   - `kind === 'once'` and `nextFireAt < now`: append one `skipped: missed-while-down` history row, delete the schedule, persist.
   - `kind === 'recurring'` and `nextFireAt < now`: advance `nextFireAt = now + delayMs` (no catch-up), persist, then `setTimeout(fire, delayMs)`.
   - Else: `setTimeout(fire, nextFireAt - now)`.

### `fire(scheduleId)`

1. Load the active schedule. If gone, no-op.
2. `session = ptyManager.getSession(sessionId)`.
3. If `!session || !session.alive`: append/coalesce a `skipped: session-not-running` history row. If `kind === 'recurring'`, re-arm normally (`nextFireAt = now + delayMs`, persist, `setTimeout`). If `kind === 'once'`, delete the schedule — uniform rule: a one-off is consumed by its single fire attempt regardless of outcome. The user can re-create it if they want a retry.
4. Else: `session.pty.write(command + '\r')`. Append a `success` history row.
5. If `kind === 'recurring'`: `nextFireAt = now + delayMs`, persist, `setTimeout(fire, delayMs)`.
6. If `kind === 'once'`: delete the schedule from `schedules`, persist.

### Persistence

- Atomic write via tmp file + rename (mirrors `store.js`).
- Debounced 200 ms — coalesces a burst of fires into a single disk write.
- Synchronous flush on `stop()`.

### Cleanup on session deletion

`Scheduler.start()` subscribes to the existing `Store` `EventEmitter` (`store.on('session:deleted', ({ id }) => ...)`). When a session is deleted, all of its active schedules are cleared (timers cancelled) and its history block is removed, then persisted.

## HTTP API

All under `/api/sessions/:id/schedules`. All `requireAuth`. All return JSON.

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET    | `/api/sessions/:id/schedules`             | —                                      | `{ active: Schedule[], history: HistoryRow[] }` |
| POST   | `/api/sessions/:id/schedules`             | `{ command, kind, delayMs?, fireAt? }` | `{ schedule: Schedule }` |
| DELETE | `/api/sessions/:id/schedules/:scheduleId` | —                                      | `{ success: true }` |
| DELETE | `/api/sessions/:id/schedules/history`     | —                                      | `{ success: true }` |

### POST validation

- `command`: non-empty string, ≤ 2 KB. Content is **not** sanitized — it's the user's own pty.
- `kind`: `"once"` or `"recurring"`.
- `delayMs`: integer ≥ 1000 (1 s minimum) and ≤ 30 days (`30 * 86_400_000`).
- `fireAt`: integer ms epoch. Must be in the future. Only valid when `kind === 'once'`.
- Exactly one of `delayMs` / `fireAt` for `once`; `delayMs` required for `recurring`.
- Reject with HTTP 400 + `{ error: '<reason>' }` on any failure.

POST computes `nextFireAt` server-side (`fireAt` directly, or `now + delayMs`), assigns a uuid, persists, arms the timer, returns the full schedule object. The session must exist in the store; otherwise 404.

## UI Surface

### Clock button

New element added to each of the 6 `.terminal-pane-header` blocks in `index.html`, placed between `.terminal-pane-pinnedoc` and `.terminal-pane-close`:

```html
<button class="terminal-pane-schedule btn btn-ghost btn-icon btn-sm" title="Scheduled messages" hidden>
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <!-- clock glyph -->
  </svg>
  <span class="pane-schedule-count" hidden></span>
</button>
```

- Same hover-reveal rules as `.terminal-pane-upload` (visible on pane hover and on active pane).
- `hidden` until the pane has a session attached.
- Count badge appears when `active.length > 0`; styled like the existing `.pane-pin-count`.

### Popover

A single shared instance, lazily constructed on first click. Mounted to `<body>` and positioned absolutely below the clicked clock button using `getBoundingClientRect()`, clamped to the viewport.

Layout (≈ 360 px wide):

```
┌──────────────────────────────────────────┐
│ [ Active ]  History                      │  ← tabs
├──────────────────────────────────────────┤
│ Active tab:                              │
│   command:   [_________________________] │
│   when:      ( ) in [ 30 ] [min ▾]       │
│              ( ) at [ 2026-05-03 09:00 ] │
│   ☐ Repeat (use the same delay as the    │  ← enabled only when "in" radio
│       interval)                          │     is selected
│   [ Cancel ]              [ Save ]       │
│   ── Active (2) ──────────────────────── │
│   ⏱ npm test     · in 4m 12s     [🗑]    │
│   ⟳ git status   · every 1h      [🗑]    │
│                                          │
│ History tab:                             │
│   ✓ npm test          · 5m ago           │
│   ⊘ Skipped 12 — session not running     │
│   ✓ git status        · 1h ago           │
└──────────────────────────────────────────┘
```

UX details:
- **Form has one path**: a "when" radio (`in N units` vs `at datetime`) + a `Repeat` checkbox that's only enabled in the `in` mode. There is no separate `Once / Recurring` dropdown — the checkbox is the only thing that distinguishes the two kinds.
- **Mapping to the data model:**
  - `in N units`, repeat off → `kind: 'once'`, `delayMs: N * unitMs`
  - `in N units`, repeat on  → `kind: 'recurring'`, `delayMs: N * unitMs` (the delay IS the recurring interval)
  - `at <datetime>`          → `kind: 'once'`, `fireAt: <epoch ms>` (Repeat is disabled in this mode in v1)
- **Unit dropdowns** offer `sec / min / hr / day`.
- **`at` datetime input** uses `<input type="datetime-local">`.
- **Trash → confirm:** single `confirm('Delete this schedule?')`, then DELETE.
- **Cancel** clears the form (does not close the popover). Clicking outside or **Esc** closes the popover.
- **Active list relative-time labels** (`in 4m 12s`, `every 1h`) update once per second while the popover is open.
- **Live refresh:** popover polls `GET /api/sessions/:id/schedules` every 5 s while open, and re-fetches once on every Save / Delete. Count badge refreshes from the same response.
- **Mobile:** same layout; the same media query that hides `.terminal-pane-upload` does NOT hide `.terminal-pane-schedule` — it lives in the always-visible header rather than the floating layer.

### Status icons (history tab)

| Glyph | Meaning |
|-------|---------|
| `✓`   | success |
| `⊘`   | skipped |

`skipReason` displayed inline. Consecutive skip rows render as one collapsed row using `skipCount`.

## Behaviour Recap (decisions)

| Question | Answer |
|----------|--------|
| Schedule binds to | `sessionId` (pty session) — fires regardless of pane open/closed |
| One-off missed during downtime | Skip with `missed-while-down`, delete |
| Recurring missed during downtime | No catch-up; advance `nextFireAt = now + delayMs`, resume |
| Pty stopped at fire time | Skip + record (`session-not-running`); recurring re-arms; one-off is deleted (consumed by its one fire attempt) |
| History cap | 50 rows per session, hard prune on append |
| Editable schedules | No — delete + re-create |
| What's written | Exact `command` string + `\r` |
| Time units | sec / min / hr / day |

## Testing

`test/scheduler.test.js` — engine unit tests with a fake `ptyManager` (records writes) and an injectable clock:
- one-off fires once at `nextFireAt`, removed afterward
- recurring fires repeatedly, persists `nextFireAt` after each fire
- boot recovery: one-off in the past → skipped + deleted
- boot recovery: recurring in the past → advanced, no catch-up
- pty stopped at fire time → skipped row written; recurring re-arms; one-off deleted
- skip collapse: 3 consecutive same-reason skips → 1 row with `skipCount === 3`
- history trims to 50 on append
- persistence round-trip: write, restart, schedules and history identical

`test/scheduler-api.test.js` — drives the four routes through Express:
- POST validation (good/bad bodies)
- POST creates, GET returns it, DELETE removes it
- DELETE history clears the session's history block

Both files registered in `test/run.js`. Frontend verified by a screenshot in `screenshots/scheduled-messages.png`.

## Out of Scope (v1)

- Editing schedules
- Cron-style ("every weekday at 09:00") recurrence
- Multi-line / bracketed-paste commands
- Push-based UI sync (we poll)
- Sharing schedules across sessions
- Auto-restart of stopped pty sessions on fire
