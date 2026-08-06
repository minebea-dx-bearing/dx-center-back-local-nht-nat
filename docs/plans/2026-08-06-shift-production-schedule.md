# Shift Production Snapshot Service — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Twice daily (06:10 and 18:10 Asia/Bangkok), read each machine's latched shift production counters from InfluxDB and persist one row per machine per shift into MSSQL.

**Architecture:** A pure `resolveShiftContext(fireTime)` maps a fire time to `{ shift_date, shift, fields, window }`. `collectShiftTotals` issues **one** InfluxDB query (`LAST(...) GROUP BY topic`) scoped to a narrow window that starts *after* the PLC latch, so an offline machine returns no row instead of a stale value. `persistShiftTotals` upserts via `MERGE` on the natural key, making the job idempotent and safely re-runnable. The scheduler and an HTTP backfill endpoint both call the same orchestrator.

**Tech Stack:** Node **v18.20.8** (server container), `node-schedule@2.1.1`, `moment-timezone@2.30.1`, `axios` (InfluxDB v1 HTTP API), Sequelize + `tedious` (MSSQL), `node:test` (built-in).

**Branch:** `last-pd-m-n-schedule` (already checked out — do not create a worktree).

**Commits:** none. The user commits manually. Do not run `git add` or `git commit` at any point.

---

## Domain background (read before starting)

The PLC publishes MQTT into InfluxDB measurement `mqtt_consumer` roughly every 2 seconds. Four fields matter:

| Field | Meaning |
|---|---|
| `shift_m_ok` | Morning shift final OK count |
| `shift_m_ng` | Morning shift final NG count |
| `shift_n_ok` | Night shift final OK count |
| `shift_n_ng` | Night shift final NG count |

**These are latched, not accumulating.** `shift_m_*` is written once at ~18:05 and then holds that exact value for 24 hours until the next 18:05. Likewise `shift_n_*` latches at ~06:05.

Two consequences drive the whole design:

1. **Stale-read hazard.** If a machine goes offline at 17:00, its newest InfluxDB point still exists and still carries *yesterday's* latched value. A naive "latest point" query returns that number and it is indistinguishable from a real result. The only defence is to query a window that **begins after the latch time** — a live machine posts ~90 points in a 3-minute window; a dead machine posts none, and we skip it.
2. **Backfill is generous.** Because the value persists for 24h, a missed shift can be recovered any time before the next latch. This is why the backfill endpoint (Task 8) is worth building rather than a retry loop.

**Topic shape:** `data/hat/${process}/${mc_no}` — e.g. `data/hat/abc/acd01` is process `abc`, machine `acd01`. Only `process` and `mc_no` are stored; the raw topic is not, since the first two segments are constant and carry no information.

---

## Environment variables

Add to `local-backend/.env`. All three are read via `process.env` — no hardcoded hosts or table names anywhere in the code.

```
INFLUX_URL=http://10.128.16.XX
INFLUX_PORT=8086
INFLUX_DB=influx
DATA_LAST_PRODUCTION=[db].[schema].[table]
```

**Values to confirm with the user before Task 5:** the InfluxDB host and port serving these `data/hat/...` topics, and the fully-qualified target table for `DATA_LAST_PRODUCTION`. The MSSQL *connection* is already handled — reuse [ms_instance_nat.js](../../local-backend/instance/ms_instance_nat.js), which reads `NAT_SERVER` / `NAT_SERVER_USERNAME` / `NAT_SERVER_PASSWORD`.

---

## Task 1: Wire up a test runner

No test framework exists — `scripts.test` is the placeholder error stub.

**On Node 18, `node --test` does not accept glob patterns.** Glob support landed in v21. It must be given a *directory*, which it recurses, picking up files matching `*.test.js`. Passing `services/**/__tests__/*.test.js` here fails or silently matches nothing.

Note: `local-backend/.gitignore` ignores `test/`, so tests live in `services/shiftSummary/__tests__/`.

**Files:**
- Modify: `local-backend/package.json`

**Step 1: Add the test script**

```json
  "scripts": {
    "start": "nodemon server.js",
    "test": "node --test services/"
  },
```

**Step 2: Verify the runner works**

```bash
cd local-backend && npm test
```

Expected: exits 0, reporting 0 tests. Node 18 prints an `ExperimentalWarning` for the test runner — that is normal and not a failure.

---

## Task 2: `resolveShiftContext` — the pure core (TDD)

