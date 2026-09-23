const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const TelemetrySimulator = require('./simulate');
const path = require('path');
const { evaluate, getIdleSeconds } = require('./anomalyRules');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 4000;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves the tablet UI at /

// Confirms the DB container is actually reachable — full CRUD migration is the next step (see README)
app.get('/api/v1/health', async (req, res) => {
  if (!pool) return res.json({ api: 'ok', database: 'not_configured' });
  try {
    await pool.query('SELECT 1');
    res.json({ api: 'ok', database: 'connected' });
  } catch (e) {
    res.status(500).json({ api: 'ok', database: 'unreachable', error: e.message });
  }
});

// ---------- In-memory demo store (swap for the Postgres schema.sql in production) ----------
const db = {
  workOrder: {
    work_order_id: 'WO-88213', title: 'Grading — Zone C', zone: 'Zone C',
    target_volume_m3: 500, completed_volume_m3: 310,
    milestones: [
      { id: 'M1', label: 'Move 300 m3 soil', status: 'done' },
      { id: 'M2', label: 'Level Zone A', status: 'done' },
      { id: 'M3', label: 'Level Zone B', status: 'active' },
      { id: 'M4', label: 'Compact Zone C', status: 'pending' }
    ]
  },
  incidents: [],
  alerts: [],
  trainingModules: [
    { id: 1, title: 'Seatbelt policy', duration_sec: 120 },
    { id: 2, title: 'Idle reduction basics', duration_sec: 240 },
    { id: 3, title: 'Hydraulic load limits', duration_sec: 180 }
  ],
  trainerSlots: [
    { id: 1, trainer: 'R. Fernandes (instructor)', slot: '2026-09-24T14:00:00Z', booked: false },
    { id: 2, trainer: 'OP-1042 (peer)', slot: '2026-09-24T16:00:00Z', booked: false }
  ]
};

// ---------- Auth (stub — real deploy should verify against `users` table with bcrypt) ----------
function authRequired(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.replace('Bearer ', '');
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'insufficient_role' });
      }
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'invalid_or_missing_token' });
    }
  };
}

// Demo login — issues a JWT for a given role. Replace with real credential check.
app.post('/api/v1/auth/login', (req, res) => {
  const { name = 'Demo Operator', role = 'operator' } = req.body;
  if (!['operator', 'supervisor', 'trainer', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  const token = jwt.sign({ name, role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role, name });
});

// ---------- Work orders / tasks ----------
app.get('/api/v1/work-orders/today', authRequired(), (req, res) => {
  res.json(db.workOrder);
});

app.post('/api/v1/work-orders/progress', authRequired(['operator', 'supervisor']), (req, res) => {
  const { delta = 8 } = req.body;
  const wo = db.workOrder;
  wo.completed_volume_m3 = Math.min(wo.target_volume_m3, wo.completed_volume_m3 + delta);
  const pct = (wo.completed_volume_m3 / wo.target_volume_m3) * 100;
  const next = wo.milestones.find(m => m.status === 'active');
  if (next && pct >= (wo.milestones.indexOf(next) + 1) * 25) {
    next.status = 'done';
    const upcoming = wo.milestones.find(m => m.status === 'pending');
    if (upcoming) upcoming.status = 'active';
  }
  res.json(wo);
});

// ---------- ETA ----------
app.get('/api/v1/tasks/:id/eta', authRequired(), (req, res) => {
  const wo = db.workOrder;
  const remaining = wo.target_volume_m3 - wo.completed_volume_m3;
  const baseRate = 62; // m3/hr, would come from historical_avg_rate(operator_id, task_type)
  const siteMultiplier = 1.15;
  const shiftHours = 4; // demo constant; production reads real shift clock
  const fatigue = shiftHours > 6 ? 0.85 : 1.0;
  const effectiveRate = baseRate * siteMultiplier * fatigue;
  const hours = remaining / effectiveRate;
  res.json({
    work_order_id: wo.work_order_id,
    estimated_remaining_minutes: Math.round(hours * 60),
    confidence: 0.78,
    factors: { avg_operator_rate_m3_per_hr: baseRate, site_condition_multiplier: siteMultiplier, remaining_volume_m3: remaining }
  });
});

// ---------- Incidents ----------
app.post('/api/v1/incidents', authRequired(['operator']), (req, res) => {
  const incident = { ...req.body, id: `INC-${Date.now()}`, created_at: new Date().toISOString() };
  db.incidents.unshift(incident);
  res.status(201).json({ incident_id: incident.id, status: 'logged' });
});
app.get('/api/v1/incidents', authRequired(['operator', 'supervisor']), (req, res) => {
  res.json(db.incidents.slice(0, 50));
});

// ---------- Training ----------
app.get('/api/v1/training/modules', authRequired(), (req, res) => res.json(db.trainingModules));
app.get('/api/v1/training/slots', authRequired(), (req, res) => res.json(db.trainerSlots.filter(s => !s.booked)));
app.post('/api/v1/training/bookings', authRequired(), (req, res) => {
  const slot = db.trainerSlots.find(s => s.id === req.body.slot_id);
  if (!slot || slot.booked) return res.status(409).json({ error: 'slot_unavailable' });
  slot.booked = true;
  res.status(201).json({ booking_id: `BK-${Date.now()}`, slot });
});

// ---------- Analytics ----------
app.get('/api/v1/analytics/summary', authRequired(['operator', 'supervisor']), (req, res) => {
  const counts = db.alerts.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {});
  res.json({ counts, recent: db.alerts.slice(0, 20) });
});

const server = app.listen(PORT, () => console.log(`API listening on :${PORT}`));

// ---------- WebSocket telemetry push ----------
const wss = new WebSocketServer({ server, path: '/ws/telemetry' });
const sim = new TelemetrySimulator();
sim.start(1500);

sim.on('frame', (frame) => {
  const flags = evaluate(frame);
  const alertOut = flags.map(f => ({ ...f, machine_id: frame.machine_id, timestamp: frame.timestamp }));
  alertOut.forEach(a => db.alerts.unshift(a));
  db.alerts = db.alerts.slice(0, 100);

  const message = JSON.stringify({ frame, alerts: alertOut, idle_seconds: getIdleSeconds(frame.machine_id) });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(message);
  });
});

// Simulator control endpoints (mirrors the Sim tab in the prototype)
app.post('/api/v1/sim/inject/:type', authRequired(['admin', 'supervisor']), (req, res) => {
  const { type } = req.params;
  if (typeof sim[`inject${type[0].toUpperCase()}${type.slice(1)}`] === 'function') {
    sim[`inject${type[0].toUpperCase()}${type.slice(1)}`]();
    return res.json({ status: 'injected', type });
  }
  res.status(400).json({ error: 'unknown_injection_type' });
});
app.post('/api/v1/sim/toggle', authRequired(['admin', 'supervisor']), (req, res) => {
  sim.running ? sim.stop() : sim.start(1500);
  res.json({ running: sim.running });
});

module.exports = { app, sim };
