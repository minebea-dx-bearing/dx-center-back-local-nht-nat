# Realtime API Developer Guide

This guide is the contract for every realtime machine-dashboard endpoint in this repo (`local-backend/api_nht/*_realtime.js`, `local-backend/api_nat/*_realtime.js`). The architecture is shared and load-bearing — every new endpoint **must** follow the same pattern or it will silently break MQTT connection counts, SQL caches, and dashboard summary aggregations that other endpoints depend on.

Read sections **1 → 2 → 3** before writing any code. Then jump into Section 4 (pick or create a store) and Section 5 (pick a route pattern).

---

## 1. High-Level Architecture

Three layers, top → bottom:

1. **Realtime Route** ([local-backend/api_nat/assy_alu_realtime.js](../local-backend/api_nat/assy_alu_realtime.js) and friends) — Express router. Owns *formula logic* only (OEE, performance, target_pd, etc.). Reads from a store; never talks to MQTT or SQL directly.
2. **Process Store** ([local-backend/api_nat/_store_assy.js](../local-backend/api_nat/_store_assy.js) and friends) — Singleton per process family. Owns SQL master data (refreshed every 5 min) + live MQTT updates (merged instantly) + running-time cache (TTL 20s, busts on shift rollover).
3. **Shared utilities** ([local-backend/util/](../local-backend/util/)) — `processStore`, `mqttHub`, `runningTimeCache`, `buildRunningTimeSql`, `realtimeMachinesRoute`, `shiftWindow`, `determineMachineStatus`, `mqtt_master_mc_no`.

```
GET /machines  ──►  *_realtime.js (formulas)
                          │
                          ▼
                    _store_*.js  ──►  master (SQL, 5 min)
                          │            live    (MQTT, real-time)
                          │            running time (SQL, 20 s TTL)
                          ▼
                    util/ (shared infra — do not duplicate)
```

**The rule that protects this system:** every route for a given process family points to the **same** store singleton. If you `mqtt.connect(...)` in a route file, or call `dbms.query(...)` directly inside `prepareRealtimeData`, you have broken the pattern.

---

## 2. Before You Write Code — Objective Checklist

Fill this out **first**. Most of the answers come from your domain ticket, not the code.

| # | Question | Resolves to |
| --- | --- | --- |
| 1 | Plant: **NHT** or **NAT**? | Which `api_*` directory, which `instance/ms_instance_*` |
| 2 | Process code (e.g. `ALU`, `AOD`, `ARP`, `AVS`, `FIM`, `GSSM`, `MBR`, `MBR_F`, `ANT`, `GD`, `2GD`, `TN`, or NEW) | Which store family (Section 4) |
| 3 | MQTT broker (env-var name only — never an IP) | Section 3.1 |
| 4 | DB tables (PROD / ALARM / MASTER) | Section 3.2 |
| 5 | Which alarms count as "running"? RUN-only, or RUN + PLAN STOP + SETUP, or dual-spindle RUN FRONT/REAR? | Section 3.3 — `mode` |
| 6 | Spindle layout: **single**, **dual (f+s)**, **f-only**, or **s-only**? | Picks `summary` in Section 3.4 |
| 7 | Shift start time: **06:00 / 07:00 / 05:30 / other**? | `startHour`, optionally `startMinute` |
| 8 | Filter machines from a larger store? (e.g. only `IR*` ending in `B`) | Use `getSnapshot(filterFn)` — Section 5.3 |
| 9 | Need a non-standard summary aggregation (average instead of sum)? | Escape hatch R5 — Section 5.5 |
| 10 | **Does a store already exist for this broker + process?** | Reuse it. Only create a new store if no existing family fits. |

> ⚠ **Question 10 is the most common mistake.** Six of the 2GD routes share **one** store ([_store_2gd.js](../local-backend/api_nat/_store_2gd.js)). Eight of the NAT ASSY routes share **one** store ([_store_assy.js](../local-backend/api_nat/_store_assy.js)). If you spin up a new store for a process that already has one, you will run a duplicate MQTT client and a duplicate SQL polling loop, and your numbers will *almost* match — until they don't.