The load-bearing piece. Pure, so fully testable without InfluxDB or MSSQL, and both the scheduler and the backfill endpoint depend on it.

**Files:**
- Create: `local-backend/services/shiftSummary/resolveShiftContext.js`
- Test: `local-backend/services/shiftSummary/__tests__/resolveShiftContext.test.js`

**Step 1: Write the failing test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");

const { resolveShiftContext } = require("../resolveShiftContext");

// 18:10 Bangkok closes the MORNING shift that started the same day at 06:00.
test("evening run resolves to shift 1 on the same calendar date", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 18:10:00", "Asia/Bangkok"));

  assert.equal(ctx.shift, 1);
  assert.equal(ctx.shift_date, "2026-08-06");
  assert.equal(ctx.okField, "shift_m_ok");
  assert.equal(ctx.ngField, "shift_m_ng");
});

// 06:10 Bangkok closes the NIGHT shift that started the PREVIOUS day at 18:00.
test("morning run resolves to shift 2 dated the previous day", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 06:10:00", "Asia/Bangkok"));

  assert.equal(ctx.shift, 2);
  assert.equal(ctx.shift_date, "2026-08-05");
  assert.equal(ctx.okField, "shift_n_ok");
  assert.equal(ctx.ngField, "shift_n_ng");
});

// The window must START AFTER the ~18:05 / ~06:05 latch, or a dead machine's
// stale value gets read as if it were fresh.
test("window opens after the latch and closes at fire time, in UTC", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 18:10:00", "Asia/Bangkok"));

  assert.equal(ctx.windowStartUtc, "2026-08-06T11:07:00Z"); // 18:07 +07
  assert.equal(ctx.windowEndUtc, "2026-08-06T11:10:00Z");   // 18:10 +07
});

test("window is correct across the UTC date boundary on the morning run", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 06:10:00", "Asia/Bangkok"));

  assert.equal(ctx.windowStartUtc, "2026-08-05T23:07:00Z"); // previous UTC day
  assert.equal(ctx.windowEndUtc, "2026-08-05T23:10:00Z");
});

// Guard against a hand-triggered backfill at a nonsense hour silently
// producing a wrong shift instead of failing loudly.
test("throws when fired outside a recognised shift-close hour", () => {
  assert.throws(
    () => resolveShiftContext(moment.tz("2026-08-06 12:00:00", "Asia/Bangkok")),
    /not a shift-close/i
  );
});
```

**Step 2: Run test to verify it fails**

```bash
cd local-backend && npm test
```

Expected: FAIL — `Cannot find module '../resolveShiftContext'`.

**Step 3: Write the implementation**

```js
const moment = require("moment-timezone");

const TZ = "Asia/Bangkok";

/**
 * Minutes before fire time that the read window opens.
 *
 * The PLC latches shift_m_* at ~18:05 and shift_n_* at ~06:05. With the job
 * firing at :10, a 3-minute window spans :07-:10 — safely after the latch,
 * and wide enough that any live machine (publishing every ~2s) lands ~90
 * points in it. If machines start getting skipped, the latch is running late:
 * move JOB_MINUTE to 15 rather than widening this, because a window that
 * reaches back before the latch reintroduces the stale-read hazard.
 */
const WINDOW_MIN = 3;

const SHIFTS = {
  // Fired at 18:10 -> closes the morning shift that began 06:00 the same day.
  18: { shift: 1, okField: "shift_m_ok", ngField: "shift_m_ng", dateOffsetDays: 0 },
  // Fired at 06:10 -> closes the night shift that began 18:00 the day before.
  6: { shift: 2, okField: "shift_n_ok", ngField: "shift_n_ng", dateOffsetDays: -1 },
};

/**
 * The hours the scheduler must fire at are exactly the hours SHIFTS knows how
 * to resolve. Deriving them keeps the two from drifting apart — a hardcoded
 * list in the scheduler fails silently (a new shift never gets scheduled, with
 * no error at startup) or fails 12 hours late (an unknown hour fires and
 * throws inside a caught handler).
 */
const SHIFT_CLOSE_HOURS = Object.keys(SHIFTS).map(Number);

/**
 * Map a fire time to everything the collector and writer need.
 *
 * Pure — no I/O, no clock reads, no side effects. The fire time is passed in
 * explicitly so both the scheduler and the backfill endpoint can drive it.
 *
 * @param {moment.MomentInput} fireTime  moment the job fired (any zone; normalised to Bangkok)
 * @returns {{shift_date: string, shift: number, okField: string, ngField: string,
 *            windowStartUtc: string, windowEndUtc: string}}
 * @throws {Error} if fireTime is not within a recognised shift-close hour
 */
