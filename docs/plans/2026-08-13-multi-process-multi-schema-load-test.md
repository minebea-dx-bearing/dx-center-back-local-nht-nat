# Multi-Process, Multi-Schema Load Test Implementation Plan

Extends the Phase B MQTT ingest generator
([2026-08-10-mqtt-ingest-generator.md](2026-08-10-mqtt-ingest-generator.md),
implemented and measured in
[../../loadtest/mqtt/results/capacity.md](../../loadtest/mqtt/results/capacity.md))
from one process with one schema to N processes each with its own schema,
without raising the total machine count above 1000.

## The question this answers

The ingest server guarantees at most **50 columns** on a process's `data`
topic, so a wide plant is modelled as several processes rather than one wide
table. Today's harness only ever exercises one (`tn`, 39 registered columns).

**Does splitting the same machine count and the same total message rate across
several processes cost the server more than keeping it in one?**

The hypothesis worth testing: N processes almost certainly means N ClickHouse
tables, so identical total throughput arrives as **N× more insert batches at
1/N the batch size each** — more parts, more merges, more overhead, at zero
extra message volume. Column width is the second, independent axis: a wider
row costs more per insert regardless of how many processes exist.

Everything else — total machines, total msg/s, topic cadence, QoS, connection
mode — is held constant so any degradation is attributable to those two axes
and nothing else.

## Context an implementer needs before starting

- **An unregistered column is dropped silently, not rejected.** Same failure
  mode as the exact-string matching documented in
  [../../loadtest/mqtt/values.js](../../loadtest/mqtt/values.js). A run against
  a process whose columns were never registered inserts near-empty rows, looks
  fast, and measures nothing. Column registration is therefore **on the
  critical path** for this test.
- **Device registration is not.** Measured 2026-08-10 (§2 of
  [../mqtt-ingest-load-test.md](../mqtt-ingest-load-test.md)): the MQTT ingest
  path does not consult the device registry; `test001` reached Redis, Kafka and
  ClickHouse purely by publishing, after the registration call returned 401.
  Device registration is a read-side concern (dashboard visibility) and must
  never block a throughput run.
- **`tn` is the control and must not be reshaped.** Its 39 columns were
  verified against `DESCRIBE TABLE` on the real sink. Changing its width would
  break comparability with every number in `results/capacity.md`.
- **`spec` and `id_num` are published but map to no ClickHouse column** and are
  dropped. They are deliberately *not* registered. Registering them would
  change what the control run inserts, mid-test.
- **Device ids must stay disjoint across processes.** If anything downstream
  keys on device alone, reusing `test000` under every process silently merges
  two machines into one series, and no count or rate check in
  [../../loadtest/mqtt/verify.md](../../loadtest/mqtt/verify.md) would surface
  it.
- **`.env.vm` only.** Never load `local-backend/.env` or `.env.loadtest` into a
  load-test container — `mqttHub.js` subscribes to `#`, so a VM broker URL in
  the wrong file makes the local backend ingest the VM's entire firehose.
- API endpoints (all sharing one bearer token from `AUTH_API`):
  - `POST http://10.128.17.253:8001/auth/login`
  - `POST http://10.128.17.253:8001/api/v1/columns/batch`
    — `{"columns":[{"process","column_name","column_type","column_key"}]}`
  - `DELETE http://10.128.17.253:8001/api/v1/columns?process=<p>&column_name=<c>`
    — one column per call, so cleanup is N columns × N processes calls
  - `POST http://10.128.17.253:8000/api/v1/devices` — `{"process","device"}`
  - Accepted column types: `Float32`, `Float64`, `String`, `Int32`, `Int64`,
    `UInt32`, `UInt64`, `Bool`, `DateTime`.

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Machine identity | `(process, device)` pair | A device id alone is no longer unique across the run |
| Device id allocation | Disjoint ranges, `tn`=test000.., `lt1`=next block | Overlapping ids merge series silently downstream |
| Synthetic process names | `lt1`, `lt2`, … | Permanently separable from real processes, like the `test` device prefix |
| Synthetic column names | `<process>_c00`..`_cNN` | Globally unique, so N processes are genuinely N schemas even if the server keeps one global column dictionary |
| Column types | Fixed positional cycle, mostly `Int32` counters | `lt1_c07` and `lt2_c07` are the same type, so process count varies without varying the workload mix |
| `tn`'s schema | Fixed at 39 columns, ignores `SCHEMA_COLUMNS` | It is the control run |
| Default `SCHEMA_COLUMNS` | 40 | Close to `tn`'s 39, so the default multi-process run varies process count *only* |
| Registration | Separate script, run manually | A load test must not mutate server schema as a side effect |
| Column failures | Fatal | Silently-dropped columns invalidate the run |
| Device failures | Warn only | Ingest ignores the registry (measured) |

## Task 1: Per-process schema registry — DONE