---

## 3. Reference Tables

### 3.1 MQTT broker → env var

| Plant | Broker name | Env var |
| --- | --- | --- |
| NHT | ASSY front | `NHT_MQTT_ASSY_FRONT` |
| NHT | MC shop | `NHT_MQTT_MC_SHOP` |
| NAT | ASSY | `NAT_MQTT_ASSY` |
| NAT | MC shop | `NAT_MQTT_MC_SHOP` |

Port is always `process.env.MQTT_PORT`. **Never hardcode a broker IP.** Use `getHub(\`mqtt://${process.env.<NAME>}:${process.env.MQTT_PORT}\`)`.

### 3.2 Process → DB stem (canonical mapping)

| Plant | Process | DB stem | Master loader |
| --- | --- | --- | --- |
| NAT | ALU / AOD / ARP / AVS / FIM / GSSM / MBR / MBR_F | `nat_mc_assy_<process>` | `master_mc_no` |
| NAT | ANT | `nat_mc_assy_ant_new` (note `_new`) | `master_mc_no_front_rear` |
| NAT | 2GD | `nat_mc_mcshop_2gd` | `master_mc_no` |
| NAT | TN | `nat_mc_mcshop_tn` | `master_mc_no` |
| NHT | ALU / AOD / AVS / FIM / GSSM / MBR_F | `data_machine_<process>` | `master_mc_no` |
| NHT | ANT | `data_machine_an2` | `master_mc_no_front_rear` |
| NHT | GD | `data_machine_gd2` | `master_mc_no` |
| NHT | MBR | `data_machine_assy1` (uses `DATA_*_ASSY` tables — historical, **see Section 4.6**) | `master_mc_no` |

Tables follow `DATA_PRODUCTION_<PROCESS>`, `DATA_ALARMLIS_<PROCESS>`, `DATA_MASTER_<PROCESS>` — with one exception: **NHT GSSM and NHT MBR_F use `DATA_ALARMLIST_<PROCESS>`** (extra `T`). The NHT factory handles this via `opts.alarmTableSuffix: "DATA_ALARMLIST"` — pass it when calling `getStore()`. NAT uses `DATA_ALARMLIS` uniformly.

### 3.3 Alarm semantics → `mode` (passed to [buildRunningTimeSql](../local-backend/util/buildRunningTimeSql.js))

| `mode` | What counts as "running" | Returns | Used by |
| --- | --- | --- | --- |
| `"withPlanStop"` | RUN + PLAN STOP + SETUP | `sum_duration`, `sum_planshutdown_duration`, `total_time` | Most ASSY, GD, 2GD (4 of 5 variants) |
| `"withPlanStopAnt"` | RUN FRONT, RUN REAR, PLAN STOP, SETUP, grouped by `alarm_base` | adds `alarm_base` column | ANT (NHT + NAT) |
| `"runOnly"` | RUN only — no plan-shutdown column | `sum_duration`, `total_time` | TN, 2GD OutSuper |

> ⚠ **If your alarm semantics don't fit any mode, ADD A NEW MODE — do not edit `ALARM_FILTERS` or `FINAL_SELECTS` for an existing mode.** Editing existing modes silently changes every store that uses them. See Section 6.

### 3.4 `summary` type → fields summed/averaged in [makeMachinesHandler](../local-backend/util/realtimeMachinesRoute.js)

| `summary` | `target` | `ok` | `cycle_t` | `utl` |
| --- | --- | --- | --- | --- |
| `"standard"` | `target_pd` | `act_pd` | `act_ct` | `curr_utl` |
| `"fSpindle"` | `f_target_pd` | `s_act_pd` | `s_act_ct` | `s_curr_utl` |
| `"sSpindle"` | `s_target_pd` | `s_act_pd` | `s_act_ct` | `s_curr_utl` |
| omit | (no `resultSummary` in response) | — | — | — |

Output keys are always `sum_target`, `sum_daily_ok`, `avg_cycle_t`, `avg_utl`.

> ⚠ **If you need a different aggregation shape (e.g. `avg_opn` like AOD), DO NOT add a new `summary` key.** Use the manual handler escape hatch (Section 5.5).