const resolveShiftContext = (fireTime) => {
  const fire = moment.tz(fireTime, TZ);
  const spec = SHIFTS[fire.hour()];

  if (!spec) {
    throw new Error(
      `resolveShiftContext: ${fire.format()} is not a shift-close time (expected hour 06 or 18 in ${TZ})`
    );
  }

  return {
    shift_date: moment(fire).add(spec.dateOffsetDays, "days").format("YYYY-MM-DD"),
    shift: spec.shift,
    okField: spec.okField,
    ngField: spec.ngField,
    windowStartUtc: moment(fire).subtract(WINDOW_MIN, "minutes").utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
    windowEndUtc: moment(fire).utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
  };
};

module.exports = { resolveShiftContext, SHIFT_CLOSE_HOURS, TZ, WINDOW_MIN };
```

**Step 4: Run test to verify it passes**

```bash
cd local-backend && npm test
```

Expected: PASS — 5 tests, 0 failures.

---

## Task 3: `parseTopic` (TDD)

Now that `topic` is not stored, its two useful segments must be extracted before the write. Pure and cheap to test, so it gets its own file rather than hiding inside the collector.

**Files:**
- Create: `local-backend/services/shiftSummary/parseTopic.js`
- Test: `local-backend/services/shiftSummary/__tests__/parseTopic.test.js`

**Step 1: Write the failing test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTopic } = require("../parseTopic");

test("extracts process and machine number", () => {
  assert.deepEqual(parseTopic("data/hat/abc/acd01"), { process: "abc", mc_no: "acd01" });
});

// An unexpected topic shape must not silently produce a row with garbage keys,
// because process + mc_no are part of the primary key.
test("returns null for a topic with the wrong segment count", () => {
  assert.equal(parseTopic("data/hat/abc"), null);
  assert.equal(parseTopic("data/hat/abc/acd01/extra"), null);
  assert.equal(parseTopic(""), null);
});

test("returns null when a segment is empty", () => {
  assert.equal(parseTopic("data/hat//acd01"), null);
});
```

**Step 2: Run test to verify it fails**

```bash
cd local-backend && npm test
```

Expected: FAIL — `Cannot find module '../parseTopic'`.

**Step 3: Write the implementation**

```js
/**
 * Split an MQTT topic of the form `data/hat/${process}/${mc_no}`.
 *
 * Returns null rather than partial data on any unexpected shape: process and
 * mc_no together form part of the primary key, so a malformed topic must be
 * dropped, not written with empty key columns.
 *
 * @param {string} topic
 * @returns {{process: string, mc_no: string} | null}
 */
const parseTopic = (topic) => {
  const parts = String(topic || "").split("/");
  if (parts.length !== 4) return null;

  const [, , process, mc_no] = parts;
  if (!process || !mc_no) return null;

  return { process, mc_no };
};

module.exports = { parseTopic };
```

**Step 4: Run test to verify it passes**

```bash
cd local-backend && npm test
```

Expected: PASS — 8 tests total, 0 failures.

---

## Task 4: Migration SQL — present, do not run

Per project convention, migrations are **never executed automatically**. Write the file, show it, wait for approval.

**Files:**
- Create: `local-backend/services/shiftSummary/migrations/001_create_last_production.sql`

**Step 1: Write the migration**

Substitute the real `[db].[schema].[table]` from `DATA_LAST_PRODUCTION` before running.

