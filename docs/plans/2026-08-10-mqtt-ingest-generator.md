# MQTT Ingest Load Generator (Phase B) Implementation Plan

> **For Claude:** Use `@skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Build a Node MQTT generator that simulates up to 1000 machines publishing to the VM's Mosquitto broker at a configurable rate, with per-message markers that make end-to-end delivery and latency verifiable in ClickHouse.

**Architecture:** A single container runs a Node `cluster` primary that forks N workers; each worker owns a contiguous shard of devices and drives them from one 10ms scheduler loop (the [writer.js](../../loadtest/writer.js) pattern, retargeted from Redis to MQTT). Pure payload/device logic lives in dependency-free modules that are unit-tested with `node:test`; all I/O sits at the edges. The generator reuses the existing `backend-dx_center` image via `NODE_PATH`, so there is no new image and no `npm install`.

**Tech Stack:** Node 24, `mqtt@^5.13.2` (already a dependency), `node:test` + `node:assert` (built in, zero new deps), Docker Compose.

---

## Context an implementer needs before starting

Read [docs/mqtt-ingest-load-test.md](../mqtt-ingest-load-test.md) first — it is the Phase A findings document and everything below depends on it. The essentials:

- **Topics:** `{data|status|alarm|mqtt}/nat/tn/<device>`. Payload on the wire is a **bare, single-encoded JSON object** — the `{device, div, process, topic, timestamp, payload}` envelope seen in Redis is added by the VM's ingest consumer, not by the publisher. Do **not** reuse `entry()` from [fixture.js:18](../../loadtest/fixture.js#L18); that is the Redis-side shape.
- **Alarm values are whitelisted** by exact string match. Unrecognized values are silently discarded — no error, no metric. The 60 valid values are in §5e of the findings doc.
- **`status` valid values:** `run`, `stop`, `wait`, `alarm`, `other`. **Never publish `offline`** — it is derived downstream from staleness.
- **Registration is not required for ingest**, but we register anyway as a one-time setup step so the machines appear on the dashboard.
- **Device IDs:** `test000` … `test999`. The `test` prefix keeps synthetic data separable from real `tb*` devices forever.

**Two safety rules that must not be broken:**

1. The generator reads `loadtest/.env.vm` and **never** `local-backend/.env.loadtest`. Mixing them points the local stack at the VM broker, and [mqttHub.js:48](../../local-backend/util/mqttHub.js#L48) subscribes to `#` — the local backend would ingest the VM's entire firehose.
2. Nothing in this plan issues a `DELETE`, `DROP`, or `TRUNCATE` against the VM. Cleanup, if ever needed, is scoped by `WHERE device LIKE 'test%'` and is out of scope here.

**On commits:** the task steps below include commit commands for completeness, but per the repo's working agreement **do not commit without explicit approval**. Draft the change, get it reviewed, then ask.

