-- Smart Operator Assistant — schema
-- Requires: PostgreSQL 13+, TimescaleDB extension (for telemetry hypertable)

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operator','supervisor','trainer','admin')),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE machines (
  id            TEXT PRIMARY KEY,        -- e.g. CAT320-EXC-014
  model         TEXT,
  engine_hours  NUMERIC DEFAULT 0
);

CREATE TABLE work_orders (
  id                SERIAL PRIMARY KEY,
  machine_id        TEXT REFERENCES machines(id),
  title             TEXT,
  zone              TEXT,
  target_volume_m3  NUMERIC,
  completed_volume_m3 NUMERIC DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE milestones (
  id             SERIAL PRIMARY KEY,
  work_order_id  INTEGER REFERENCES work_orders(id),
  label          TEXT,
  status         TEXT CHECK (status IN ('pending','active','done')) DEFAULT 'pending',
  sort_order     INTEGER DEFAULT 0
);

-- Time-series telemetry (converted to a hypertable below)
CREATE TABLE telemetry (
  time            TIMESTAMPTZ NOT NULL DEFAULT now(),
  machine_id      TEXT REFERENCES machines(id),
  operator_id     INTEGER REFERENCES users(id),
  rpm             NUMERIC,
  speed_kmh       NUMERIC,
  seatbelt        BOOLEAN,
  prox_distance_m NUMERIC,
  prox_zone       TEXT,
  load_kg         NUMERIC,
  load_limit_kg   NUMERIC
);
SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);

CREATE TABLE anomaly_events (
  id           SERIAL PRIMARY KEY,
  machine_id   TEXT REFERENCES machines(id),
  category     TEXT,            -- idle | load | proximity | seatbelt | maneuver
  severity     TEXT CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  message      TEXT,
  occurred_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE incidents (
  id           SERIAL PRIMARY KEY,
  machine_id   TEXT REFERENCES machines(id),
  operator_id  INTEGER REFERENCES users(id),
  type         TEXT CHECK (type IN ('near_miss','incident')),
  tag          TEXT,
  lat          NUMERIC,
  lng          NUMERIC,
  notes        TEXT,
  voice_note_url TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE training_modules (
  id          SERIAL PRIMARY KEY,
  title       TEXT,
  duration_sec INTEGER,
  offline_available BOOLEAN DEFAULT true
);

CREATE TABLE training_progress (
  user_id     INTEGER REFERENCES users(id),
  module_id   INTEGER REFERENCES training_modules(id),
  progress_pct INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE trainers (
  id    SERIAL PRIMARY KEY,
  name  TEXT,
  type  TEXT CHECK (type IN ('instructor','peer'))
);

CREATE TABLE trainer_slots (
  id          SERIAL PRIMARY KEY,
  trainer_id  INTEGER REFERENCES trainers(id),
  slot_time   TIMESTAMPTZ,
  is_booked   BOOLEAN DEFAULT false
);

CREATE TABLE bookings (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  slot_id     INTEGER REFERENCES trainer_slots(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_telemetry_machine_time ON telemetry (machine_id, time DESC);
CREATE INDEX idx_anomaly_machine_time ON anomaly_events (machine_id, occurred_at DESC);

-- ---------- Seed data (demo) ----------
INSERT INTO machines (id, model, engine_hours) VALUES ('CAT320-EXC-014', 'CAT 320 Excavator', 1240)
  ON CONFLICT (id) DO NOTHING;

INSERT INTO work_orders (machine_id, title, zone, target_volume_m3, completed_volume_m3)
  VALUES ('CAT320-EXC-014', 'Grading — Zone C', 'Zone C', 500, 310);

INSERT INTO milestones (work_order_id, label, status, sort_order) VALUES
  (1, 'Move 300 m3 soil', 'done', 1),
  (1, 'Level Zone A', 'done', 2),
  (1, 'Level Zone B', 'active', 3),
  (1, 'Compact Zone C', 'pending', 4);

INSERT INTO training_modules (title, duration_sec) VALUES
  ('Seatbelt policy', 120),
  ('Idle reduction basics', 240),
  ('Hydraulic load limits', 180);

INSERT INTO trainers (name, type) VALUES
  ('R. Fernandes', 'instructor'),
  ('OP-1042', 'peer');

INSERT INTO trainer_slots (trainer_id, slot_time) VALUES
  (1, '2026-09-24T14:00:00Z'),
  (2, '2026-09-24T16:00:00Z');