---

## 4. Step 1 — Pick (or Create) the Store

### Decision flow

```
Is there already a *_store_*.js for your broker + DB stem?
  yes ──► reuse it. Skip to Section 5.
  no
   │
   ├─ Single spindle, 06:00 shift, withPlanStop, ASSY-style DB?
   │    └─► Family A — copy [_store_assy.js](../local-backend/api_nat/_store_assy.js)
   │
   ├─ Dual spindle (front/rear), RUN FRONT/RUN REAR grouping?
   │    └─► Family B — copy [_store_ant.js](../local-backend/api_nat/_store_ant.js)
   │
   ├─ Standalone process, MC_SHOP broker, 07:00 shift, single mode?
   │    └─► Family C — copy [_store_gd.js](../local-backend/api_nht/_store_gd.js)
   │
   ├─ Shift starts on a non-hour boundary (HH:MM, MM ≠ 00)?
   │  …or alarm semantics are RUN-only?
   │    └─► Family D — copy [_store_tn.js](../local-backend/api_nat/_store_tn.js)
   │
   └─ One store will serve many routes, each needing a different running-time mode?
        └─► Family E — copy [_store_2gd.js](../local-backend/api_nat/_store_2gd.js)
```

> ⚠ **Family A is a factory** — `getStore(processName)` returns a memoized per-process instance. Families B–E are plain singletons (one file = one store). Use the factory when you expect 4+ similar processes; use a singleton for one-off processes.

---

### 4.1 Family A — Standard ASSY (factory, single spindle)
**When to use:** 06:00 shift, single spindle, `withPlanStop` semantics, per-process DB prefix (`<plant_db_prefix>_<process>`).
**Members:** NAT — ALU, AOD, ARP, AVS, FIM, GSSM, MBR, MBR_F. NHT — ALU, AOD, AVS, FIM, GSSM, MBR_F.
**Canonical file:** [local-backend/api_nat/_store_assy.js](../local-backend/api_nat/_store_assy.js)

**Skeleton (factory pattern):**
```js
const moment = require("moment");
const dbms = require("../instance/ms_instance_nat"); // or ms_instance_nht
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const startHour = 6;
const stores = new Map();

const buildStore = (processName) => {
  const DATABASE_PROD   = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_PRODUCTION_${processName.toUpperCase()}]`;
  const DATABASE_ALARM  = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_ALARMLIS_${processName.toUpperCase()}]`;
  const DATABASE_MASTER = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_MASTER_${processName.toUpperCase()}]`;

  const hub = getHub(`mqtt://${process.env.NAT_MQTT_ASSY}:${process.env.MQTT_PORT}`);

  const store = createProcessStore({
    processName, startHour, hub,
    masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
  });

  const runningTimeCache = createRunningTimeCache({
    ttlMs: 20_000,
    keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
    loader: async () => {
      const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStop" });
      const result = await dbms.query(sql);
      return result[1] > 0 ? result[0] : [];
    },
  });

  return {
    getSnapshot: store.getSnapshot,
    getRawMap: store.getRawMap,
    getRunningTime: () => runningTimeCache.get(),
  };
};

const getStore = (processName) => {
  if (!stores.has(processName)) stores.set(processName, buildStore(processName));
  return stores.get(processName);
};

