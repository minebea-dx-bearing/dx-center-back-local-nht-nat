# Containerized k6 Load Test for `tn-realtime-redis` — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Build a self-contained Docker stack that runs the real backend against a seeded 1000-machine Redis and MSSQL, then drive it with k6 to confirm the `?machines=` filtered route serves **50 concurrent dashboard viewers × 1000 machines** inside its 5-second tick budget, measured against the real route rather than a reimplementation of it. Viewer target confirmed 2026-08-04 — see Decisions.

**Architecture:** A `docker-compose.loadtest.yml` overlay adds `redis`, `mssql`, and `mosquitto` services alongside the existing `backend` service, wired together on a private network so nothing touches production infrastructure. A one-shot seeder (run inside the backend container, reusing its existing `redis` and `sequelize` dependencies) populates 1000 master rows and 1000 devices' worth of `rt_*` hash entries, and a `writer` container then keeps those entries moving at the measured per-machine cadence so the fixture does not go stale mid-sweep. A `k6` container then fires wall-clock-aligned 5-second bursts, each virtual user requesting a different `?machines=` subset, while `docker stats` samples the backend container's CPU and memory.

**Tech Stack:** Docker Compose v2, k6 (`grafana/k6` image), Redis 7, MSSQL Server 2022, Eclipse Mosquitto, Node 18, Sequelize/tedious, node-redis.

---

## Context You Need Before Starting

You have zero context on this codebase. Read these first — they are short and they are the *why* behind every number in this plan.

| Read | For |
|---|---|
| `docs/scaling-dashboard-viewers.md` | Why the snapshot cache exists; why `compression()` middleware is deliberately *not* used |
| `docs/load-testing-and-performance.md` | Prior burst-test methodology, the `/_snap` technique, and §7's list of traps |
| `local-backend/util/realtimeMachinesRoute.js` | The two-layer cache being tested. **Read this one properly.** |
| `local-backend/api_nat/tn_tn_realtime_redis.js` | The route under test |
| `local-backend/util/redisRealtimeReader.js` | The exact Redis wire format the seeder must reproduce |
| `local-backend/util/masterStorage.js` | The exact master SQL the seeder must satisfy |

### What is already known (do not re-derive)

Prior work used a synthetic harness (`local-backend/test/_filter_scale.tmp.js` + `_filter_drive.tmp.js`, both still present and gitignored) that reimplemented the cache rather than running the real route. It swept 50 viewers against 1000 synthetic machines:

| K (machines/viewer) | slots/tick | p95 | rebuild wall | % of 5s tick |
|---|---|---|---|---|
| 250 | 12,500 | 50 ms | 52 ms | 1% |
| 500 | 25,000 | 70 ms | 75 ms | 2% |
| 750 | 37,500 | 110 ms | 112 ms | 2% |

No knee was found — roughly 40× headroom. **What that sweep could not measure is Layer 1**: the real Redis pipelined read plus `prepareRealtimeData` at 1000 machines, because production has only 2 seeded machines (`tb17`, `tb22`). Layer 1 runs once per tick regardless of viewer count, so it shifts the curve by a constant rather than changing its shape — but the size of that constant is the single biggest open question, and it is the main thing this plan exists to answer.

Also measured (2026-08-03, 90s at 1 Hz against live Redis): upstream write intervals are **per-machine and cycle-driven, not a fixed publisher rate**. `tb17` changed every ~2s (min 1, max 3); `tb22` averaged ~11s (min 1, max 18). `rt_status` and `rt_alarm` are edge-triggered and can sit unchanged for minutes. The seeder must reproduce this variance — see Task 4.

---

## Ground Rules

**Safety — read twice.** The existing `local-backend/.env` points at live production infrastructure: real Redis at a real IP, real MQTT brokers, real MSSQL holding real master data. This plan must never load that file into a load-test container. Every task below uses a separate `.env.loadtest` with its own values. If you find yourself copying `.env`, stop.

**Never seed data into production.** The whole point of containerizing is that 1000 fake machines land in a throwaway Redis and a throwaway database. There is no step in this plan that writes to production, and none should be added.

**Commits.** `dx-center-back-local-nht-nat` is its own git repo (the parent directory is not). Commit after each task, staging specific files — never `git add -A`. Do not push without asking.

**Verification over tests.** This is infrastructure, so classic unit-test-first does not apply cleanly. Each task instead ends with a concrete command and its expected output. Do not proceed past a failing verification — a load test built on an unverified stack produces confident, wrong numbers, which is worse than no numbers.

---

## Task 1: Scaffold the load-test environment file

**Files:**
- Create: `local-backend/.env.loadtest`
- Modify: `local-backend/.gitignore`

**Step 1: Write the env file**

Values are deliberately fake and internal to the compose network. `NAT_SERVER` is the MSSQL *service name*, not an IP.

```dotenv
# Load-test environment. Points ONLY at containers in docker-compose.loadtest.yml.
# Never copy values from .env into this file.
PORT=8009

# MSSQL container. masterStorage queries [${MASTER_DB}].[dbo].[master_mc_storage_tb]
# through this same connection, so one server hosts both.
NAT_SERVER=mssql
NAT_SERVER_USERNAME=sa
NAT_SERVER_PASSWORD=LoadTest!Passw0rd
NHT_SERVER=mssql
NHT_SERVER_USERNAME=sa
NHT_SERVER_PASSWORD=LoadTest!Passw0rd

MASTER_SERVER=mssql
MASTER_SERVER_USERNAME=sa
MASTER_SERVER_PASSWORD=LoadTest!Passw0rd
MASTER_DB=dx_master_loadtest

# Redis container
NAT_REDIS_URL=redis://redis:6379
NAT_REDIS_PASSWORD=
NAT_REDIS_DB=0

# All MQTT brokers point at one local mosquitto, so unreachable-broker retry
# storms do not pollute the CPU measurement. See Task 3.
MQTT_PORT=1883
NAT_MQTT_MC_SHOP=mosquitto
NAT_MQTT_ASSY=mosquitto
NHT_MQTT_MC_SHOP=mosquitto
NHT_MQTT_ASSY_BACK=mosquitto
NHT_MQTT_ASSY_FRONT=mosquitto
```

**Step 2: Confirm the MQTT variable shape before trusting the above**

The MQTT vars might be bare hostnames or full URLs — this plan assumes bare hostnames combined with `MQTT_PORT`. Verify:

Run: `grep -rn "MQTT_MC_SHOP\|MQTT_PORT" local-backend/util/mqttHub.js local-backend/server.js`

If the code builds `mqtt://${host}:${port}`, the values above are correct. If it expects a full URL, change them to `mqtt://mosquitto:1883`. **Do not skip this** — a malformed broker URL produces a tight reconnect loop that will silently inflate every CPU number in this test.

**Step 3: Ignore the file**

`.env.loadtest` contains no real secrets, but committing environment files trains bad habits and the next one might. Add to `local-backend/.gitignore`:

```gitignore
.env.loadtest
```

**Step 4: Verify**

Run: `git -C local-backend status --short`
Expected: `.env.loadtest` does **not** appear. Only `.gitignore` is listed as modified.

