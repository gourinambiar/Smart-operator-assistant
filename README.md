# Smart Operator Assistant — Backend

Real implementation of the architecture spec's backend + simulation engine layer
(the piece the browser-only prototype couldn't include).

## What's here
- `public/index.html` — the tablet UI (Dashboard / Safety / Training / Analytics / Sim). Served by the backend at `http://localhost:4000`. It connects to the live WebSocket automatically (badge shows **LIVE · SERVER**); opened as a plain file it falls back to its built-in simulator (badge shows **LOCAL SIM**).
- `server.js` — Express REST API + WebSocket telemetry gateway (`/ws/telemetry`)
- `simulate.js` — the software telematics engine (same logic as the prototype's Sim tab, now server-side so it's a single source of truth any number of clients can subscribe to)
- `anomalyRules.js` — the rule engine from the spec (idle, load, proximity, seatbelt). Each alert fires once when it starts (and again on escalation or after it clears), not every tick. Idle threshold is 60s for demos (300s production default).
- `schema.sql` — Postgres/TimescaleDB schema for persistent storage (swap in for the in-memory `db` object in `server.js` once ready)

## Run it with Docker (recommended)
```bash
docker compose up --build
```
This starts two containers:
- `db` — TimescaleDB/Postgres, auto-initialized from `schema.sql` on first boot
- `api` — the Express + WebSocket server on `localhost:4000`

Postgres data persists in the `soa_pgdata` volume across restarts. To wipe and reinit the schema from scratch:
```bash
docker compose down -v && docker compose up --build
```

## Run it without Docker
```bash
npm install
npm start          # starts API + WS server on :4000, simulator auto-starts
npm run simulate   # optional: run just the simulator, printing frames/alerts to the console
```
Note: without Docker, `server.js` still uses the in-memory `db` object, not Postgres — see "What's stubbed" below.

## Try it
The easiest way: run the server, then open **http://localhost:4000** in a browser. Open the Sim tab (switch the role dropdown to Supervisor) and use the hazard buttons — they trigger the server's simulator, and the alerts you see come from the server's rule engine.

Command-line alternative:
```bash
# Get a demo auth token
curl -X POST localhost:4000/api/v1/auth/login -H "Content-Type: application/json" \
  -d '{"name":"Gouri","role":"operator"}'

# Use the returned token on any protected route
curl localhost:4000/api/v1/work-orders/today -H "Authorization: Bearer <token>"

# Watch live telemetry
wscat -c ws://localhost:4000/ws/telemetry
```

## What's stubbed vs. real
- **Real**: WebSocket telemetry push, REST endpoints matching the spec's payload formats, anomaly rule evaluation running against the live stream, role-gated routes via JWT, and (with Docker) a real running TimescaleDB instance with the schema already applied.
- **Still stubbed**: `/auth/login` issues a token for *any* name+role with no password check — the `users` table exists in Postgres now, but `server.js` doesn't query it yet. `server.js`'s `db` object is still in-memory JS, not reading/writing the Postgres tables — the database is up and schema'd, but not yet wired into the route handlers. That wiring (swap each `db.x` read/write for a `pg` query) is the natural next step now that Docker gives you a real database to point at.

## Next steps to reach "production-ready"
1. Point `server.js` at Postgres (`pg` is already a dependency) instead of the in-memory `db` object.
2. Add password hashing + a real `/auth/register` flow.
3. Move `simulate.js` behind a feature flag so it's swappable for a real MQTT/IoT ingest once hardware exists.
4. Add rate limiting / input validation (e.g. `zod`) on the POST routes.