```sql
-- Up ------------------------------------------------------------------------
-- One row per machine per shift. ~1000 machines x 2 shifts/day ~= 730k rows/yr,
-- which is trivial for MSSQL; this table is read-heavy, not write-heavy.
--
-- The natural key is the CLUSTERED PRIMARY KEY rather than an identity column:
--   * it makes the MERGE in persistShiftTotals idempotent, so a container
--     restart or a manual re-run cannot duplicate a shift;
--   * reads always filter by shift_date range, which this key serves directly.
-- mc_no alone is not unique -- the same machine number can exist under two
-- processes -- so process is part of the key.

CREATE TABLE [db].[schema].[table] (
    [shift_date]  DATE          NOT NULL,  -- date the shift STARTED
    [shift]       TINYINT       NOT NULL,  -- 1 = M(orning), 2 = N(ight); leaves room for a 3-shift system
    [process]     VARCHAR(10)   NOT NULL,  -- 3rd topic segment
    [mc_no]       VARCHAR(10)   NOT NULL,  -- 4th topic segment
    [ok_qty]      INT           NOT NULL,
    [ng_qty]      INT           NOT NULL,
    [influx_time] DATETIME2(3)  NOT NULL,  -- timestamp of the point we read; staleness audit trail
    [created_at]  DATETIME2(0)  NOT NULL
        CONSTRAINT [DF_LAST_PRODUCTION_created_at] DEFAULT SYSDATETIME(),
    CONSTRAINT [PK_LAST_PRODUCTION] PRIMARY KEY CLUSTERED ([shift_date], [shift], [process], [mc_no])
);

-- Serves "one machine's history" and "one process over a date range".
-- process leads because every route in this backend is already process-scoped.
CREATE NONCLUSTERED INDEX [IX_LAST_PRODUCTION_process_mc_date]
    ON [db].[schema].[table] ([process], [mc_no], [shift_date] DESC)
    INCLUDE ([shift], [ok_qty], [ng_qty]);

-- Down ----------------------------------------------------------------------
-- DROP INDEX [IX_LAST_PRODUCTION_process_mc_date] ON [db].[schema].[table];
-- DROP TABLE [db].[schema].[table];
```

**Step 2: Confirm column widths**

`VARCHAR(10)` for both, per the user's sizing. Cross-check against real data before running — this codebase has process names as long as `ant_new` (7) and machine numbers manipulated by `LEFT([mc_no], 3)` in [buildRunningTimeSql.js:44](../../local-backend/util/buildRunningTimeSql.js#L44). If any live value exceeds 10 characters the insert fails loudly, which is acceptable, but better to catch it now.

**Step 3: Stop and request approval**

Do not execute this SQL. Present it and wait.

---

## Task 5: `collectShiftTotals` — one InfluxDB query

**Files:**
- Create: `local-backend/services/shiftSummary/collectShiftTotals.js`
- Modify: `local-backend/.env`

**Step 1: Confirm connection details and add to `.env`**

```
INFLUX_URL=http://10.128.16.XX
INFLUX_PORT=8086
INFLUX_DB=influx
```

**Step 2: Write the implementation**

```js
const axios = require("axios");
const { parseTopic } = require("./parseTopic");

const INFLUX_TIMEOUT_MS = 30000;

/**
 * Read the latched shift counters for every reporting machine.
 *
 * ONE query for all machines (LAST(...) GROUP BY topic) rather than one query
 * per machine — at ~1000 machines the per-machine loop used elsewhere in this
 * codebase would mean 1000 round trips.
 *
 * `epoch=ms` is REQUIRED: raw InfluxDB timestamps are nanoseconds
 * (e.g. 1785991085769420139), which exceeds Number.MAX_SAFE_INTEGER and would
 * be silently corrupted by JSON.parse.
 *
 * A machine absent from the result is OFFLINE, not zero. It is omitted from the
 * return value so the caller writes no row at all.
 *
 * @param {object} ctx result of resolveShiftContext()
 * @returns {Promise<Array<{process: string, mc_no: string, ok_qty: number, ng_qty: number, influx_time: number}>>}
 */
const collectShiftTotals = async (ctx) => {
  const { okField, ngField, windowStartUtc, windowEndUtc } = ctx;

  const q =
    `SELECT LAST("${okField}") AS ok_qty, LAST("${ngField}") AS ng_qty ` +
    `FROM mqtt_consumer ` +
    `WHERE time >= '${windowStartUtc}' AND time <= '${windowEndUtc}' ` +
    `GROUP BY "topic"`;

  const { data } = await axios.get(`${process.env.INFLUX_URL}:${process.env.INFLUX_PORT}/query`, {
    params: { db: process.env.INFLUX_DB, epoch: "ms", q },
    timeout: INFLUX_TIMEOUT_MS,
  });

  const series = data?.results?.[0]?.series || [];

  return series
    .map((s) => {
      const parsed = parseTopic(s.tags?.topic);
      const row = s.values?.[0];
      if (!parsed || !row) return null;

      const ok = row[s.columns.indexOf("ok_qty")];
      if (ok === null || ok === undefined) return null;

      return {
        ...parsed,
        ok_qty: Number(ok),
        ng_qty: Number(row[s.columns.indexOf("ng_qty")] ?? 0),
        influx_time: row[s.columns.indexOf("time")],
      };
    })
    .filter(Boolean);
};

module.exports = { collectShiftTotals };
```