`loadtest/mqtt/schemas.js` + `schemas.test.js` (12 tests, passing).

Owns column definitions for both the publish side and the registration side, so
the two cannot drift — a drift is invisible at runtime.

- `TN_COLUMNS` — the real 39-column schema. `TN_COUNTER_FIELDS` moved here out
  of `payload.js`.
- `syntheticColumns(process, columnCount)` — `<process>_cNN`, deterministic in
  name and type, so re-registration is idempotent and reruns are comparable.
- `roleFor(type)` — derives value generation from the column type
  (integer→monotonic counter, float→bounded jitter, String→per-machine
  constant, Bool→coin flip, DateTime→now), so a synthetic schema needs no
  per-column metadata.
- `schemaFor(process, columnCount)` — `tn` branch returns the real schema.
- `assertValidSchema` — throws client-side on >50 columns, unknown type, or
  duplicate name. Over-limit is checked here because it is unknown whether the
  server rejects or truncates; assume truncate.
- `toRegistrationBody(process, columns)` — the `/columns/batch` shape.

## Task 2: Multi-process device identity — DONE

`loadtest/mqtt/devices.js` + `devices.test.js` (8 tests, passing).

- `PROCESSES` — comma-separated env, falling back to the old `PROCESS`, so an
  existing `.env.vm` and every single-process run stay byte-identical to the
  capacity.md baseline (pinned by a test).
- `allocate(count, processes)` — even split, remainder to the earliest
  processes, disjoint device ranges, stable order (the generator shards it by
  index, so worker assignment is reproducible across runs).
- `topic(type, process, device)` — **breaking signature change**. Deliberately
  not defaulted: a silent fallback to `tn` would publish a whole process's
  traffic to the wrong topic while `achieved/s` still looked healthy.

## Task 3: Registration script — DONE

`loadtest/mqtt/register.js`. Run once before a run, never from the generator.

Login → `POST /columns/batch` per process (fatal on failure) → `POST /devices`
per machine (warn only, grouped by status so 1000 identical 401s print once,
concurrency 8).

- Schemas are built **before the first request**, so a malformed or over-wide
  schema throws before anything is written to a shared server — no half-
  registered state.
- `DRY_RUN=true` prints the exact bodies and skips login entirely.
- `REGISTER_DEVICES=false` skips the device phase for pure throughput runs.
- The login response envelope is undocumented; `access_token` / `token` /
  `data.token` / `data.access_token` are all accepted, and failure prints the
  whole body rather than dying on `undefined`.

**Verified against the live API, 2026-08-13:** the token envelope worked as
implemented. `/columns/batch` is **not** idempotent — a duplicate column
returns `400` with `"already registered"` in the body, same shape as the
pre-2026-08-10 device-registration bug. Fixed the same way: `registerColumns`
now treats a `400` matching `/already registered/i` as success rather than
fatal, so re-running against an already-registered process is genuinely
idempotent as the task requires.

## Task 4: Schema-driven payload builder — TODO

Rewrite `loadtest/mqtt/payload.js` to build a `data` payload from a schema
rather than the hardcoded `tn` field list.

- `newMachineState(process, device, seed, columns)` — seeds one value per
  column according to `roleFor(column.type)`. Counters keyed by column name.
- `buildDataPayload(state, marker)` — advances counters monotonically (a
  decrease produces negative deltas downstream, silently), jitters floats
  within bounds, holds strings constant, emits `spec` and `id_num` for `tn`
  only.
- Keep the existing `mulberry32` PRNG and per-machine seeding so a given run id
  reproduces identical payloads.
- **Verification requirement:** `tn`'s payload must be field-for-field
  identical to the current implementation's output, or capacity.md becomes
  incomparable. Pin this with a test that builds a payload from a fixed seed
  and asserts the exact key set and the counter-monotonicity property.

## Task 5: Generator sharding over (process, device) pairs — DONE

`loadtest/mqtt/generator.js`.

- Replace `deviceIds(COUNT)` with `allocate(COUNT)`; shard the pair list.
- Each machine carries its own `process` and its schema's column list; build
  its state from that schema at startup, not per tick.
- Every `topic(...)` call takes `m.process`.
- Startup log line gains `processes=` and `schema_columns=`.
- Per-topic cadence (`DATA_INTERVAL_S`, `STATUS_INTERVAL_S`, `ALARM_INTERVAL_S`,
  `MQTT_INTERVAL_S`) and the catch-up/phase-offset scheduler are unchanged —
  this task must not alter timing behavior.
- `status` and `alarm` values stay process-independent: they are published on
  their own topics, not `data` columns, so multi-schema does not touch them.

## Task 6: Generator capacity re-check before trusting any result — DONE

Same discipline as Task 8 of the Phase B plan. Building N schemas and N state
objects per machine is more generator-side work than the single-schema version;
confirm the generator can still sustain the target rate at 1000 machines across
10 processes **before** attributing any shortfall to the server. If `achieved/s`
falls below target, the harness is the bottleneck and every run below is
invalid.