module.exports = { getStore };
```

**Gotchas:**
- **NHT only — GSSM and MBR_F use `DATA_ALARMLIST` (extra T).** Call `getStore("GSSM", { alarmTableSuffix: "DATA_ALARMLIST" })`. NAT always uses `DATA_ALARMLIS`.
- If a new ASSY process needs a different broker or different mode, **add a new family, do not branch this factory**.

---

### 4.2 Family B — Dual-spindle ANT
**When to use:** Front + rear spindles with separate alarm streams (`alarm_front`, `alarm_rear`).
**Canonical file:** [local-backend/api_nat/_store_ant.js](../local-backend/api_nat/_store_ant.js)

**What's different from Family A:**
- `masterLoader: () => master_mc_no_front_rear(dbms, ...)` — produces `alarm_front`/`alarm_rear`/`occurred_front`/`occurred_rear`.
- `mode: "withPlanStopAnt"` — running-time rows include `alarm_base` so consumers can filter `"RUN FRONT"` vs `"RUN REAR"`.
- NAT ANT uses the `_new` DB suffix (`nat_mc_assy_ant_new`); NHT ANT uses `data_machine_an2`.

**Gotcha:** the consumer (Section 5.2) **must** filter `runningTimeData.find(rt => rt.mc_no === item.mc_no && rt.alarm_base === "RUN FRONT")` per spindle. The store does not pre-split.

---

### 4.3 Family C — MC_SHOP standalone (single mode, 07:00)
**When to use:** Single process, single mode, MC_SHOP broker, 07:00 shift, hardcoded DB stem (no per-process suffix templating).
**Canonical file:** [local-backend/api_nht/_store_gd.js](../local-backend/api_nht/_store_gd.js)

**What's different from Family A:** plain singleton (no factory), `startHour = 7`, `NHT_MQTT_MC_SHOP` broker, hardcoded DB stem.

---

### 4.4 Family D — Off-hour shift + runOnly (TN)
**When to use:** Shift starts on a non-hour boundary (e.g. 05:30), and/or alarm semantics don't include PLAN STOP / SETUP.
**Canonical file:** [local-backend/api_nat/_store_tn.js](../local-backend/api_nat/_store_tn.js)

**What's different from Family C:**
- `const startMinute = 30;` declared at module scope.
- Pass `startMinute` into `buildRunningTimeSql`. The shift-day key (`shiftStartDate`) still uses `startHour` because rollover happens once per day.
- `mode: "runOnly"` — running-time rows have **no** `sum_planshutdown_duration`. Consumer must default to 0 when computing effective time.

**Gotcha:** the realtime route (Section 5.4) must call `shiftWindow(now, startHour, startMinute)` — the third argument is easy to forget.

---

### 4.5 Family E — Multi-loader (one store, many routes, different modes)
**When to use:** Several routes share the same master data + broker, but need different running-time semantics (e.g. 2GD InBore wants `withPlanStop` while 2GD OutSuper wants `runOnly`).
**Canonical file:** [local-backend/api_nat/_store_2gd.js](../local-backend/api_nat/_store_2gd.js)

**What's different from Family C:** the store exports **two** running-time getters:
```js
module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTimeWithPlanStop: () => runningTimeWithPlanStop.get(),
  getRunningTimeRunOnly: () => runningTimeRunOnly.get(),
};
```
Each route picks the one it needs. Each cache key embeds the mode (`...-withPS` vs `...-runOnly`) so they don't collide.

**Gotcha:** when adding a third mode (e.g. a future RUN-only variant for a different sub-process), add a third named getter — do **not** parameterize the existing ones.

---

### 4.6 Legacy stores — DO NOT REPLICATE

| File | Why it exists | Don't do this in new code |
| --- | --- | --- |
| [local-backend/api_nht/_store_mbr.js](../local-backend/api_nht/_store_mbr.js) | DB is `data_machine_assy1` but `dbProcess = "ASSY"` so tables resolve to `DATA_*_ASSY`. Historical: the old pre-refactor route had a local `const process = "ASSY"` that shadowed Node's global, blocking env access. | New MBR-like store → use Family A naming, declare your real process name in the DB. |
| NHT vs NAT `MBR_F` differences | The two plants store MBR_F production with different column shapes (NHT uses `a_ng + b_ng_pos + ...`; NAT uses simpler totals). | Don't try to unify the two routes — they are intentionally separate. |

If you see these patterns elsewhere in the codebase, treat them as the **exception, not the template**.

---

### 4.7 keyFn convention — what to write when creating a new store

`keyFn` is the cache-bust signal inside `createRunningTimeCache`. It is **not** a globally shared registry — each cache instance is an isolated closure, so key collisions between stores are structurally impossible. The only job of `keyFn` is: return the same string throughout a shift, and a different string after the shift rolls over.

**Convention — always prefix with your plant name:**

```js
// NAT
keyFn: () => `NAT-${processName}-${shiftStartDate(moment(), startHour)}`,
// → "NAT-ALU-2025-05-12"