**Step 5: Commit**

```bash
git -C local-backend add .gitignore
git -C local-backend commit -m "chore: ignore load-test env file"
```

---

## Task 2: Add the compose overlay

**Files:**
- Create: `docker-compose.loadtest.yml` (repo root of `dx-center-back-local-nht-nat`, beside the existing `docker-compose.yml`)

**Step 1: Understand what you are overlaying**

The existing `docker-compose.yml` defines one `backend` service that bind-mounts `./local-backend` into `/app`, publishes 8009, and inherits `.env` from the image's working directory. This overlay replaces its environment source and adds the dependencies. It is a **separate file**, not an edit — the production compose file must keep working untouched.

**Step 2: Write the overlay**

```yaml
# Self-contained load-test stack. Nothing here reaches production.
#
#   docker compose -f docker-compose.loadtest.yml up -d --build
#
# Deliberately does NOT use `extends` from docker-compose.yml: that file
# inherits the production .env, and the entire safety argument of this stack is
# that the two environments never mix.

services:
  redis:
    image: redis:7-alpine
    # No persistence: every run starts from a known-empty state.
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20

  mssql:
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "LoadTest!Passw0rd"
      MSSQL_PID: Developer
    # MSSQL needs 2GB minimum or it exits during startup with a cryptic error.
    mem_limit: 3g
    healthcheck:
      test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P \"$$MSSQL_SA_PASSWORD\" -Q 'SELECT 1' || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 40
      start_period: 30s

  mosquitto:
    image: eclipse-mosquitto:2
    # Anonymous listener, so the backend's five MQTT connections succeed
    # instead of retrying forever against nothing.
    command: ["sh", "-c", "printf 'listener 1883\\nallow_anonymous true\\n' > /m.conf && mosquitto -c /m.conf"]

  backend:
    build:
      context: ./local-backend
    image: backend-dx_center
    container_name: backend-loadtest
    env_file:
      - ./local-backend/.env.loadtest
    ports:
      - "8009:8009"
    volumes:
      - ./local-backend:/app
      - /app/node_modules
    environment:
      TZ: Asia/Bangkok
      # Async gzip runs on the libuv threadpool; 4 is the default ceiling and
      # is the first thing to raise if cpuPct plateaus near 400%.
      UV_THREADPOOL_SIZE: 4
    depends_on:
      redis:
        condition: service_healthy
      mssql:
        condition: service_healthy
      mosquitto:
        condition: service_started

  k6:
    image: grafana/k6:latest
    # Started manually per run, never with `up`.
    profiles: ["tools"]
    # Capped so the load generator cannot outcompete the backend for host CPU.
    # Uncapped, a laptop reports latency that is really contention between k6 and
    # the thing it is measuring — and it reports it as a backend problem. The
    # cost is a lower achievable load ceiling, which is acceptable here because
    # the pass target is 50 viewers (see Decisions), far below what 2 cores of k6
    # can generate.
    cpus: 2
    volumes:
      - ./loadtest:/scripts
    environment:
      BASE_URL: http://backend:8009
    entrypoint: ["k6"]
```

**Step 3: Verify the file parses and resolves**

Run: `docker compose -f docker-compose.loadtest.yml config --quiet`
Expected: no output, exit 0. Any output is a syntax or interpolation error — fix before continuing.

**Step 4: Commit**

```bash
git add docker-compose.loadtest.yml
git commit -m "test: add containerized load-test stack"
```

---

## Task 3: Bring the stack up and establish an idle baseline

This task produces no code. It exists because **the most common way this kind of test lies is that the baseline was never measured**, and boot-time noise gets attributed to load.

**Step 1: Build and start**

```bash
docker compose -f docker-compose.loadtest.yml up -d --build
```

Expected: `redis`, `mssql`, `mosquitto`, `backend` all start. MSSQL takes 30-60s to become healthy on first run; `depends_on` handles the wait.

**Step 2: Watch the backend boot log**

```bash
docker compose -f docker-compose.loadtest.yml logs -f backend
```

Expected — and this is the important part:
- `[redis] connected redis://redis:6379`
- `[mqttHub] connected to mqtt://mosquitto:1883` (five times, one per broker var)
- **Many** `Unable to connect to the database` or failed master loads for other processes (`[GD]`, `[AVS]`, `[MBR]`, …). **This is expected and acceptable.** The seeded database contains only `master_mc_storage_tb`, and `server.js` mounts all ~55 realtime routes. Those routes are not under test.

If instead you see a *repeating* MQTT reconnect loop, revisit Task 1 Step 2 — the broker URL shape is wrong.

**Step 3: Measure idle CPU — the gate**

Let it settle 60 seconds, then:

```bash
docker stats --no-stream backend-loadtest
```

Expected: CPU **below 5%**.

**If idle CPU is above 5%, stop and fix it before going further.** Something is retry-looping, and every measurement taken afterwards will be contaminated. Usual culprits, in order: malformed MQTT URL, a route retrying a failed master query on a timer, MSSQL still starting.

**Step 4: Record the baseline**

Write the idle CPU% and MEM USAGE down. Every later number is a delta from this, not an absolute.

---

## Task 4: Write the seeder

**Files:**
- Create: `loadtest/seed.js`

This is the task most likely to be done wrong, because the Redis wire format has two non-obvious properties.

**Step 1: Understand the wire format before writing anything**

Re-read `local-backend/util/redisRealtimeReader.js`. Two things will silently produce an empty dashboard if you get them wrong:

1. **The field key is the full topic**: `{type}/{div}/{process}/{device}`, e.g. `data/nat/tn/tb17`. Device is lowercase.
2. **`payload` is double-JSON-encoded.** The hash value is a JSON object whose `payload` property is *itself a JSON string*, not a nested object. `decodeEntry` does `JSON.parse` twice. Seed it as an object and every machine reads as offline, the page renders, and nothing errors — the worst possible failure mode.

**Step 2: Write the seeder**