**Step 3: Smoke test against the real InfluxDB**

Mocking axios here would test the mock, not the query — and the query string is the risky part. Verify against the real server instead:

```bash
cd local-backend && node -e "
require('dotenv').config();
const moment = require('moment-timezone');
const { resolveShiftContext } = require('./services/shiftSummary/resolveShiftContext');
const { collectShiftTotals } = require('./services/shiftSummary/collectShiftTotals');
// Use the most recent past shift close so the window contains real data.
const fire = moment.tz('Asia/Bangkok').hour(18).minute(10).second(0).millisecond(0);
if (fire.isAfter(moment())) fire.subtract(1, 'day');
collectShiftTotals(resolveShiftContext(fire)).then(r => {
  console.log('machines:', r.length);
  console.log(r.slice(0, 3));
});
"
```

Expected: a non-zero machine count and sane `ok_qty` values. `machines: 0` means either the window missed the latch or the host/db is wrong — do not proceed until this returns data.

---

## Task 6: `persistShiftTotals` — idempotent MERGE

**Files:**
- Create: `local-backend/services/shiftSummary/persistShiftTotals.js`

**Step 1: Understand the parameter limit before writing**

`tedious` caps a request at **2100 parameters**. At 7 bound parameters per row, a single statement tops out around 300 rows — well under 1000 machines. Rows must be chunked. This is the one non-obvious constraint in this task, and the reason this logic lives in its own file rather than inline in the orchestrator.

**Step 2: Write the implementation**

```js
const dbms = require("../../instance/ms_instance_nat");

// tedious caps a request at 2100 parameters; 7 params/row -> 200 rows = 1400.
const CHUNK_SIZE = 200;

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/**
 * Upsert one row per machine for a shift.
 *
 * MERGE on the natural key (shift_date, shift, process, mc_no) makes this
 * idempotent: a container restart, a duplicate scheduler in a second app
 * instance, or a manual backfill all converge to the same state instead of
 * duplicating rows.
 *
 * @param {object} ctx  result of resolveShiftContext()
 * @param {Array}  rows result of collectShiftTotals()
 * @returns {Promise<number>} rows written
 */
const persistShiftTotals = async (ctx, rows) => {
  if (!rows.length) return 0;

  const table = process.env.DATA_LAST_PRODUCTION;
  if (!table) throw new Error("persistShiftTotals: DATA_LAST_PRODUCTION is not set");

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",\n        ");
    const replacements = batch.flatMap((r) => [
      ctx.shift_date,
      ctx.shift,
      r.process,
      r.mc_no,
      r.ok_qty,
      r.ng_qty,
      new Date(r.influx_time),
    ]);

    await dbms.query(
      `
      MERGE ${table} AS target
      USING (VALUES
        ${values}
      ) AS source ([shift_date], [shift], [process], [mc_no], [ok_qty], [ng_qty], [influx_time])
        ON  target.[shift_date] = source.[shift_date]
        AND target.[shift]      = source.[shift]
        AND target.[process]    = source.[process]
        AND target.[mc_no]      = source.[mc_no]
      WHEN MATCHED THEN UPDATE SET
        target.[ok_qty]      = source.[ok_qty],
        target.[ng_qty]      = source.[ng_qty],
        target.[influx_time] = source.[influx_time]
      WHEN NOT MATCHED THEN
        INSERT ([shift_date], [shift], [process], [mc_no], [ok_qty], [ng_qty], [influx_time])
        VALUES (source.[shift_date], source.[shift], source.[process],
                source.[mc_no], source.[ok_qty], source.[ng_qty], source.[influx_time]);
      `,
      { replacements }
    );
  }

  return rows.length;
};

module.exports = { persistShiftTotals };
```

**Step 3: Verify idempotency against the real database**

After the migration is applied, run the orchestrator (Task 7) twice and confirm the row count is unchanged:

```sql
SELECT COUNT(*) FROM [db].[schema].[table];
```

Expected: identical count after both runs. A doubled count means the MERGE key is wrong.

---

## Task 7: Scheduler + orchestrator

`runShiftSummary` is deliberately co-located with the scheduler that drives it rather than living in its own `index.js` — it is a 15-line "collect, write, log" sequence, and a separate file for it would be indirection without payoff.