// NHT
keyFn: () => `NHT-${processName}-${shiftStartDate(moment(), startHour)}`,
// → "NHT-GD-2025-05-12"

// Family E: one store, multiple caches — append a short mode tag so debug logs are distinct
// NAT-2GD helper: const shiftDateKey = () => `NAT-${processName}-${shiftStartDate(moment(), startHour)}`;
keyFn: () => `${shiftDateKey()}-withPS`,   // → "NAT-2GD-2025-05-12-withPS"
keyFn: () => `${shiftDateKey()}-runOnly`,  // → "NAT-2GD-2025-05-12-runOnly"
```

**Known edge case — Family D (startMinute ≠ 0):** `shiftStartDate` only accepts `startHour`. For TN's 05:30 shift, the cache key rolls at 05:00 — 30 minutes before the actual SQL anchor. During that 30-minute window, the SQL `@start_date` is still in the future so `sum_duration` returns 0 regardless. The imprecision is benign and matches current TN behaviour. If a future process has a large `startMinute` and the gap matters, write a custom keyFn:

```js
// Precise HH:MM rollover — only needed when the startMinute gap would show on the dashboard
keyFn: () => {
  const now = moment();
  const todayAnchor = moment().startOf("day").hour(startHour).minute(startMinute);
  const anchor = now.isBefore(todayAnchor) ? moment(todayAnchor).subtract(1, "day") : todayAnchor;
  return `NAT-${processName}-${anchor.format("YYYY-MM-DD-HHmm")}`  // or NHT-;
},
```

---

## 5. Step 2 — Pick the Realtime Route Pattern

Every realtime file follows this structure:

```js
const express = require("express");
const router = express.Router();
const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_<family>");

const startTime = 6;

const prepareRealtimeData = (machines, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);
  return Object.values(machines).map((item) => {
    const status_alarm = determineMachineStatus(item, item.alarm, item.occurred);
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    // ... your formulas ...
    return { ...item, status_alarm, /* your fields */ };
  });
};