```js
/**
 * Seeds the load-test stack with N machines: master rows in MSSQL and
 * rt_* entries in Redis.
 *
 * Runs INSIDE the backend container so it reuses that container's node_modules
 * and its .env.loadtest — which is also the safety property that matters. It
 * cannot reach production because the container cannot.
 *
 *   docker compose -f docker-compose.loadtest.yml exec backend node /app/../loadtest/seed.js
 *
 * (See Task 5 for the exact invocation; the loadtest dir is mounted separately.)
 */
require("dotenv").config({ path: "/app/.env.loadtest" });

const { Sequelize } = require("sequelize");
const { createClient } = require("redis");

const COUNT = Number(process.env.MACHINE_COUNT || 1000);
const DIV = "nat";
const PROCESS = "tn";
const DB = process.env.MASTER_DB;

// Fixed seed: two runs must produce identical data, or two runs are not
// comparable. Math.random() here would make every sweep a different test.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = mulberry32(42);

const devices = Array.from({ length: COUNT }, (_, i) => `tb${String(i + 1).padStart(4, "0")}`);

// ---------------------------------------------------------------------------
// MSSQL: database, table, 1000 master rows
// ---------------------------------------------------------------------------

const seedMaster = async () => {
  // No `database` key: connects to the server default (master), which is what
  // lets us CREATE DATABASE. trustServerCertificate is required against the
  // container's self-signed cert — production connects to a trusted host and
  // therefore does not set it.
  const dbms = new Sequelize({
    dialect: "mssql",
    host: process.env.NAT_SERVER,
    username: process.env.NAT_SERVER_USERNAME,
    password: process.env.NAT_SERVER_PASSWORD,
    logging: false,
    dialectOptions: { options: { trustServerCertificate: true, encrypt: false, requestTimeout: 60000 } },
  });

  await dbms.authenticate();

  await dbms.query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE [${DB}];`);
  // Column set mirrors the SELECT in util/masterStorage.js exactly, including
  // created_at, which its ROW_NUMBER() window orders by.
  await dbms.query(`
    IF OBJECT_ID('[${DB}].[dbo].[master_mc_storage_tb]') IS NULL
    CREATE TABLE [${DB}].[dbo].[master_mc_storage_tb] (
      id INT IDENTITY(1,1) PRIMARY KEY,
      mc_no VARCHAR(50), process VARCHAR(50), part_no VARCHAR(50),
      target_ct FLOAT, target_utl FLOAT, target_yield FLOAT,
      target_special FLOAT, ring_factor FLOAT,
      created_at DATETIME DEFAULT GETDATE()
    );`);
  await dbms.query(`DELETE FROM [${DB}].[dbo].[master_mc_storage_tb] WHERE process = '${PROCESS}';`);

  // Batched: 1000 single INSERTs over a container round trip takes minutes.
  const CHUNK = 200;
  for (let i = 0; i < devices.length; i += CHUNK) {
    const values = devices.slice(i, i + CHUNK).map((d) => {
      const ct = (1.2 + rnd() * 2.5).toFixed(2);
      return `('${d}', '${PROCESS}', 'part${d.slice(2)}', ${ct}, 85, 98, 0, ${(0.8 + rnd() * 0.4).toFixed(3)})`;
    });
    await dbms.query(`
      INSERT INTO [${DB}].[dbo].[master_mc_storage_tb]
        (mc_no, process, part_no, target_ct, target_utl, target_yield, target_special, ring_factor)
      VALUES ${values.join(",")};`);
  }

  const [rows] = await dbms.query(`SELECT COUNT(*) AS n FROM [${DB}].[dbo].[master_mc_storage_tb] WHERE process = '${PROCESS}';`);
  await dbms.close();
  return rows[0].n;
};

// ---------------------------------------------------------------------------
// Redis: rt_data / rt_status / rt_alarm / rt_mqtt
// ---------------------------------------------------------------------------

const entry = (type, device, payload) =>
  JSON.stringify({
    device,
    div: DIV,
    process: PROCESS,
    topic: `${type}/${DIV}/${PROCESS}/${device}`,
    timestamp: new Date().toISOString(),
    // Double-encoded on purpose. redisRealtimeReader.decodeEntry parses twice.
    payload: JSON.stringify(payload),
  });

const seedRedis = async () => {
  const redis = createClient({ url: process.env.NAT_REDIS_URL });
  await redis.connect();

  const data = {}, status = {}, alarm = {}, mqtt = {};

  for (const d of devices) {
    const key = (t) => `${t}/${DIV}/${PROCESS}/${d}`;
    // Varied values matter more than they look: near-identical rows gzip at
    // ~36x and would make the payload appear 3x smaller than reality. Real
    // varied data measured ~10x. See docs/load-testing-and-performance.md §7.
    data[key("data")] = entry("data", d, {
      prod_pos4: Math.floor(rnd() * 5000),
      prod_pos6: Math.floor(rnd() * 5000),
      prod_drop_pos4: Math.floor(rnd() * 50),
      prod_drop_pos6: Math.floor(rnd() * 50),
      cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
      model: `MDL-${Math.floor(rnd() * 900 + 100)}`,
    });
    // ~90% running, matching a plant where most machines are up. An all-running
    // fixture would skip the SIGNAL LOSE / offline branches entirely.
    status[key("status")] = entry("status", d, { status: rnd() < 0.9 ? "RUN" : "STOP" });
    alarm[key("alarm")] = entry("alarm", d, { status: rnd() < 0.05 ? "ALARM" : "NORMAL" });
    mqtt[key("mqtt")] = entry("mqtt", d, { broker: "mosquitto" });
  }

  await redis.del(["rt_data", "rt_status", "rt_alarm", "rt_mqtt"]);
  await Promise.all([
    redis.hSet("rt_data", data),
    redis.hSet("rt_status", status),
    redis.hSet("rt_alarm", alarm),
    redis.hSet("rt_mqtt", mqtt),
  ]);

  const n = await redis.hLen("rt_data");
  await redis.quit();
  return n;
};