**Files:**
- Create: `local-backend/services/shiftSummary/shiftSummaryJob.js`
- Modify: `local-backend/server.js`

**Step 1: Write the job**

`tz` is a property of a `RecurrenceRule` — it is **not** honoured on a bare cron string. Using the rule form means no manual UTC+7 arithmetic anywhere.

```js
const schedule = require("node-schedule");
const { resolveShiftContext, SHIFT_CLOSE_HOURS, TZ } = require("./resolveShiftContext");
const { collectShiftTotals } = require("./collectShiftTotals");
const { persistShiftTotals } = require("./persistShiftTotals");

// Both shifts close at :10 past the hour, ~5 minutes after the PLC latch.
// If machines start getting skipped as offline, the latch is running late —
// raise this to 15 (and see WINDOW_MIN in resolveShiftContext.js).
const JOB_MINUTE = 10;

/**
 * Collect and persist one shift's production totals.
 *
 * Single entry point for both the scheduler and the backfill endpoint, so the
 * two paths cannot drift apart.
 *
 * Errors are caught and logged rather than rethrown: an unhandled rejection
 * inside a node-schedule callback would take down the whole process, which
 * also serves every API route in this backend. Recovery is via backfill, which
 * stays valid for ~24h because the PLC counters are latched.
 */
const runShiftSummary = async (fireTime) => {
  const startedAt = Date.now();

  try {
    const ctx = resolveShiftContext(fireTime);
    const rows = await collectShiftTotals(ctx);
    const written = await persistShiftTotals(ctx, rows);

    console.log(
      `[shiftSummary] ${ctx.shift_date} shift ${ctx.shift}: ${written} machines in ${Date.now() - startedAt}ms`
    );
    return { ok: true, shift_date: ctx.shift_date, shift: ctx.shift, written };
  } catch (error) {
    console.error("[shiftSummary] run failed:", error.message);
    return { ok: false, message: error.message };
  }
};

const registerShiftSummaryJobs = () =>
  SHIFT_CLOSE_HOURS.map((hour) => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = hour;
    rule.minute = JOB_MINUTE;
    rule.tz = TZ;

    // node-schedule passes the SCHEDULED fire time, not Date.now(). That matters:
    // if the event loop is busy the callback may run late, and we want the shift
    // resolved from the intended time, not the delayed one.
    const job = schedule.scheduleJob(`shiftSummary-${hour}`, rule, (fireDate) =>
      runShiftSummary(fireDate)
    );

    if (!job) throw new Error(`registerShiftSummaryJobs: failed to schedule hour ${hour}`);

    console.log(`[shiftSummary] scheduled ${String(hour).padStart(2, "0")}:${JOB_MINUTE} ${TZ}`);
    return job;
  });

module.exports = { runShiftSummary, registerShiftSummaryJobs };
```

**Step 2: Register at startup**

In `local-backend/server.js`, immediately before `app.listen(...)`:

```js
require("./services/shiftSummary/shiftSummaryJob").registerShiftSummaryJobs();
```

**Step 3: Verify the schedule resolves to Bangkok time**

```bash
cd local-backend && node -e "
require('dotenv').config();
const jobs = require('./services/shiftSummary/shiftSummaryJob').registerShiftSummaryJobs();
jobs.forEach(j => console.log(j.name, '->', j.nextInvocation().toString()));
process.exit(0);
"
```

Expected: two future dates at 06:10 and 18:10 **Bangkok time**. If they print as 06:10 UTC, `rule.tz` is not being applied — do not proceed.

**Step 4: Dry run for the most recent past shift**

```bash
cd local-backend && node -e "
require('dotenv').config();
const moment = require('moment-timezone');
const { runShiftSummary } = require('./services/shiftSummary/shiftSummaryJob');
const fire = moment.tz('Asia/Bangkok').hour(18).minute(10).second(0).millisecond(0);
if (fire.isAfter(moment())) fire.subtract(1, 'day');
runShiftSummary(fire).then(r => { console.log(r); process.exit(0); });
"
```

Expected: `{ ok: true, written: <~machine count> }`. Run it a second time and confirm the table row count is unchanged.

---

## Task 8: Backfill endpoint

Recovery path when InfluxDB or MSSQL is down at fire time. Valid for ~24h after a shift because the counters are latched.

**Files:**
- Create: `local-backend/api_nat/shift_production.js`
- Modify: `local-backend/server.js`

