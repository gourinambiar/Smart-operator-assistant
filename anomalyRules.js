// Rule-based anomaly detection — mirrors the logic in the architecture spec.
// Stateful per machine: an idle-seconds accumulator, plus per-category "episodes".
// An alert fires ONCE when an episode starts, and again only if severity ESCALATES within
// it. Severity dipping back down (e.g. a distance jittering around a threshold) does not
// re-alert. An episode ends only after CLEAR_TICKS quiet ticks, so borderline values don't flap.

const idleAccumulators = {}; // machine_id -> seconds
const episodes = {};         // machine_id -> { category -> { rank, quiet } } for alert episodes in progress

const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const CLEAR_TICKS = 3;       // an episode only ends after this many consecutive ticks with no flag (hysteresis)

const THRESHOLDS = {
  IDLE_SECONDS: 60,         // demo value; spec/production default is 300
  SPEED_JERK_KMH: 8,
  PROXIMITY_CRITICAL_M: 3,
  PROXIMITY_WARNING_M: 6
};

function evaluate(frame, tickIntervalSec = 1.5) {
  const raw = [];
  const machineId = frame.machine_id;
  const { rpm, status } = frame.engine;
  const speed = frame.motion.speed_kmh;
  const load = frame.hydraulics.load_kg;
  const limit = frame.hydraulics.load_limit_kg;
  const seatbelt = frame.safety.seatbelt_fastened;
  const proximity = frame.safety.proximity || [];

  // Excessive idling
  if (status === 'running' && speed < 0.5 && load < 200) {
    idleAccumulators[machineId] = (idleAccumulators[machineId] || 0) + tickIntervalSec;
    if (idleAccumulators[machineId] > THRESHOLDS.IDLE_SECONDS) {
      raw.push({ category: 'idle', severity: 'MEDIUM', message: 'Excessive idling detected' });
    }
  } else {
    idleAccumulators[machineId] = 0;
  }

  // Unsafe load
  if (load > limit * 0.95 && load <= limit) {
    raw.push({ category: 'load', severity: 'HIGH', message: `Load near limit (${load}kg)` });
  }
  if (load > limit) {
    raw.push({ category: 'load', severity: 'CRITICAL', message: `Load limit exceeded (${load}kg)` });
  }

  // Proximity (worst object only, so one alert per tick at most)
  const closest = proximity.reduce((min, p) => (!min || p.distance_m < min.distance_m ? p : min), null);
  if (closest) {
    if (closest.distance_m < THRESHOLDS.PROXIMITY_CRITICAL_M) {
      raw.push({ category: 'proximity', severity: 'CRITICAL', message: `Object ${closest.distance_m}m ${closest.zone}` });
    } else if (closest.distance_m < THRESHOLDS.PROXIMITY_WARNING_M) {
      raw.push({ category: 'proximity', severity: 'MEDIUM', message: `Object ${closest.distance_m}m ${closest.zone}` });
    }
  }

  // Seatbelt
  if (status === 'running' && !seatbelt) {
    raw.push({ category: 'seatbelt', severity: 'HIGH', message: 'Seatbelt not fastened' });
  }

  // Dedupe with hysteresis: one alert per episode, plus one per severity escalation.
  const eps = (episodes[machineId] = episodes[machineId] || {});
  const worst = {};
  raw.forEach(f => {
    if (!worst[f.category] || RANK[f.severity] > RANK[worst[f.category].severity]) worst[f.category] = f;
  });
  const out = [];
  Object.keys(worst).forEach(cat => {
    const f = worst[cat];
    const ep = eps[cat];
    if (!ep) {
      eps[cat] = { rank: RANK[f.severity], quiet: 0 };
      out.push(f);
    } else {
      ep.quiet = 0;
      if (RANK[f.severity] > ep.rank) { ep.rank = RANK[f.severity]; out.push(f); }
    }
  });
  Object.keys(eps).forEach(cat => {
    if (!worst[cat] && ++eps[cat].quiet >= CLEAR_TICKS) delete eps[cat];
  });
  return out;
}

function getIdleSeconds(machineId) { return idleAccumulators[machineId] || 0; }

module.exports = { evaluate, getIdleSeconds, THRESHOLDS };