(async () => {
  const master = await seedMaster();
  const live = await seedRedis();
  console.log(`seeded: ${master} master rows, ${live} rt_data entries`);
  if (master !== COUNT || live !== COUNT) {
    console.error(`MISMATCH: expected ${COUNT} of each`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
```

**Step 3: Mount the loadtest directory into the backend container**

Add to the `backend` service's `volumes:` in `docker-compose.loadtest.yml`:

```yaml
      - ./loadtest:/loadtest
```

Then `docker compose -f docker-compose.loadtest.yml up -d backend` to apply.

**Step 4: Run the seeder**

```bash
docker compose -f docker-compose.loadtest.yml exec backend node /loadtest/seed.js
```

Expected: `seeded: 1000 master rows, 1000 rt_data entries`

**Likely first failure:** a tedious TLS error against MSSQL. The fix is already in the code above (`trustServerCertificate: true, encrypt: false`). If it persists, confirm the MSSQL container is healthy: `docker compose -f docker-compose.loadtest.yml ps`.

**Step 5: Verify the route actually sees 1000 machines — the real gate**

The seeder counting its own rows proves nothing about whether the backend can read them. Restart the backend so `masterStorage`'s indefinite cache reloads, then ask the route:

```bash
docker compose -f docker-compose.loadtest.yml restart backend
sleep 15
curl -s "http://localhost:8009/nat/tn/tn-realtime-redis/available" | head -c 300
curl -s "http://localhost:8009/nat/tn/tn-realtime-redis/machines" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);console.log('machines:',b.data.length,'| sample:',JSON.stringify(b.data[0]).slice(0,200))})"
```

Expected: `machines: 1000`, and the sample row must contain **real values** for `act_ct` / `curr_utl` / production counts.

**If every machine reads as `SIGNAL LOSE` or zeros, the double-encoding is wrong.** That is the failure this task warned about, and it does not raise an error. Re-read Step 1.

**Step 6: Commit**

```bash
git add loadtest/seed.js docker-compose.loadtest.yml
git commit -m "test: seed 1000 machines into load-test redis and mssql"
```

---

## Task 4b: Keep the fixture alive with a writer

**Files:**
- Create: `loadtest/fixture.js`
- Create: `loadtest/writer.js`
- Modify: `loadtest/seed.js`, `docker-compose.loadtest.yml`

Task 4 leaves a **frozen** fixture, and frozen is not merely less realistic — it is wrong in a way that breaks the test outright. `util/determineMachineStatus.js:14` returns `SIGNAL LOST` when `updated_at` is more than 10 minutes old. A static seed therefore flips all 1000 machines to `SIGNAL LOST` ten minutes after seeding, simultaneously, and every sweep started after that point measures the SIGNAL LOST branch for every machine. The sweep in Task 6 runs twelve scenarios; the early ones and the late ones would not be measuring the same thing.

A writer fixes that, and gets three more things for free: `rt_data` payload entropy stays in steady state (so the gzip ratio is the real one, not one frozen snapshot's), counters accumulate so `target_pd`/`curr_utl` derive from a moving baseline, and Redis is under concurrent write load while being read.

**What this deliberately does *not* test:** `cacheMs: 5_000` in the route is time-based, not invalidation-based. A live writer does not change the cache hit rate or the number of Layer 1 reads per tick — those stay identical. Do not expect the writer to move p95. If it does, that is a finding, not the goal.

**Step 1: Extract the shared fixture vocabulary**

`writer.js` needs the same device list, the same seeded RNG, and — critically — the same double-encoded `entry()` as `seed.js`. Copy-pasting `entry()` is the one duplication that must not happen here: two copies means one can drift, and a drifted encoding fails silently as an all-offline dashboard (Task 4, Step 1). Extract rather than duplicate, at two occurrences rather than three, for that reason.

Move `mulberry32`, `devices`, `DIV`/`PROCESS`, and `entry` out of `seed.js` into `loadtest/fixture.js`:

```js
/** Shared fixture vocabulary for seed.js and writer.js. */
const DIV = "nat";
const PROCESS = "tn";
const COUNT = Number(process.env.MACHINE_COUNT || 1000);

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const devices = Array.from({ length: COUNT }, (_, i) => `tb${String(i + 1).padStart(4, "0")}`);

const key = (type, device) => `${type}/${DIV}/${PROCESS}/${device}`;

/** Double-encoded on purpose. redisRealtimeReader.decodeEntry parses twice. */
const entry = (type, device, payload) =>
  JSON.stringify({
    device,
    div: DIV,
    process: PROCESS,
    topic: key(type, device),
    timestamp: new Date().toISOString(),
    payload: JSON.stringify(payload),
  });

module.exports = { DIV, PROCESS, COUNT, mulberry32, devices, key, entry };
```

Then have `seed.js` require it and delete its local copies. Re-run the Task 4 Step 5 verification afterwards — the refactor must leave `machines: 1000` with real values, unchanged.

**Step 2: Write the writer**

```js
/**
 * Keeps the load-test rt_* hashes moving, at the per-machine cadence measured
 * against live Redis on 2026-08-03: tb17 ~2s (min 1, max 3), tb22 ~11s
 * (min 1, max 18). Per-machine and cycle-driven, NOT a fixed publisher rate.
 *
 * Runs in its own container so its CPU never lands in backend-loadtest's
 * `docker stats` numbers.
 *
 *   docker compose -f docker-compose.loadtest.yml --profile writer up -d writer
 */
require("dotenv").config({ path: "/app/.env.loadtest" });

const { createClient } = require("redis");
const { devices, key, entry, mulberry32 } = require("./fixture");
const { decodeEntry } = require("/app/util/redisRealtimeReader");

// Distinct from seed.js's seed(42) so the writer's schedule is independent of
// the fixture values, and logged so a run can be reproduced exactly.
const SEED = Number(process.env.WRITER_SEED || 1337);
const rnd = mulberry32(SEED);

const TICK_MS = 100; // batching window, not a per-machine rate

/**
 * Skewed toward fast machines, spanning the measured 1-18s range. Squaring the
 * uniform draw puts the mass near the low end, matching a plant where most
 * machines cycle quickly and a few are slow. A uniform draw would make the mean
 * interval ~9s and halve the write rate.
 */
const drawInterval = () => 1000 + Math.round(rnd() ** 2 * 17000);

/** Resume from what seed.js wrote, so counters stay continuous across a restart. */
const loadState = async (redis) => {
  const raw = await redis.hmGet("rt_data", devices.map((d) => key("data", d)));
  const now = Date.now();
  return devices.map((device, i) => {
    const p = decodeEntry(raw[i])?.payload || {};
    const intervalMs = drawInterval();
    return {
      device,
      intervalMs,
      // Stagger the first tick across one full interval. Without this all 1000
      // machines fire on tick 0 and the write rate oscillates for minutes.
      nextAt: now + Math.floor(rnd() * intervalMs),
      prod_pos4: Number(p.prod_pos4) || 0,
      prod_pos6: Number(p.prod_pos6) || 0,
      prod_drop_pos4: Number(p.prod_drop_pos4) || 0,
      prod_drop_pos6: Number(p.prod_drop_pos6) || 0,
      model: p.model || `MDL-${Math.floor(rnd() * 900 + 100)}`,
      status: "RUN",
      alarm: "NORMAL",
    };
  });
};

const machines = [];
let written = 0;

const tick = async (redis) => {
  const now = Date.now();
  const data = {}, status = {}, alarm = {};

  for (const m of machines) {
    if (now < m.nextAt) continue;
    // Jitter the NEXT interval rather than re-drawing it: a machine's cadence is
    // a property of its cycle, so it should stay recognizably itself run to run.
    m.nextAt = now + Math.round(m.intervalMs * (0.8 + rnd() * 0.4));

    // MONOTONIC. These are cumulative-since-05:00 counters; a random walk that
    // decreases produces negative deltas downstream — silent garbage, no error.
    m.prod_pos4 += 1;
    m.prod_pos6 += 1;
    if (rnd() < 0.02) m.prod_drop_pos4 += 1;
    if (rnd() < 0.02) m.prod_drop_pos6 += 1;

    data[key("data", m.device)] = entry("data", m.device, {
      prod_pos4: m.prod_pos4,
      prod_pos6: m.prod_pos6,
      prod_drop_pos4: m.prod_drop_pos4,
      prod_drop_pos6: m.prod_drop_pos6,
      cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
      model: m.model,
    });

    // Edge-triggered: rt_status and rt_alarm can sit unchanged for minutes, so
    // they are written only on transition, not on every data tick. Writing them
    // every tick would triple the write rate against observed behavior.
    if (rnd() < 0.002) {
      m.status = m.status === "RUN" ? "STOP" : "RUN";
      status[key("status", m.device)] = entry("status", m.device, { status: m.status });
    }
    if (rnd() < 0.001) {
      m.alarm = m.alarm === "NORMAL" ? "ALARM" : "NORMAL";
      alarm[key("alarm", m.device)] = entry("alarm", m.device, { status: m.alarm });
    }
  }

  const writes = [];
  if (Object.keys(data).length) writes.push(redis.hSet("rt_data", data));
  if (Object.keys(status).length) writes.push(redis.hSet("rt_status", status));
  if (Object.keys(alarm).length) writes.push(redis.hSet("rt_alarm", alarm));
  if (writes.length) await Promise.all(writes);

  written += Object.keys(data).length;
};

(async () => {
  const redis = createClient({ url: process.env.NAT_REDIS_URL });
  await redis.connect();
  machines.push(...(await loadState(redis)));

  const mean = machines.reduce((s, m) => s + m.intervalMs, 0) / machines.length;
  console.log(`[writer] seed=${SEED} machines=${machines.length} meanInterval=${Math.round(mean)}ms expected=${(machines.length / (mean / 1000)).toFixed(0)} writes/s`);

  let busy = false;
  setInterval(async () => {
    // Never overlap ticks: a slow Redis would otherwise queue writers behind
    // each other and the reported rate would stop meaning anything.
    if (busy) return;
    busy = true;
    try { await tick(redis); } catch (e) { console.error("[writer]", e.message); }
    busy = false;
  }, TICK_MS);

  setInterval(() => {
    console.log(`[writer] ${(written / 10).toFixed(1)} writes/s`);
    written = 0;
  }, 10_000);
})().catch((e) => { console.error(e); process.exit(1); });
```

**Step 3: Add the writer service**

In `docker-compose.loadtest.yml`, alongside `backend`:

```yaml
  writer:
    image: backend-dx_center
    container_name: writer-loadtest
    # Behind a profile so `up` does not start it. Task 3's idle baseline must be
    # measured with the writer OFF, or the baseline includes the writer.
    profiles: ["writer"]
    env_file:
      - ./local-backend/.env.loadtest
    volumes:
      - ./local-backend:/app
      - ./loadtest:/loadtest
      - /app/node_modules
    environment:
      TZ: Asia/Bangkok
    working_dir: /loadtest
    command: ["node", "/loadtest/writer.js"]
    depends_on:
      redis:
        condition: service_healthy
```

Also add `- ./loadtest:/loadtest` to `backend` if Task 4 Step 3 has not already.

**Step 4: Verify it is actually incrementing**

```bash
docker compose -f docker-compose.loadtest.yml --profile writer up -d writer
docker compose -f docker-compose.loadtest.yml logs -f writer   # expect ~200-300 writes/s at 1000 machines
```

Then confirm the values move and only ever move up:

```bash
for i in 1 2 3; do
  docker compose -f docker-compose.loadtest.yml exec redis \
    redis-cli HGET rt_data "data/nat/tn/tb0017" | head -c 200; echo
  sleep 6
done
```

Expected: `prod_pos4` **strictly increases** across the three samples and `timestamp` advances. A value that ever decreases is the monotonicity bug the writer comments warn about — fix it before running any sweep, because it does not raise an error.

**Step 5: The gate that justifies this task**

Leave the writer running for 12 minutes, then:

```bash
curl -s "http://localhost:8009/nat/tn/tn-realtime-redis/machines" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);const lost=b.data.filter(m=>m.status==='SIGNAL LOST').length;console.log('SIGNAL LOST:',lost,'of',b.data.length)})"
```

Expected: **0 of 1000**. Run the same command against a stack with the writer stopped for 12 minutes and it returns 1000 of 1000 — that contrast is the whole point of the task, and is worth recording in Task 7's documentation.

**Step 6: Sequencing for Task 6**

Start the writer before the sweep and leave it up for the whole sweep, so every scenario sees the same conditions:

```bash
docker compose -f docker-compose.loadtest.yml --profile writer up -d writer
bash loadtest/run-sweep.sh
```

Sample `writer-loadtest` and `redis` in `docker stats` too, not just `backend-loadtest`. If Redis CPU is material, the backend's read latency includes contention — which is realistic and wanted, but must be *known* rather than discovered later.

**Step 7: Commit**

```bash
git add loadtest/fixture.js loadtest/writer.js loadtest/seed.js docker-compose.loadtest.yml
git commit -m "test: drive load-test redis with a live per-machine writer"
```

---

## Task 5: Write the k6 script

**Files:**
- Create: `loadtest/viewers.js`

**Step 1: Understand the load shape you must reproduce**

This is not steady traffic and modelling it as steady would make the test meaningless. Every dashboard polls when `moment().format("ss") % 5 === 0` — a **wall-clock alignment**. All N viewers therefore arrive within milliseconds of each other, five times a minute, and are idle in between. Peak concurrency equals total viewer count. A `constant-arrival-rate` scenario would spread the same requests smoothly and comfortably pass a load the real system would fail.

Each VU must also request a **different** `?machines=` subset, because cache-key cardinality — not request count — is the variable that scales Layer 2.

**Step 2: Write the script**

```js
/**
 * Wall-clock-aligned burst load against tn-realtime-redis.
 *
 *   docker compose -f docker-compose.loadtest.yml run --rm \
 *     -e VIEWERS=50 -e K=250 k6 run /scripts/viewers.js
 *
 * VIEWERS  concurrent dashboards
 * K        machines each one filters to (0 = unfiltered, the worst case)
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const VIEWERS = Number(__ENV.VIEWERS || 50);
const K = Number(__ENV.K || 250);
const POOL = Number(__ENV.POOL || 1000);
const TICK = 5;
const BASE = `${__ENV.BASE_URL}/nat/tn/tn-realtime-redis`;

const wrongCount = new Counter("wrong_machine_count");
const bodyKB = new Trend("body_kb");

export const options = {
  scenarios: {
    dashboards: {
      executor: "per-vu-iterations",
      vus: VIEWERS,
      iterations: Number(__ENV.TICKS || 12), // 12 ticks = ~1 minute
      maxDuration: "5m",
    },
  },
  thresholds: {
    // A viewer that does not get its data inside one tick is a stale dashboard.
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    wrong_machine_count: ["count==0"],
  },
};

const names = Array.from({ length: POOL }, (_, i) => `tb${String(i + 1).padStart(4, "0")}`);

/**
 * Deterministic per-VU subset, overlapping rather than partitioned: several
 * dashboards watching the same cell is both realistic and the expensive case.
 * Derived from __VU so a VU asks for the same set every tick, exactly as a real
 * dashboard with a fixed URL does.
 */