**Step 1: Write the route**

```js
const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");
const { runShiftSummary } = require("../services/shiftSummary/shiftSummaryJob");

/**
 * POST /nat/shift-production/backfill?date=2026-08-06&shift=1
 *
 * Re-runs the snapshot for a past shift. Safe to call repeatedly — the
 * underlying MERGE is idempotent.
 *
 * Only valid until the PLC re-latches that field (~24h), after which the
 * source value in InfluxDB has been overwritten and is unrecoverable.
 */
router.post("/backfill", async (req, res) => {
  const { date, shift } = req.query;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !["1", "2"].includes(shift)) {
    return res
      .status(400)
      .json({ success: false, message: "date=YYYY-MM-DD and shift=1|2 are required" });
  }

  // Reconstruct the fire time this shift would have had:
  //   shift 1 closes at 18:10 on shift_date; shift 2 closes at 06:10 the NEXT day.
  const fire =
    shift === "1"
      ? moment.tz(`${date} 18:10:00`, "Asia/Bangkok")
      : moment.tz(`${date} 06:10:00`, "Asia/Bangkok").add(1, "day");

  const result = await runShiftSummary(fire);
  res.status(result.ok ? 200 : 500).json(result);
});

module.exports = router;
```

**Step 2: Mount it**

In `local-backend/server.js`, beside the other `/nat/...` routes:

```js
app.use("/nat/shift-production", require("./api_nat/shift_production"));
```

**Step 3: Verify**

```bash
curl -X POST "http://localhost:$PORT/nat/shift-production/backfill?date=2026-08-05&shift=1"
```

Expected: `{"ok":true,...}`. Then confirm a bad request is rejected:

```bash
curl -X POST "http://localhost:$PORT/nat/shift-production/backfill?date=nope&shift=9"
```

Expected: HTTP 400.

---

## Task 9: End-to-end verification

**Step 1: Trigger a run two minutes out**

Do not wait 12 hours for the real fire time. In a scratch script (not committed), schedule against the real code path:

```bash
cd local-backend && node -e "
require('dotenv').config();
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const { runShiftSummary } = require('./services/shiftSummary/shiftSummaryJob');
const at = new Date(Date.now() + 120000);
// Still pass a real shift-close time as the fire time — only the trigger is fake.
const fire = moment.tz('Asia/Bangkok').hour(18).minute(10).second(0).millisecond(0);
if (fire.isAfter(moment())) fire.subtract(1, 'day');
schedule.scheduleJob(at, () => runShiftSummary(fire).then(r => { console.log(r); process.exit(0); }));
console.log('firing at', at.toString());
"
```

**Step 2: Confirm the data landed**

```sql
SELECT TOP 10 * FROM [db].[schema].[table]
ORDER BY [shift_date] DESC, [shift] DESC, [process], [mc_no];

SELECT [shift_date], [shift], COUNT(*) AS machines,
       SUM([ok_qty]) AS ok_total, SUM([ng_qty]) AS ng_total
FROM [db].[schema].[table]
GROUP BY [shift_date], [shift]
ORDER BY [shift_date] DESC;
```

**Step 3: Sanity-check the machine count**

Compare `machines` against the expected machine population. A materially lower number means the read window is missing the latch — raise `JOB_MINUTE` to 15 rather than widening `WINDOW_MIN`.

**Step 4: Confirm the first real fire**

After the next genuine 06:10 or 18:10, check the log line `[shiftSummary] <date> shift <n>: <count> machines in <ms>ms` and re-run the count query.

---

## Known risks

- **Latch timing is assumed, not measured.** The `18:05` latch is from the user's description. Task 9 Step 3 is what actually validates it.
- **`LAST()` is evaluated per field.** In principle `LAST(ok)` and `LAST(ng)` could come from different points. In practice both are written in the same MQTT message, so they move together. Not worth defending against unless the data disproves it.
- **Multiple app instances would each schedule the job.** Harmless today because the MERGE is idempotent — but if this backend is ever scaled horizontally, the redundant InfluxDB queries are waste worth eliminating.
- **A machine offline across the whole window is silently absent**, by design. There is currently no alert on "expected 1000, got 940" — worth adding once the normal machine count is known.
- **`VARCHAR(10)` on `process` / `mc_no` is unvalidated** against live topic data. Too narrow means a hard insert failure, not corruption, so it will be obvious — but confirm during Task 4.
