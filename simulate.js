// Software-simulated telematics engine.
// Generates realistic telemetry frames and exposes hooks to inject hazards.
// Runs standalone (node simulate.js) or required into server.js.

const EventEmitter = require('events');

class TelemetrySimulator extends EventEmitter {
  constructor(machineId = 'CAT320-EXC-014') {
    super();
    this.machineId = machineId;
    this.frame = {
      rpm: 1200, speed_kmh: 0, seatbelt: true,
      prox_distance_m: 12, prox_zone: 'rear-left',
      load_kg: 2000, load_limit_kg: 5000
    };
    this.forceIdle = false;
    this.running = false;
    this.tickCount = 0;
  }

  start(intervalMs = 1500) {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => this._tick(), intervalMs);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }

  _tick() {
    this.tickCount++;
    const f = this.frame;

    if (this.forceIdle) {
      f.speed_kmh = 0;
      f.load_kg = 0;
      f.rpm = 900 + Math.random() * 100;
    } else {
      f.speed_kmh = Math.max(0, Math.min(20, f.speed_kmh + (Math.random() - 0.5) * 2));
      f.rpm = 1000 + Math.random() * 600;
      if (this.tickCount % 12 === 0) f.load_kg = 1500 + Math.random() * 2000;
    }
    f.prox_distance_m = Math.max(0.5, Math.min(15, f.prox_distance_m + (Math.random() - 0.5) * 1.5));

    const payload = {
      type: 'telemetry_frame',
      machine_id: this.machineId,
      timestamp: new Date().toISOString(),
      engine: { rpm: Math.round(f.rpm), status: 'running' },
      motion: { speed_kmh: Number(f.speed_kmh.toFixed(1)) },
      safety: {
        seatbelt_fastened: f.seatbelt,
        proximity: [{ zone: f.prox_zone, distance_m: Number(f.prox_distance_m.toFixed(1)), object_type: 'unknown' }]
      },
      hydraulics: { load_kg: Math.round(f.load_kg), load_limit_kg: f.load_limit_kg }
    };
    this.emit('frame', payload);
  }

  // --- Hazard injection hooks (used by the Sim Control Panel) ---
  injectProximity() { this.frame.prox_distance_m = 2.2; }
  injectSeatbelt(durationMs = 8000) {
    this.frame.seatbelt = false;
    setTimeout(() => { this.frame.seatbelt = true; }, durationMs);
  }
  injectIdle(durationMs = 90000) {
    this.forceIdle = true;
    setTimeout(() => { this.forceIdle = false; }, durationMs);
  }
  injectOverload() { this.frame.load_kg = this.frame.load_limit_kg + 400; }
}

module.exports = TelemetrySimulator;

// Standalone mode: `npm run simulate` prints live frames + alerts to the console.
if (require.main === module) {
  const { evaluate } = require('./anomalyRules');
  const sim = new TelemetrySimulator();
  sim.on('frame', (frame) => {
    const flags = evaluate(frame);
    console.log(
      `[${frame.timestamp}] rpm=${frame.engine.rpm} speed=${frame.motion.speed_kmh} ` +
      `load=${frame.hydraulics.load_kg}/${frame.hydraulics.load_limit_kg} ` +
      `prox=${frame.safety.proximity[0].distance_m}m seatbelt=${frame.safety.seatbelt_fastened}`
    );
    flags.forEach(f => console.log(`  !! ${f.severity} ${f.category}: ${f.message}`));
  });
  sim.start(1500);
  console.log('Simulator running. Ctrl+C to stop.');
}