function subsetFor(vu) {
  if (!K) return null;
  const out = [];
  // Stride by a value coprime with POOL so subsets overlap without repeating.
  let idx = (vu * 37) % POOL;
  for (let i = 0; i < K; i++) {
    out.push(names[idx]);
    idx = (idx + 7) % POOL;
  }
  return out.sort();
}

const mySet = {};

export default function () {
  if (!mySet[__VU]) mySet[__VU] = subsetFor(__VU);
  const set = mySet[__VU];

  // Align to the next wall-clock multiple of TICK, so all VUs fire together.
  const now = Date.now();
  const waitMs = TICK * 1000 - (now % (TICK * 1000));
  sleep(waitMs / 1000);

  const url = set ? `${BASE}/machines?machines=${encodeURIComponent(set.join(","))}` : `${BASE}/machines`;
  const res = http.get(url, { headers: { "Accept-Encoding": "gzip" } });

  bodyKB.add(res.body ? res.body.length / 1024 : 0);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "returned the requested machines": (r) => {
      if (r.status !== 200) return false;
      const n = JSON.parse(r.body).data.length;
      return n === (set ? set.length : POOL);
    },
  });
  // Correctness is not a footnote: a filter bug that returns everything still
  // looks fast, and would otherwise be reported as a pass.
  if (!ok) wrongCount.add(1);
}
```

**Step 3: Verify with a trivial run**

```bash
docker compose -f docker-compose.loadtest.yml run --rm -e VIEWERS=2 -e K=10 -e TICKS=3 k6 run /scripts/viewers.js
```

Expected: 6 iterations, `wrong_machine_count 0`, all thresholds green. If `returned the requested machines` fails, the filter or the seeded names disagree — check that `subsetFor` generates the same `tbNNNN` format the seeder wrote.

**Step 4: Commit**

```bash
git add loadtest/viewers.js
git commit -m "test: add k6 burst scenario for filtered realtime route"
```

---

## Task 6: Run the sweep and capture container stats

**Files:**
- Create: `loadtest/run-sweep.sh`

**Step 1: Write the runner**

k6 reports client-side latency; `docker stats` reports what it cost the server. Neither alone answers "will this hold" — you need both, sampled over the same window.

```bash
#!/usr/bin/env bash
# Sweeps viewers x machines-per-viewer, capturing k6 summaries and container stats.
set -euo pipefail