**A realism caveat worth stating once:** 10 msg/s per machine is roughly 30× the real cadence measured on live devices (1–18s per cycle, see [writer.js:4](../../loadtest/writer.js#L4)). That is intentional — this is a stress target, not a simulation. `RATE_HZ` is configurable so a realistic-cadence run can be compared against the stress run.

---

## Task 1: Scaffold the generator directory and compose service

**Files:**
- Create: `loadtest/mqtt/README.md`
- Create: `docker-compose.mqttgen.yml`
- Verify exists: `loadtest/.env.vm` (gitignored via root `.gitignore`)

**Step 1: Confirm the env file has every key this plan needs**

`loadtest/.env.vm` must contain:

```
VM_HOST=10.128.17.253
AUTH_API=http://10.128.17.253:8001/auth/login
DEVICES_API=http://10.128.17.253:8000/api/v1/devices
API_USERNAME=xxxx
API_PASSWORD=xxxx
MQTT_HOST=10.128.17.253
MQTT_PORT=1883
DIV=nat
PROCESS=tn
```

Fill `DEVICES_API` with the real port. Confirm it is gitignored:

Run: `git check-ignore -v loadtest/.env.vm`
Expected: a line naming `.gitignore` and the pattern `loadtest/.env.vm`. **If this prints nothing, stop** — credentials would be committed.

**Step 2: Create the compose file**

```yaml
# MQTT ingest load generator. Targets the VM broker, NOT the local stack.
#
#   docker compose -f docker-compose.mqttgen.yml run --rm gen
#
# Deliberately separate from docker-compose.loadtest.yml: that stack's env file
# points at local containers, and this one points at a real VM. A single file
# holding both is one typo away from the local backend subscribing to the VM.

services:
  gen:
    # Reuses the image built by docker-compose.loadtest.yml purely for its
    # node_modules (mqtt@5 is already a dependency). Build it first if missing:
    #   docker compose -f docker-compose.loadtest.yml build backend
    image: backend-dx_center
    env_file:
      - ./loadtest/.env.vm
    volumes:
      - ./local-backend:/app
      - ./loadtest:/loadtest
      - /app/node_modules
    environment:
      TZ: Asia/Bangkok
      # Scripts under /loadtest are outside /app, so Node's module resolution
      # never reaches /app/node_modules on its own.
      NODE_PATH: /app/node_modules
    working_dir: /loadtest
    command: ["node", "/loadtest/mqtt/generator.js"]
```

Note there is **no `depends_on`** and no local broker — this container's only dependency is the VM.

**Step 3: Verify the image exists and Node resolves `mqtt`**

Run:
```cmd
docker compose -f docker-compose.mqttgen.yml run --rm gen node -e "console.log(require('mqtt/package.json').version)"
```
Expected: a `5.x` version string. If it errors with `Cannot find module 'mqtt'`, the `backend-dx_center` image has not been built — run `docker compose -f docker-compose.loadtest.yml build backend` first.

**Step 4: Write `loadtest/mqtt/README.md`**

A short orientation file: what this directory is, that it targets a real VM, the two safety rules above, and a pointer to this plan and to the findings doc.

**Step 5: Commit (ask first)**

```bash
git add docker-compose.mqttgen.yml loadtest/mqtt/README.md
git commit -m "chore(loadtest): scaffold MQTT ingest generator"
```

---

## Task 2: Device identity module

**Files:**
- Create: `loadtest/mqtt/devices.js`
- Test: `loadtest/mqtt/devices.test.js`

This is pure logic — no I/O — so it is unit-testable and gets tested first.

**Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { deviceIds, topic, macFor } = require("./devices");

test("deviceIds generates a zero-padded contiguous range", () => {
  const ids = deviceIds(1000);
  assert.strictEqual(ids.length, 1000);
  assert.strictEqual(ids[0], "test000");
  assert.strictEqual(ids[999], "test999");
});

test("deviceIds honours a smaller count for smoke runs", () => {
  assert.deepStrictEqual(deviceIds(3), ["test000", "test001", "test002"]);
});

test("topic builds the four-segment VM topic", () => {
  assert.strictEqual(topic("data", "test042"), "data/nat/tn/test042");
  assert.strictEqual(topic("alarm", "test042"), "alarm/nat/tn/test042");
});

// A duplicate MAC across simulated devices would make the VM treat two
// machines as one. Deterministic so a run is reproducible.
test("macFor is unique per device and stable across calls", () => {
  const macs = deviceIds(1000).map(macFor);
  assert.strictEqual(new Set(macs).size, 1000);
  assert.strictEqual(macFor("test042"), macFor("test042"));
  assert.match(macFor("test042"), /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
});
```

**Step 2: Run it and watch it fail**

Run: `docker compose -f docker-compose.mqttgen.yml run --rm gen node --test /loadtest/mqtt/devices.test.js`
Expected: FAIL — `Cannot find module './devices'`.

**Step 3: Implement**

```js
/**
 * Device identity for the MQTT ingest generator.
 *
 * Device IDs are `test000`-`test999`. The `test` prefix is load-bearing: it is
 * what makes synthetic rows separable from real `tb*` devices in ClickHouse
 * forever, so a cleanup query can never touch production data.
 */
const DIV = process.env.DIV || "nat";
const PROCESS = process.env.PROCESS || "tn";

const deviceIds = (count) =>
  Array.from({ length: count }, (_, i) => `test${String(i).padStart(3, "0")}`);

const topic = (type, device) => `${type}/${DIV}/${PROCESS}/${device}`;

/** Deterministic locally-administered MAC, derived from the device index. */
const macFor = (device) => {
  const n = Number(device.slice(4));
  const hex = (v) => v.toString(16).toUpperCase().padStart(2, "0");
  return ["02", "00", "5E", hex((n >> 16) & 0xff), hex((n >> 8) & 0xff), hex(n & 0xff)].join(":");
};

module.exports = { DIV, PROCESS, deviceIds, topic, macFor };
```

**Step 4: Run the test again**

Run: `docker compose -f docker-compose.mqttgen.yml run --rm gen node --test /loadtest/mqtt/devices.test.js`
Expected: PASS, 4/4.

**Step 5: Commit (ask first)**

---

## Task 3: Reference value sets

**Files:**
- Create: `loadtest/mqtt/values.js`
- Test: `loadtest/mqtt/values.test.js`

**Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { ALARM_VALUES, STATUS_VALUES } = require("./values");

test("alarm set matches the VM master table exactly", () => {
  assert.strictEqual(ALARM_VALUES.length, 60);
  assert.ok(ALARM_VALUES.includes("COVER OPEN"));
});

// These are stored truncated at the device. "Correcting" them to real words
// makes the VM's exact-match check discard the message silently.
test("upstream-truncated alarm strings are preserved verbatim", () => {
  assert.ok(ALARM_VALUES.includes("GEAR R.P.M NO SETTIN"));
  assert.ok(ALARM_VALUES.includes("INVERTER MAIN MOTO"));
  assert.ok(ALARM_VALUES.includes("EMERGENCE PUSHTBUT"));
  assert.ok(!ALARM_VALUES.includes("INVERTER MAIN MOTOR"));
});

test("status set is the lowercase publishable values only", () => {
  assert.deepStrictEqual(STATUS_VALUES, ["run", "stop", "wait", "alarm", "other"]);
});

// `offline` is derived downstream from staleness. Publishing it would be a
// device claiming a state only the server is allowed to conclude.
test("offline is not publishable", () => {
  assert.ok(!STATUS_VALUES.includes("offline"));
});
```

**Step 2: Run it and watch it fail**

Expected: FAIL — `Cannot find module './values'`.

**Step 3: Implement**

Create `values.js` exporting `STATUS_VALUES` and `ALARM_VALUES`. Copy all 60 alarm strings verbatim from §5e of [docs/mqtt-ingest-load-test.md](../mqtt-ingest-load-test.md). Head the file with a comment explaining that exact-string matching means any edit silently discards messages.

**Step 4: Run the test again** — expected PASS, 4/4.

**Step 5: Commit (ask first)**

---

## Task 4: Payload builder

**Files:**
- Create: `loadtest/mqtt/payload.js`
- Test: `loadtest/mqtt/payload.test.js`

The 37-field `data` payload, with monotonic counters. Monotonicity is the load-bearing property: these are cumulative counters, and a value that decreases produces negative deltas downstream — silent garbage, exactly as [writer.js:69](../../loadtest/writer.js#L69) documents.

**Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { newMachineState, buildDataPayload, FIELD_COUNT } = require("./payload");

test("payload carries every field the real device sends", () => {
  const p = buildDataPayload(newMachineState("test000", 1), "M-1");
  assert.strictEqual(Object.keys(p).length, FIELD_COUNT);
  for (const f of ["rssi", "prod_pos4", "prod_pos6", "cycle_t", "model", "spec", "id_num"]) {
    assert.ok(f in p, `missing ${f}`);
  }
});

test("marker rides in id_num", () => {
  assert.strictEqual(buildDataPayload(newMachineState("test000", 1), "M-42").id_num, "M-42");
});

test("counters never decrease across 500 ticks", () => {
  const s = newMachineState("test000", 7);
  let prev = buildDataPayload(s, "m0");
  for (let i = 1; i < 500; i++) {
    const cur = buildDataPayload(s, `m${i}`);
    for (const f of ["prod_pos4", "prod_pos6", "prod_drop_pos4", "utilization", "prod_ok"]) {
      assert.ok(cur[f] >= prev[f], `${f} decreased at tick ${i}`);
    }
    prev = cur;
  }
});

test("same seed reproduces an identical run", () => {
  const a = buildDataPayload(newMachineState("test000", 99), "m");
  const b = buildDataPayload(newMachineState("test000", 99), "m");
  assert.deepStrictEqual(a, b);
});

test("rssi stays in a plausible dBm band", () => {
  const s = newMachineState("test000", 3);
  for (let i = 0; i < 200; i++) {
    const { rssi } = buildDataPayload(s, `m${i}`);
    assert.ok(rssi <= -30 && rssi >= -95, `rssi out of band: ${rssi}`);
  }
});
```

**Step 2: Run it and watch it fail.**

**Step 3: Implement**

- Reuse the `mulberry32` PRNG from [fixture.js:6](../../loadtest/fixture.js#L6) — extract it rather than copying if convenient, but a 6-line duplicate across two independent harnesses is acceptable; do not create a shared package for it.
- `newMachineState(device, seed)` returns `{ device, rnd, counters: {...}, rssi }` with counters seeded to plausible non-zero starting values.
- `buildDataPayload(state, marker)` mutates counters upward, jitters `rssi` within band, sets `time_hr`/`time_min` from the current clock, `model: 0`, `spec: 0`, `id_num: marker`, and returns a flat object of exactly `FIELD_COUNT` (37) keys.
- Field list comes from the real `tb22` sample in §4 of the findings doc.

**Step 4: Run the test again** — expected PASS, 5/5.

**Step 5: Commit (ask first)**

---

## Task 5: Shard assignment

**Files:**
- Create: `loadtest/mqtt/shard.js`
- Test: `loadtest/mqtt/shard.test.js`

**Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { shardFor } = require("./shard");

test("shards partition the device list with no gaps or overlaps", () => {
  const all = [];
  for (let w = 0; w < 4; w++) all.push(...shardFor(1000, 4, w));
  assert.strictEqual(all.length, 1000);
  assert.strictEqual(new Set(all).size, 1000);
});

test("uneven splits differ by at most one device", () => {
  const sizes = [0, 1, 2].map((w) => shardFor(1000, 3, w).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test("more workers than devices yields empty shards, not crashes", () => {
  assert.deepStrictEqual(shardFor(2, 4, 3), []);
});
```

**Step 2: Run it and watch it fail. Step 3: Implement. Step 4: Run — expected PASS, 3/3. Step 5: Commit (ask first).**

---

## Task 6: One-time device registration

**Files:**
- Create: `loadtest/mqtt/register.js`

Run once, outside the generator, so the generator never handles credentials. Ingest does not need this — it exists purely so the machines appear on the dashboard and can be reused by a later read-side test.

**Step 1: Implement**

Using `axios` (already a dependency):

1. `POST ${AUTH_API}` with `{username, password}` from env; extract the token. Log the response shape on failure — the field name is unverified.
2. For each of `deviceIds(COUNT)`, `POST ${DEVICES_API}` with `{process: "tn", device: id}` and an `Authorization: Bearer` header.
3. Concurrency **capped at 10** — this is a real API and the goal is registration, not a DoS of the registration endpoint.
4. Treat "already exists" responses as success and count them separately.
5. Print `registered: N ok, M already-existed, K failed` and exit non-zero if `K > 0`.

**Step 2: Dry run against a small count**

Run:
```cmd
docker compose -f docker-compose.mqttgen.yml run --rm -e COUNT=3 gen node /loadtest/mqtt/register.js
```
Expected: `registered: 2 ok, 1 already-existed, 0 failed` (`test001` exists from Phase A).

**Step 3: Full run**

Run with `COUNT=1000`. Expected `0 failed`. Note the wall-clock duration — if registering 1000 devices is slow, that is itself a finding worth recording.

**Step 4: Verify on the dashboard** that the `test*` machines appear.

**Step 5: Commit (ask first)**

---

## Task 7: The generator

**Files:**
- Create: `loadtest/mqtt/generator.js`

**Step 1: Implement the primary process**

Reads config from env with defaults:

| Var | Default | Meaning |
|---|---|---|
| `COUNT` | `1000` | machines |
| `RATE_HZ` | `10` | `data` messages per machine per second |
| `WORKERS` | `4` | forked processes |
| `CONN_MODE` | `per-device` | `per-device` (1000 clients) or `pooled` |
| `POOL_SIZE` | `20` | clients per worker when pooled |
| `QOS` | `0` | 0 or 1 |
| `DURATION_S` | `60` | run length; `0` = until killed |
| `RUN_ID` | timestamp | marker prefix |

The primary forks `WORKERS`, aggregates their per-10s counts, and prints one line per interval:

```
[gen] t=30s target=10000/s achieved=9985/s clients=1000 rssMB=412 inflight=0
```

**`achieved` vs `target` is the single most important number this tool produces.** If achieved is below ~95% of target, the generator is the bottleneck and every downstream metric is measuring your PC, not the VM — the same false positive called out in [load-test-runbook.md §6](../load-test-runbook.md). Print an explicit warning when it drops below that line.

**Step 2: Implement the worker**

- Compute `shardFor(COUNT, WORKERS, id)`; build a `newMachineState` per device with a per-device seed.
- Connect MQTT clients per `CONN_MODE`. In `per-device` mode use `clientId: device` — one TCP connection per simulated machine, which is what a real plant looks like and what makes `mosquitto_clients_connected` meaningful. **Stagger connects** across a few seconds; 1000 simultaneous CONNECTs is a thundering herd that tests connection handling, not steady-state throughput.
- On connect, publish the machine's `mqtt` identity topic once, using `macFor(device)`.
- Run **one** 10ms scheduler loop for the whole shard — not one timer per machine. Give each device a phase offset (`index % (1000 / RATE_HZ)` ms) so publishes spread evenly across each second rather than arriving as 1000 simultaneous bursts 10× a second.
- Each `data` publish gets marker `${RUN_ID}-${device}-${seq}`.
- Guard against overlapping ticks with a `busy` flag, exactly as [writer.js:119](../../loadtest/writer.js#L119) does. Without it a slow broker queues ticks behind each other and the reported rate stops meaning anything.

**Step 3: Model status and alarm as rare edge events, not per-tick**

Publishing all four topics at `RATE_HZ` would quadruple the message count against observed behavior. Per tick, per machine: transition `status` with probability ~0.002 (drawn from `STATUS_VALUES`), and emit an `alarm` with probability ~0.001 (drawn from `ALARM_VALUES`). Replace both with measured rates once the frequency query in §5e has been run.

**Step 4: Handle backpressure honestly**

With `QOS=0`, `mqtt.js` buffers in memory when the socket cannot keep up — the publish call returns instantly and RSS grows silently. Track outstanding publishes and include `rssMB` in the status line. **Rising RSS with a flat `achieved` rate means the generator is saturated**, not the broker.

**Step 5: Smoke test — one machine**

Run:
```cmd
docker compose -f docker-compose.mqttgen.yml run --rm -e COUNT=1 -e WORKERS=1 -e RATE_HZ=10 -e DURATION_S=60 -e RUN_ID=PHASE-A-S gen
```
Expected: `achieved` ≈ 10/s, exits after 60s, reporting ~600 published.

**Step 6: Verify in ClickHouse — this completes Phase A step 6**

```cmd
ssh <VM_USER>@10.128.17.253 "docker exec <CH_CONTAINER> clickhouse-client -q \"SELECT count() FROM <DB>.<TABLE> WHERE device = 'test000' AND id_num LIKE 'PHASE-A-S-%'\""
```
Expected: exactly **600**. Fewer means loss at 10 msg/s from a *single* machine — a blocking finding. Do not proceed to Task 8 until it is understood.

**Step 7: Commit (ask first)**

---

## Task 8: Establish generator capacity before trusting any result

**Files:**
- Create: `loadtest/mqtt/results/.gitkeep`
- Modify: `.gitignore` — add `loadtest/mqtt/results/`

This task exists because **the most common failure in load testing is measuring your own load generator.** Do it before any VM conclusions.

**Step 1: Ramp against the VM, recording `achieved` at each step**

Run 60s each at `COUNT` = 10, 50, 100, 250, 500, 1000, all at `RATE_HZ=10`. Record `achieved`, `rssMB`, and host CPU for each.

**Step 2: Find the knee**

The first `COUNT` where `achieved` falls below 95% of `target` is your generator's ceiling. If that happens **below 1000 machines**, the PC cannot generate the target load and you must resolve it before continuing:

- Raise `WORKERS` toward the host's core count.
- Switch `CONN_MODE=pooled` — this trades broker connection realism for throughput, and it is the right trade if the alternative is not reaching the target at all.
- If neither works, run `emqtt-bench` purely to establish whether the broker or the PC is the limit. That is a diagnostic detour, not a replacement generator — it cannot verify delivery.

**Step 3: Record the verdict** in `loadtest/mqtt/results/capacity.md`: max sustainable `COUNT`, the settings that achieved it, and whether 1000 × 10/s is reachable from this PC at all. Every later run is interpreted against this ceiling.

**Step 4: Commit (ask first)**

---

## Task 9: Delivery and latency verification

**Files:**
- Create: `loadtest/mqtt/verify.md`

A document, not code — these are `ssh`+`clickhouse-client` queries run after a run, and wrapping them in a script would hide the SQL for no benefit.

Include, parameterized by `RUN_ID`:

1. **Delivery rate** — `count()` of markers matching the run vs. the generator's reported published total. Anything under 100% is loss; locate it by re-running the count against Redis and Kafka to find the hop where it disappears.
2. **Per-device completeness** — `GROUP BY device HAVING count() < expected`. Reveals whether loss is uniform or concentrated in specific machines, which distinguishes a broker-wide problem from a per-connection one.
3. **End-to-end latency** — ClickHouse ingest timestamp minus the publish time encoded in the marker; report p50/p95/max.
4. **Ordering/monotonicity** — assert `prod_pos4` is non-decreasing per device. A violation means reordering somewhere in the pipeline, which no rate metric would ever show.

**Commit (ask first)**

---

## Task 10: Fold Phase B into the runbook

**Files:**
- Modify: `docs/mqtt-ingest-load-test.md`

Replace the placeholder text in step 6 (which currently says the loop "needs the Node generator, which is Phase B's first deliverable") with the real invocation, and add a Phase B section covering the env vars, the `achieved` vs `target` rule, and a pointer to `verify.md`.

**Commit (ask first)**

---

## Out of scope — Phase C

Deliberately excluded; a separate plan once Task 8 establishes what this PC can actually generate:

- Ramp-to-break, spike, and soak scenarios with per-stack pass/fail thresholds.
- Prometheus scraping automation and the per-stack metric table from the Phase A discussion.
- Simultaneous write-side + read-side load (1000 machines ingesting while 50 dashboards poll) — the only configuration that exposes Redis contention between writer and reader.
- Kafka consumer-group lag as the primary break-point signal.