**Verdict (2026-08-13, `RUN_ID=cap-mp-p10`):** `COUNT=1000`,
`PROCESSES=tn,lt1..lt9`, `SCHEMA_COLUMNS=40`, default `WORKERS=4`/
`CONN_MODE=per-device`, 60s. `t=10s` read 929/s (connect ramp-up, same
pattern as `capacity.md`'s single-schema 1000-machine run); `t=20s`
onward held 1009–1011/s against target=1000/s. `rssMB` flat at 48–49,
identical to the single-schema baseline. **No generator-side ceiling at
1000 machines across 10 processes** — building 10 schemas/state objects
per worker did not cost measurable throughput or memory. Task 7's sweep
is cleared to proceed.

## Task 7: The sweep — TODO

Hold total machines = 1000 and total msg/s constant throughout. 60s per run,
matching capacity.md's methodology.

| Run | `PROCESSES` | `SCHEMA_COLUMNS` | Isolates |
|---|---|---|---|
| `mp-baseline` | `tn` | n/a (39) | Reproduces the existing single-process baseline |
| `mp-p2` | `tn,lt1` | 40 | Does splitting at all cost anything |
| `mp-p5` | `tn,lt1..lt4` | 40 | How the split scales |
| `mp-p10` | `tn,lt1..lt9` | 40 | Where the knee is |
| `mp-p5-wide` | `tn,lt1..lt4` | 50 | Column width, at fixed process count |
| `mp-p5-narrow` | `tn,lt1..lt4` | 10 | The other side of the width axis |

Record per run, from Prometheus, against the idle baseline (§3 of
[../mqtt-ingest-load-test.md](../mqtt-ingest-load-test.md)):

- `ClickHouseProfileEvents_InsertedRows` — must scale with published messages,
  not with process count. If it doesn't, columns are being dropped.
- `ClickHouseAsyncMetrics_MaxPartCountForPartition` — **the primary metric.**
  This is where the N-smaller-batches hypothesis shows up.
- ClickHouse merge count / merge time, CPU, disk I/O.
- Kafka consumer group lag — a rising lag at constant input rate is the
  consumer, not ClickHouse.
- Mosquitto received/sent totals — should be flat across all runs; the broker
  does not care how many processes exist. If it moves, something in the test
  setup changed that shouldn't have.

Anything that degrades between `mp-baseline` and `mp-p10` at identical total
throughput is the multi-process cost, cleanly attributed.

## Task 8: Verification and results — TODO

- Extend [../../loadtest/mqtt/verify.md](../../loadtest/mqtt/verify.md): its
  queries assume one table. Each process needs its own `<DB>.<TABLE>`, and
  per-device completeness must be checked per process.
- **New check, specific to this test:** confirm a synthetic process's rows
  actually carry non-default values in `lt1_c00`..`lt1_cNN`. All-zeros or all-
  default means registration silently failed and the run is void — this is the
  single most likely way for this test to produce a confident wrong answer.
- Write `loadtest/mqtt/results/multi-process.md` in capacity.md's format.

## Task 9: Documentation — TODO

- `../mqtt-load-test-runbook.md` — add `PROCESSES`, `SCHEMA_COLUMNS`,
  `REGISTER_DEVICES`, `DRY_RUN` to the env table; add the register.js step.
- `../mqtt-ingest-load-test.md` — note that `.env.vm` now needs `COLUMNS_API`
  and `PROCESSES` alongside the existing `PROCESS`.
- Leave `results/capacity.md` and `2026-08-10-mqtt-ingest-generator.md`
  untouched — they are point-in-time records of what was actually run.

## Task 10: Cleanup — TODO

Add an `UNREGISTER=true` mode to `register.js` that DELETEs every column it
would have registered, one call per column, same concurrency and same
grouped-failure reporting as the device phase.

- Derives the column list from the same `schemaFor()` call as registration, so
  it can only ever delete what this harness created — it has no way to name a
  column it did not generate.
- **Refuses to run for `tn`.** `tn` is a real process; a wildcard or an
  off-by-one here deletes production schema. Guard it explicitly rather than
  relying on the operator passing the right `PROCESSES`.
- `DRY_RUN=true` lists the URLs without calling them. Use it first.
- Run only after Task 8's results are written — deleting columns before the
  verification queries have run destroys the evidence.

## Out of scope

- Changing the 50-column server limit, or testing what happens above it.
- Realistic per-process field names. Synthetic `<process>_cNN` is deliberate;
  realism costs separability and buys nothing this test measures.
- Read-side (dashboard) load under multi-process. This plan measures ingest
  only.
- Whether ClickHouse actually reclaims anything when a column is deleted. Task
  10 removes the registrations; if the underlying table or its data survives,
  that is a server-side concern outside this plan.