COMPOSE="docker compose -f docker-compose.loadtest.yml"
OUT="loadtest/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# 50 viewers is the actual production target; 200 is a 4x headroom probe, kept
# only so a future growth question has a data point. Anything above that was
# dropped once the target was confirmed — see Decisions.
for VIEWERS in 50 200; do
  for K in 250 500 0; do   # 0 = unfiltered worst case, i.e. all 1000 machines
    NAME="v${VIEWERS}-k${K}"
    echo "=== $NAME ==="

    # Sample the backend container for the duration of the run.
    ( while true; do
        docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' backend-loadtest
        sleep 2
      done ) > "$OUT/$NAME.stats" 2>/dev/null &
    STATS_PID=$!

    $COMPOSE run --rm \
      -e VIEWERS="$VIEWERS" -e K="$K" -e TICKS=12 \
      k6 run --summary-export="/scripts/results/$(basename "$OUT")/$NAME.json" \
      /scripts/viewers.js 2>&1 | tee "$OUT/$NAME.log" || echo "THRESHOLD BREACH in $NAME"

    kill $STATS_PID 2>/dev/null || true

    # Let the snapshot cache expire and the container settle between runs, so
    # one run's tail does not land inside the next run's baseline.
    sleep 15
  done
done

echo "results in $OUT"
```

**Step 2: Make it executable and run**

```bash
chmod +x loadtest/run-sweep.sh
./loadtest/run-sweep.sh
```

Expect roughly 6 runs × ~75s ≈ 8-10 minutes.

**The pass/fail run is `v50-k0`** — 50 viewers each pulling all 1000 machines. If its p95 sits inside the tick budget with headroom, the production requirement is met and everything else in the grid is context. Report that run first, not last.

**Step 3: Read the results honestly**

For each run, record:

| Metric | Where | What it means |
|---|---|---|
| `http_req_duration p(95)` | k6 summary | Viewer-visible latency. Must stay well under 5000ms |
| `http_req_failed` | k6 summary | Any non-zero needs explaining before anything else is believed |
| `wrong_machine_count` | k6 summary | Must be 0. Non-zero invalidates the whole run |
| `body_kb` avg | k6 summary | Multiply by viewers ÷ 5s for required bandwidth |
| peak CPU% | `.stats` file | Above ~90% × cores means saturation |
| MEM growth | `.stats` file | Should plateau. Continuous growth across runs = leak |

Report `v50-k0` against the tick budget first — that is the requirement. Then, as secondary context, note whether p95 is still flat at `v200-k0`; **the knee is where p95 stops being flat**, not where it crosses an arbitrary line. If no knee appears anywhere in the grid, say so and state the limiting resource you would expect to bind first — CPU, threadpool, or bandwidth. Do not extrapolate a ceiling from six points that all sat flat.

**Step 4: Sanity-check against the load generator itself**

If p95 rises but backend CPU stays low, **suspect k6 before believing the server is slow.** A single load generator saturating its own CPU or socket pool is the most common false positive in this kind of test (see `docs/load-testing-and-performance.md` §7). Check with `docker stats` on the k6 container during a run.

**Step 5: Commit the runner, not the results**

```bash
echo "loadtest/results/" >> .gitignore
git add loadtest/run-sweep.sh .gitignore
git commit -m "test: add load-test sweep runner"
```

---

## Task 7: Update the documentation

Two docs currently make claims this work will have superseded.

**Files:**
- Modify: `docs/scaling-dashboard-viewers.md` (§5.3, §6)
- Modify: `docs/load-testing-and-performance.md` (§3)
- Create: `docs/load-testing-and-performance.md` new section on the container harness

**Step 1: Fix the stale claims**

| Doc | Claim | Reality now |
|---|---|---|
| `scaling-dashboard-viewers.md` §5.3 | Server-side filtering is the unsolved fix for large machine counts | Implemented via `filterable: true` and `?machines=` |
| `scaling-dashboard-viewers.md` §6 | Checklist omits `filterable` | Must list it, and that it requires `cacheMs` |
| `load-testing-and-performance.md` §3 | Asserts `distinct bodies === 1` across viewers | No longer true under filtering — only viewers sharing a normalized set share a body |

**Step 2: Document the two-layer split**

Add to `scaling-dashboard-viewers.md`: Layer 1 (source read + derive) runs once per tick; Layer 2 (slice + summarize + stringify + gzip) runs once per distinct normalized key. The key is a sha1 of the sorted, deduped, lowercased, unknown-dropped machine list, so wire format is decoupled from cache identity. LRU-bounded at `FILTER_CACHE_MAX = 256`.

**Step 3: Document this harness**

Add a section covering: how to bring the stack up, that `.env.loadtest` must never mirror `.env`, the seeder's double-encoding trap, and the measured results from Task 6.

**Step 4: Commit**

```bash
git add docs/
git commit -m "docs: update scaling and load-testing docs for machine filtering"
```

---

## Task 8: Two-hour soak

**Files:**
- Create: `loadtest/soak.js`, `loadtest/run-soak.sh`

Run this only after Task 6 has passed. A 75-second run cannot distinguish "memory plateaued" from "memory is growing slowly", and the thing most likely to grow slowly is the one thing Task 6 never pressures: the LRU payload cache.

**Step 1: Make the soak churn cache keys, or it tests nothing**

This is the design decision that matters. If 50 VUs each hold one fixed `?machines=` subset for two hours, the cache reaches 50 keys in the first tick and never evicts again — the run would prove the harness can idle, not that the cache is bounded. `FILTER_CACHE_MAX = 256`, so the soak must push distinct normalized keys well past 256 and keep pushing.

Copy `viewers.js` to `soak.js` and change the subset selection so each VU **re-draws its machine subset every N ticks** (N = 12, i.e. once a minute). Over two hours that is ~120 distinct keys per VU, ~6000 total against a 256-entry bound — sustained eviction pressure for the whole run. Keep the wall-clock 5-second alignment and the `wrong_machine_count` check unchanged; correctness must hold across evictions, and a stale slice served after an eviction is exactly the bug this would catch.

**Step 2: Run it**

Writer up for the whole duration, load fixed at the production shape rather than the ceiling — this is a duration test, not a capacity test.

```bash
#!/usr/bin/env bash
set -euo pipefail
COMPOSE="docker compose -f docker-compose.loadtest.yml"
OUT="loadtest/results/soak-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