router.get("/machines", makeMachinesHandler({
  getMachines: () => store.getRawMap(),
  getRunningTime: store.getRunningTime,
  prepareRealtimeData,
  summary: "standard",
}));

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
```

> The `module.exports` shape (`router`, `prepareRealtimeData`, `queryCurrentRunningTime`, `getMachineData`) is **consumed by `*_combine_realtime.js` aggregators**. Don't trim it even if your own route doesn't use them.

Now pick the pattern that matches your objective.

### 5.1 R1 — Standard single spindle
**Canonical:** [local-backend/api_nat/assy_alu_realtime.js](../local-backend/api_nat/assy_alu_realtime.js)
- `summary: "standard"`, `getMachines: () => store.getRawMap()`.
- Standard OEE: target → target_pd → diff_pd → curr_yield → availability → performance → oee.

### 5.2 R2 — Dual spindle
**Canonical:** [local-backend/api_nat/assy_ant_realtime.js](../local-backend/api_nat/assy_ant_realtime.js)
- `summary: "fSpindle"` (or `"sSpindle"` for single-prefix MBR variants).
- Two `determineMachineStatus` calls (one per spindle: front uses `alarm_front`/`occurred_front`, rear uses `alarm_rear`/`occurred_rear`).
- Two `runInfo.find(...)` lookups, filtered by `alarm_base === "RUN FRONT"` / `"RUN REAR"`.
- Output fields prefixed `f_` (rear) and `s_` (front) — yes, the prefixes are inverted from intuition; check the canonical file before assuming.

### 5.3 R3 — Filtered subset
**Canonical:** [local-backend/api_nat/gd_2ndInBore_realtime.js](../local-backend/api_nat/gd_2ndInBore_realtime.js)
- Define a pure filter: `const isInBoreMachine = (mc_no) => /* boolean */;`
- Pass it to `store.getSnapshot(filterFn)` — the store applies the filter **before** merging, so it's cheap.
- Add a `subProcess` field to the output if the dashboard needs to distinguish slices (e.g. `"GD-IB"` vs `"GD-OR"`).

### 5.4 R4 — Off-hour shift
**Canonical:** [local-backend/api_nat/tn_tn_realtime.js](../local-backend/api_nat/tn_tn_realtime.js)
- `shiftWindow(now, startTime, 30)` — the third arg is the minute offset.
- Default `plan_shutdown` to `0` when using `mode: "runOnly"` (the column doesn't exist on those rows).

### 5.5 R5 — Manual handler (escape hatch for non-standard summary)
**Canonical:** [local-backend/api_nat/assy_aod_realtime.js](../local-backend/api_nat/assy_aod_realtime.js)
**When to use:** the summary you need is not `sum_target / sum_daily_ok / avg_cycle_t / avg_utl`. AOD needs `avg_opn`.

> ⚠ **Rules for escape-hatch routes — these are non-negotiable:**
> 1. **Reuse an existing store.** Never instantiate a second MQTT hub or SQL cache.
> 2. **Use `shiftWindow()` for time math.** Never compute shift offsets inline.
> 3. **Use `determineMachineStatus()` for status.** Never inline the alarm-priority logic.
> 4. **Document at the top of the file *why* you're escaping `makeMachinesHandler`.** A one-line comment is enough; the next dev needs to know whether to copy this file.

### 5.6 R6 — Aggregator / combine route
**Canonical:** [local-backend/api_nat/assy_combine_realtime.js](../local-backend/api_nat/assy_combine_realtime.js)
**When to use:** dashboard needs a roll-up across multiple processes (e.g. all ASSY lines on one card).

> ⚠ **Same rules as R5, plus:** read from each process's existing route via `require("./assy_alu_realtime").getMachineData()` etc. — do **not** instantiate any store directly. This keeps the dependency direction unidirectional (combine depends on routes, never the other way around).

---

## 6. Customization Rules & Warnings

Every warning follows the same shape — what you want, what to do, and why.

### 6.1 Adding a new alarm mode (e.g. "MANDATORY CLEANING")
**Want:** count a new alarm type as running.
**Do:** open [local-backend/util/buildRunningTimeSql.js](../local-backend/util/buildRunningTimeSql.js), add a new key to `ALARM_FILTERS` (the SQL `WHERE` filter) **and** to `FINAL_SELECTS` (the grouped output shape). Then reference your new `mode` from your store.
**⚠ Do NOT edit existing modes.** `withPlanStop` is used by ~14 stores and `withPlanStopAnt` by 2; mutating their filter or grouping will silently shift running-time numbers everywhere.

### 6.2 Adding a new summary aggregation type
**Want:** a new aggregation shape across machines.
**Do:** add a new key to `SUMMARY_FIELDS` in [local-backend/util/realtimeMachinesRoute.js](../local-backend/util/realtimeMachinesRoute.js) (only if the **field-name mapping** differs — same shape, different field names). For a different *aggregation* (avg vs sum, new fields), use the manual-handler escape hatch (R5) instead.
**⚠ Do NOT rename existing `SUMMARY_FIELDS` keys.** Every route declaring `summary: "standard"` references them.

### 6.3 Adding a new MQTT broker
**Want:** point a new process at a new physical broker.
**Do:** add the env var to `.env` and `.env.example`. Pass it to `getHub` exactly like the canonical stores: `getHub(\`mqtt://${process.env.NEW_BROKER}:${process.env.MQTT_PORT}\`)`.
**⚠ Never hardcode an IP literal.** The hub dedupes connections by URL string; a hardcoded IP plus an env-var URL will create two TCP connections to the same broker.

### 6.4 Changing the shift window
**Want:** a different shift start for one process.
**Do:** set `startHour` (and optional `startMinute`) at the top of *your* store and call `shiftWindow(now, startHour, startMinute)` in *your* realtime route.
**⚠ Do NOT edit [shiftWindow.js](../local-backend/util/shiftWindow.js) defaults.** It is pure and parameterized — there is no "default shift" to change.

### 6.5 Tweaking status semantics
**Want:** treat a new MQTT status string as "running" for one process.
**Do:** branch upstream in *your* `prepareRealtimeData` — e.g. compute a custom `status_alarm` before/after the `determineMachineStatus` call.
**⚠ Do NOT edit [determineMachineStatus.js](../local-backend/util/determineMachineStatus.js).** The priority order (connectivity → MQTT `RUN*` → SQL alarm → fallback) is shared across every dashboard. A change there affects offline-detection thresholds, alarm-row resolution, the lot.

### 6.6 Master table look-back
**Want:** include older master data than the default.
**Do:** discuss before touching. The 3-day look-back in [mqtt_master_mc_no.js](../local-backend/util/mqtt_master_mc_no.js) is intentional — it powers the "no recent run" → grey-out behavior across every dashboard.
**⚠ Changing the look-back here changes how every dashboard decides whether a machine is "live".**

### 6.7 Master-reload interval / cache TTL
**Want:** faster updates for one process.
**Do:** pass `reloadIntervalMs` to `createProcessStore` and/or `ttlMs` to `createRunningTimeCache` in *your* store.
**⚠ Do NOT change `DEFAULT_RELOAD_MS` / `DEFAULT_TTL_MS` in [processStore.js](../local-backend/util/processStore.js).** That changes every store at once.

---

## 7. Verification — How to Test a New Endpoint

1. **Boot the backend** and watch for `[mqttHub] connected to mqtt://...` and `[<process>] master reloaded — N machines` log lines for *your* store. If either is missing, your store isn't being constructed.
2. **Hit the endpoint:** `GET /api_<plant>/<your_route>/machines`. Verify:
   - `success: true`
   - `data` is an array of machines with the correct shape
   - `resultSummary` matches the `summary` you chose (or is absent if you omitted it)
3. **Check the JSON shape against a canonical sibling.** If you copied Family A + R1, your output should be field-compatible with [assy_alu_realtime.js](../local-backend/api_nat/assy_alu_realtime.js).
4. **Confirm MQTT updates flow through.** Publish a test message on the broker (or wait for a real one) and confirm the next `GET /machines` reflects it within ~1s.
5. **Confirm SQL refresh.** Temporarily set `reloadIntervalMs: 30_000` in your store; wait 30s; confirm the master count log fires again.
6. **Confirm you're sharing the hub.** If you have access to a debug REPL: `require("./util/mqttHub").getHub(yourUrl)._handlerCount()` should equal **previous count + 1** after your store loads. If it's +2, you registered twice.
7. **Compare against the dashboard.** Open the FE dashboard and confirm the numbers match a known-good sibling endpoint.

---

## 8. FAQ

**Q: Should I add a new store or reuse an existing one?**
Reuse if the broker, DB stem, master loader, and shift start are all the same as an existing store. Different shift start *or* different master loader *or* different broker → new store.

**Q: My process needs both `withPlanStop` and `runOnly` running times.**
Family E (`_store_2gd.js`) — expose two named getters from one store.

**Q: Can I add a field to `prepareRealtimeData`'s output?**
Yes, freely. The handler spreads whatever you return into `data[i]`.

**Q: Can I add a new query parameter to `/machines`?**
Yes, but write a manual handler (R5). `makeMachinesHandler` doesn't pass `req` into `prepareRealtimeData`.

**Q: My MQTT messages have weird control characters and the JSON parses fail.**
`mqttHub` already strips ASCII / Latin-1 control bytes (`\x00–\x1F`, `\x7F–\x9F`) before parsing. If yours still fails, log the raw payload and discuss before adding more sanitization — that regex is shared.

**Q: Where do I look when a route is slow?**
The route itself is almost never the bottleneck — it's pure JS over an in-memory map. Slow `GET /machines` ≈ slow `getRunningTime()` SQL. Check the `runningTimeCache` TTL and the master DB's index on `[occurred]`.

---

*Last updated alongside the realtime refactor on branch `fix-slow-load-2gd-dashboard`. When you change the contract (new family, new mode, new summary type, new safe-knob) — update this file in the same PR.*
