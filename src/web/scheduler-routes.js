/**
 * HTTP route adapters for the scheduler engine.
 * Mounted by server.js (production) and by test/scheduler-api.test.js (tests).
 */

function mountScheduleRoutes(app, { requireAuth, scheduler, store }) {
  app.get('/api/schedules/summary', requireAuth, (req, res) => {
    res.json({ counts: scheduler.activeCounts() });
  });

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