$COMPOSE --profile writer up -d writer

# 30s sampling: 240 points over 2h is enough to see a trend and small enough to
# eyeball. Both containers, because a writer leak would otherwise read as a
# backend leak.
( while true; do
    echo "$(date +%s),$(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' backend-loadtest writer-loadtest | tr '\n' ',')"
    sleep 30
  done ) > "$OUT/soak.stats" 2>/dev/null &
STATS_PID=$!

$COMPOSE run --rm -e VIEWERS=50 -e K=0 -e DURATION=2h -e RESUBSCRIBE_TICKS=12 \
  k6 run --summary-export="/scripts/results/$(basename "$OUT")/soak.json" \
  /scripts/soak.js 2>&1 | tee "$OUT/soak.log"

kill $STATS_PID 2>/dev/null || true
echo "results in $OUT"
```

**Step 3: Read it**

| Signal | Pass | Fail means |
|---|---|---|
| backend RSS, last 30 min vs. minutes 30-60 | flat within ~5% | Leak. Suspect the LRU not evicting, or entries retained by a closure |
| `http_req_duration p(95)`, first 15 min vs. last 15 min | no upward trend | Degradation under sustained eviction — GC pressure or cache thrash |
| `wrong_machine_count` | 0 for the entire run | A slice served from a key it does not belong to. Stop everything and fix |
| writer `writes/s` | steady | Writer drift; write-side numbers unusable |

**A sawtooth RSS profile is a pass, not a failure** — that is GC doing its job. The failure shape is a rising floor: each sawtooth trough higher than the last.

**Step 4: Commit**

```bash
git add loadtest/soak.js loadtest/run-soak.sh
git commit -m "test: add two-hour soak run for cache-eviction memory behavior"
```

---

## Task 9: Measure the MQTT route and compare

**Files:** create `loadtest/store_tn_mqtt.js`, `loadtest/server-mqtt.js`, `loadtest/run-compare.sh`; modify `loadtest/writer.js`, `docker-compose.loadtest.yml`.

`api_nat/tn_tn_realtime.js` is the route in production today, and it is the one this whole Redis prototype is arguing against. That argument currently rests on reading its config rather than on a number. This task produces the number.

The difference is entirely in how `makeMachinesHandler` is called. `tn_tn_realtime.js:96-103` passes no `cacheMs`, no `filterable`, no `timeoutMs`, so it takes the uncached branch at `realtimeMachinesRoute.js:275-279` — build, serialize, send, per request. Per *request*, not per tick. At 50 viewers that means 50 `prepareRealtimeData` passes over 1000 machines and 50 `JSON.stringify` calls of a ~580KB body every 5 seconds, on one event loop, with no gzip (`serialize` returns `gz: null` when `cacheMs` is 0). The expected result is not in doubt. What is not known, and what makes this worth running, is the *size* of the gap and whether the bottleneck is CPU or bandwidth — those imply different migration urgencies.

**The comparison is only worth anything if both routes get identical inputs.** Three constraints follow, and none of them are optional:

- Same master rows — both sides read the `master_mc_storage_tb` the Task 4 seeder wrote, through the same `createMasterCache`.
- Same live values — the Task 4b writer publishes each tick to *both* Redis and MQTT, so the two routes are serving the same numbers at the same instant.
- Same `getRunningTime` — both pass `async () => []`. The real `_store_tn.js` runs a SQL query here, but it sits behind a 20-second TTL with single-flight coalescing (`runningTimeCache.js:30`), so it is load-*independent*: one query per 20s whether there are 5 viewers or 500. Including it would add a constant to one side and measure MSSQL fixture quality instead of the cache. Excluded deliberately — see the caveat added below.

**Step 1: A load-test store on the real ingest path**

`loadtest/store_tn_mqtt.js` — the only thing faked is where master rows come from. `mqttHub`, `processStore`, the subscribe-and-merge path, and `prepareRealtimeData` are all the production modules, unmodified.

```js
/**
 * Stand-in for api_nat/_store_tn.js. Differs in exactly one way: master rows
 * come from the seeded master_mc_storage_tb instead of the four DATA_*_TN
 * tables, so this store and the Redis route provably see the same machines.
 *
 * Master loading is behind processStore's 5-minute reload interval and is not
 * in the per-request path, so faking it cannot move the numbers this task
 * exists to produce.
 */
const dbms = require("/app/instance/ms_instance_nat");
const { getHub } = require("/app/util/mqttHub");
const { createProcessStore } = require("/app/util/processStore");
const { createMasterCache } = require("/app/util/masterStorage");

const MASTER_TABLE = `[${process.env.MASTER_DB}].[dbo].[master_mc_storage_tb]`;
const masterCache = createMasterCache({ dbms, table: MASTER_TABLE, process: "tn" });

const hub = getHub(`mqtt://${process.env.NAT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName: "TN",
  startHour: 5,
  hub,
  masterLoader: () => masterCache.get(),
});

module.exports = { getSnapshot: store.getSnapshot };
```

**Step 2: Its own process, on port 8010**

`loadtest/server-mqtt.js` mounts this one route and nothing else. A second container rather than a second route inside `backend-loadtest`, for one reason: `docker stats` reports per container, and two routes in one process would share a CPU number, which is precisely the number being compared.

```js
const express = require("express");
const app = express();

const { makeMachinesHandler } = require("/app/util/realtimeMachinesRoute");
const { prepareRealtimeData } = require("/app/api_nat/tn_tn_realtime");
const store = require("./store_tn_mqtt");

// Copied verbatim from tn_tn_realtime.js:96-103. If that file's options ever
// change, this must change with it or the comparison is measuring a route that
// no longer exists.
app.get(
  "/nat/tn/tn-realtime/machines",
  makeMachinesHandler({
    getMachines: () => store.getSnapshot(),
    getRunningTime: async () => [],
    prepareRealtimeData,
    summary: "standard",
  }),
);

app.listen(8010, () => console.info("[mqtt-loadtest] listening on 8010"));
```

**Step 3: Teach the writer to publish**

`loadtest/writer.js` gains `WRITER_TARGETS` (default `redis,mqtt`). Same tick, same drawn values, both destinations — the Redis `hSet` batch and the MQTT publishes carry identical numbers.

Two format differences that will silently produce an all-offline dashboard if missed:

- **MQTT payloads are single-encoded.** `mqttHub.js:75` does one `JSON.parse` on the raw message. Redis is double-encoded (`redisRealtimeReader.js:45`). Publishing the Redis-shaped envelope to MQTT yields an object whose fields are all `undefined`, with no error anywhere.
- **`mqttHub` takes the last topic segment as `mc_no`** (`mqttHub.js:67`), and `processStore`'s `accepts` requires that string to be a key in `master`. Publish to `data/nat/tn/tb0001`, lowercase, matching the seeded `mc_no` exactly.

Four topics per machine per write, mirroring the four hashes: `data/`, `status/`, `alarm/`, `mqtt/`. The last one matters more than it looks — `broker` reaches the row through `processStore.js:68`, and `determineMachineStatus.js:14` returns `SIGNAL LOST` on `broker === 0`. Publish `{ broker: 1 }`.

**Step 4: Compose service**

```yaml
  backend-mqtt:
    image: backend-dx_center
    container_name: backend-mqtt-loadtest
    # Same cpus as backend-loadtest. A comparison between containers on
    # different limits measures the limits.
    cpus: 4
    env_file:
      - ./local-backend/.env.loadtest
    volumes:
      - ./local-backend:/app
      - ./loadtest:/loadtest
      - /app/node_modules
    environment:
      TZ: Asia/Bangkok
    working_dir: /loadtest
    command: ["node", "/loadtest/server-mqtt.js"]
    ports:
      - "8010:8010"
    depends_on:
      mosquitto:
        condition: service_started
      mssql:
        condition: service_healthy
```

**Step 5: Run both**

`loadtest/run-compare.sh` runs the Task 5 script twice at the same load, changing only `BASE_URL`.

```bash
# K=0 only. The MQTT route takes the uncached branch before normalize() is ever
# reached, so `?machines=` is silently ignored and it always returns the full
# payload. Comparing a filtered Redis run against an unfiltered MQTT one would
# flatter the cache with work the other side was never asked to do.
#
# Consequence for the k6 script: viewers.js asserts wrong_machine_count against
# the requested subset. At K=0 there is no subset and the check is a no-op, so
# it stays valid for both. Do NOT raise K here to "make it fairer".
for TARGET in redis mqtt; do
  ...  VIEWERS=50 K=0 DURATION=75s
done
```

Run with the writer up and both backends warm. Sample `docker stats` for `backend-loadtest` and `backend-mqtt-loadtest` throughout.

**Step 6: Read it**

One table, six numbers:

| Metric | Redis route | MQTT route | Why it matters |
|---|---|---|---|
| `http_req_duration p(95)` | fill in | fill in | The viewer-facing number |
| bytes on the wire per response | gzipped | uncompressed | MQTT route has no gzip at all |
| Mbit/s at 50 viewers | fill in | fill in | `bytes × 50 ÷ 5s`. Check against the factory LAN, not localhost |
| container CPU % | fill in | fill in | 1 vs 50 `prepareRealtimeData` passes per tick |
| container RSS | fill in | fill in | Per-request serialization churn vs one cached buffer |
| `http_req_failed` | fill in | fill in | Should be 0 on both; if not, say which and why |

State the bandwidth row first if it is the larger multiple. A CPU argument invites "buy a bigger server"; a bandwidth argument does not, and on a plant LAN it is the one that actually bites.

**Step 7: Commit**

```bash
git add loadtest/store_tn_mqtt.js loadtest/server-mqtt.js loadtest/run-compare.sh loadtest/writer.js docker-compose.loadtest.yml
git commit -m "test: measure uncached MQTT route against the cached Redis route"
```

---

## What This Harness Cannot Tell You

State these alongside any result, or the numbers will be over-trusted.

- **Localhost has no RTT and no bandwidth ceiling.** Container-to-container networking is far faster than a factory LAN. Convert `body_kb` × viewers ÷ 5s into Mbps and check it against the real link separately.
- **The writer is a model, not a replay.** Task 4b keeps the `rt_*` hashes moving at the measured 1-18s per-machine cadence, so freshness, contention and steady-state entropy are covered. What it still is not: the real upstream. Interval is drawn once per machine and jittered, whereas a real machine's cycle time drifts with the part it is running; `rt_status`/`rt_alarm` transitions are a flat probability rather than correlated with anything. Treat write-side numbers as order-of-magnitude.
- **The writer cannot move the cache hit rate.** `cacheMs: 5_000` is time-based, so Layer 1 still runs exactly once per tick no matter how fast Redis is written. This harness cannot tell you what an invalidation-driven cache would cost.
- **Container CPU limits are not production limits.** Docker Desktop on Windows runs a VM with its own CPU allocation. Compare against the production host's core count before extrapolating.
- **MSSQL is only exercised at cache-miss.** `masterStorage` caches indefinitely with a 30-minute safety TTL, so a 75-second run queries it once. This does not test master-query cost under load — nor should it, because production does not either.
- **Task 9's comparison excludes the running-time SQL.** Both routes get `getRunningTime: async () => []`, so the real `_store_tn.js` query is absent from the MQTT side. Defensible because that query sits behind a 20-second TTL with single-flight coalescing — it runs once per 20s regardless of viewer count, which makes it a constant offset rather than something that scales. But it *is* an offset, and it lands on the MQTT route only. If the comparison is ever used to argue absolute latency rather than the ratio between the two routes, measure that query separately and add it back.
- **Task 9 fakes master loading on the MQTT side.** `store_tn_mqtt.js` reads the seeded `master_mc_storage_tb` instead of the four `DATA_*_TN` tables the production store joins across. This is behind `processStore`'s 5-minute reload and never in the per-request path, so it cannot move the per-request numbers — but it does mean this harness says nothing about the cost or correctness of that master query.
- **One process, one core-ish.** Node is single-threaded apart from the libuv threadpool. If production runs multiple instances behind a load balancer, per-instance results multiply, but the shared cache does *not* — each instance keeps its own.

---

## Decisions (answered 2026-08-04)

1. **The target is 50 viewers × 1000 machines.** Not 1000 × 1000. The sweep in Task 6 was cut to `VIEWERS ∈ {50, 200}` accordingly, and `v50-k0` is the single pass/fail run. Consequence worth stating plainly: the prior 50-viewer synthetic sweep already showed ~40× headroom at this shape, so **this harness is expected to pass comfortably.** Its value is no longer "find the ceiling" — it is closing the Layer 1 gap (real Redis read + `prepareRealtimeData` at 1000 machines, which the synthetic harness never ran) and producing a number that came from the real route instead of a reimplementation of it. If a run comes back surprisingly slow, suspect the harness before the route.
2. **k6 is capped at `cpus: 2`.** Applied in Task 2. At a 50-viewer target this costs nothing — 2 cores generate that load with room to spare — and it removes the most common false positive in this kind of test.
3. **The 2-hour soak is wanted.** Added as Task 8, to run after Task 6 passes. Note the design constraint there: at a fixed 50 viewers the soak must rotate `?machines=` subsets, or the LRU payload cache fills once and never evicts, and the run proves nothing about the thing it exists to test.
