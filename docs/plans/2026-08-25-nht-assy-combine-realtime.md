# NHT Assy Combine Realtime — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Ship a working NHT Assembly Combine realtime page at `/nht/assy-combine-realtime`, showing MBR → GSSM → FIM → ANT **one row per production line**, driven by the `master_data` line master.

**Architecture:** The BE aggregator (`api_nht/assy_combine_realtime.js`) and the FE page (`nhtNew/assy/NhtMbrCombineRealtime.jsx`) both already existed. Tasks 1–2 were a repair job on `assy_ant_realtime.js` and the ALU fan-out. **Task 2.5 (rev 5) then re-shaped the response entirely** — from `data[TYPE][pair][PROCESS-HALF]` to a flat array of lines — which makes the FE a rewrite rather than a rename pass.

**Revisions:**

- *2026-08-25 (initial)* — ANT threw a `ReferenceError` on every call, 500ing the combine endpoint and blanking the standalone ANT page.
- *2026-08-25 (rev 2)* — ANT was rewritten by hand against the AOD template. The crash and the `f_`/`s_` prefixes are gone, but AOD is the one file in `api_nht` whose field names match neither `SUMMARY_FIELDS` nor `DefaultCard`. Task 1 is rewritten as a remediation; **Task 0 added** to settle ANT's raw column names, which blocks both Task 1 and the spindle-scaling decision.
- *2026-08-25 (rev 3)* — **Task 0 resolved** by the requester: `act_pd = ok1 + ok2`, and NHT runs **one ANT machine per line** (not one per line pair as NAT does), so no machine-splitting is needed. Also corrects a factual error in rev 1–2: `yield_calc_total` is **not** a phantom field — every NAT module returns it. It is simply absent from all NHT modules. Task 4 restated accordingly.
- *2026-08-26 (rev 4)* — **Verified against a live payload** from the requester's private-network test. Three corrections, all narrowing scope:
  - **Task 1 Steps 2 and 3 are closed as no-ops.** They assumed `_store_ant.js` used `mqtt_master_mc_no_front_rear` + running-time mode `withPlanStopAnt`. It does not, and has not for some time — it uses `master_mc_no_status` + `dataType:"status"`, exactly like FIM/GSSM/MBR. There is no per-spindle status and no `alarm_base` to split on. The existing single-status line is already correct.
  - **Spindle scaling resolved as 1.** Measured `curr_utl ≈ 91%` off the live payload. No `SPINDLE_COUNT` constant is introduced.
  - **The reference implementation's `item.cycle_t` was wrong** — the raw column is `item.cycle`. `cycle_t` is the AOD *output* name, not an input.
  - Knock-on: **Task 3 Step 4** can no longer read `status_front` / `status_rear`. Rewritten to gate on `status_alarm`.
- *2026-09-01 (rev 5)* — **Response re-shaped by request.** The pair-line structure is retired. Line membership now comes from `master_data`, not from parsing `mc_no`.
  - **New Task 2.5** (already implemented): `data` is a flat array of 76 lines, each `{ line_id, line_name, machines: { <process>: {...} } }`. No `MA` / `MD`, no `1&2` pairs, no `-FIRST` / `-SECOND` suffixes.
  - **The old grouping was placing MD machines on the wrong lines.** `line_name` and `mc_no` numbering are decoupled — FL-52 holds `MBRMD01` / `WANTMD01` / `FIMMD01`, but `parseInt(mc_no.slice(-2))` filed those under line 1. Old-vs-new differences on the MD side are the fix, not a regression.
  - **Tasks 3, 4 and 5 are superseded by Task 6**, a single FE rewrite. Their individual steps no longer apply against the new payload, but the substance (bare ANT field names, PACKING and TOTAL YIELD tiles, route enablement) carries over.

**Tech Stack:** Express 4 (CommonJS), moment, MQTT-backed process stores; React 19 + Vite + Tailwind, axios, sweetalert2, React Router.

**Plan location note:** `dx-center-front` has no `docs/` directory, so this plan covers both repos and lives in the backend repo.

---

## Ground Truth (verified 2026-08-25)

Read this before touching anything — several of these contradict the obvious assumption.

| Claim | Reality |
|---|---|
| BE combine endpoint needs writing | **Already exists**: [`api_nht/assy_combine_realtime.js`](../../local-backend/api_nht/assy_combine_realtime.js), mounted at `server.js:93`. Rewritten in Task 2.5. |
| FE page needs writing from the NAT template | **Exists but is now wrong**: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx` (630 lines) is built entirely around `data.MA` / `data.MD` and `-FIRST` / `-SECOND`. After rev 5 none of those keys exist. Task 6 rewrites it. |
| ANT's process key is `ANT` | It is **`AN`**. `_store_ant.js:21` sets `dbProcess = "AN"`, and `prepareRealtimeData` returns `process: item.process.toUpperCase()`. After rev 5 the FE reads `line.machines.AN`. |
| ANT's `mc_no` is `ANTMA01` | It is **`WANTMA01`** — leading `W`. Both `master_data.assy_machine` and `[data_machine_an2].[dbo].[DATA_PRODUCTION_AN]` agree (the latter stores it lowercase, `wantma01`; the module uppercases it). A hand-typed sample in rev 4 dropped the `W` and briefly looked like a join mismatch. There is none. |
| NHT response shape matches NAT's | It does **not**, and after rev 5 it matches nothing else either. NHT is now `data: [{ line_id, line_name, machines }]` — a flat array. NAT remains `data[groupKey][lineMaster]`. |
| Line number can be derived from `mc_no` | **No.** `line_name` and `mc_no` numbering are decoupled: FL-52 holds `MBRMD01` / `WANTMD01` / `FIMMD01`. Membership must come from `assy_machine.line_id`. |
| `yield_calc_total` is a real field | **In NAT, yes** — every module returns it (`assy_mbr_realtime.js:101`, `assy_ant_realtime.js:183`, GSSM/FIM/ALU/ARP/AOD/AVS alike), so NAT's TOTAL YIELD tile is correct. **In NHT, no module returns it.** Copying NAT's FE math unchanged yields `0.00`. |
| NHT ANT should mirror NAT's ANT | Only in *output shape*. NAT splits one physical machine into two logical rows, one per spindle (`api_nat/assy_ant_realtime.js:27-43`), because NAT runs one ANT per **line pair**. NHT runs **one ANT per line, single spindle** — no split, no per-spindle status, no per-spindle running time. Same bare field names, ordinary single-machine derivation. |
| ANT's store is dual-spindle | **No.** [`_store_ant.js:33,40`](../../local-backend/api_nht/_store_ant.js) uses `master_mc_no_status` and `buildRunningTimeSql({ mode: "withPlanStop", dataType: "status" })` — identical to every other NHT store. The file's own header comment (lines 4–9) still describes the old `master_mc_no_front_rear` + `withPlanStopAnt` arrangement and is **stale**. Verified against a live payload 2026-08-26: `status: "RUN"` and `occurred` are present; `alarm_front` / `alarm_rear` are not. |
| The route is wired up | Route is **commented out** at `App.jsx:241`. Sidebar (`NhtSidebar.jsx:54`) and home (`NhtHomeNew.jsx:54`, `disabled`) already point at `/nht/assy-combine-realtime`. |

### Field-name contract per process (NHT)

| Process key | Prefix | Status field | Notes |
|---|---|---|---|
| `MBR` | `s_` | `s_status_alarm` | Ball spindle |
| `MBR_F` | `f_` | **none** — commented out at [`assy_mbrf_realtime.js:16,60`](../../local-backend/api_nht/assy_mbrf_realtime.js) | Gauge spindle; card's GAUGE half never colours |
| `GSSM` | `f_` (grease) + `s_` (shield) | `s_status_alarm` | |
| `FIM` | none (bare) | `status_alarm` | Reference shape — matches `standard` summary and `DefaultCard` |
| `AN` | none (bare), but AOD-named today → **`standard`-named after Task 1** | `status_alarm` (already correct) | Single spindle |
| `ALU` | none (bare) | `status_alarm` | Added in Task 2 for PACKING only, no card |

### Line master (`master_data`, verified 2026-09-01)

Source: `assy_machine` ⟕ `assy_machine_group` ⟕ `assy_line`, on `ms_instance_nht`. **76 lines, 376 machines.** Four line shapes:

| Machines | Lines | `mg_code` set |
|---|---|---|
| 6 | 38 (FL-37…FL-74) | ALU, AN, AVS, FIM, GSSM, MBR |
| 5 | 19 (FL-01…FL-32) | ALU, AN, AVS, GSSM, MBR |
| 3 | 17 (FL-17…FL-36) | AN, GSSM, MBR |
| 1 | 2 (Over Line 1, Over Line 2) | AN |

- **FIM exists only on FL-37…FL-74.** Master holds `FIMMD01`–`FIMMD38` and nothing on the MA side.
- **AVS is in master but is never fetched.** The route fans out six processes, not AVS, so it is absent from the payload with no explicit filter — a consequence of the "omit missing keys" rule, not a special case.
- **`MBR_F` is not in master.** It shares `MBRMA01` with MBR (`assy_mbrf_realtime.js:57` strips the `_f`), so `mc_no` cannot distinguish the two. The route keys machines by the live record's `process`, never by `mg_code`.
- **Data defect:** two `AN` rows carry a trailing CRLF (`WANTMD98\r\n`, `WANTMD99\r\n`, both on the Over Lines). The master loader strips `CHAR(13)`/`CHAR(10)` in SQL. Worth cleaning the rows at source.

`DefaultCard` and the `standard` summary both read bare `act_pd / act_ct / diff_pd / diff_ct / curr_yield / curr_utl / target_pd / status_alarm`. **AOD is deliberately not the naming model** — it returns `target_actual / diff_prod / cycle_t / yield_rate`, which matches neither, which is why it has a hand-rolled handler instead of `makeMachinesHandler`. Follow FIM.

---

## Settled decisions

**ANT row derivation — RESOLVED.** NHT runs **one ANT machine per line, single spindle**. NAT runs one per line **pair**, which is why NAT splits each machine into two logical rows (`ANT01` rear + `ANT02` front, [`api_nat/assy_ant_realtime.js:27-43`](../../local-backend/api_nat/assy_ant_realtime.js)). **Do not carry any of NAT's front/rear handling into NHT** — not the row split, not per-spindle status, not per-spindle running time. One row per machine. Both `AN-FIRST` and `AN-SECOND` fill naturally because there are two ANT machines per line pair.

**Production source — RESOLVED.** `act_pd = item.ok1 + item.ok2` (`ok2` reads `0` in practice; the sum is kept as a harmless guard). NG is `item.ag + item.ng + item.mix`. Cycle time is **`item.cycle`**, divided by 100 — confirmed against a live payload (`cycle: 156` → `1.56`). Note `cycle_t` is the AOD *output* name, **not** a raw column; reading `item.cycle_t` yields `undefined`.

**Spindle scaling — RESOLVED as 1 (2026-08-26).** Measured off the live payload: elapsed 06:00→08:43 ≈ 163 min, so `denom_utl = 9780 × 1 / 1.5 = 6520` against `total_pd = 5947` → **`curr_utl ≈ 91.2%`**. Believable band, so `target_ct` is already machine-level and no scaling factor is required. **No `SPINDLE_COUNT` constant is introduced** — a constant hardcoded to 1 is speculative flexibility. The formulas stay exactly as FIM has them:

```js
target     = Math.floor((86400 / target_ct) * (target_utl / 100) * (target_yield / 100) * ring_factor)
denom_utl  = (elapsedSec * ring_factor) / target_ct
```

**Flow-bar status source — RESOLVED (2026-08-26).** Since ANT is single-spindle, the combine page's flow bar gates on `status_alarm === "RUNNING"`. See Task 3 Step 4.

**`sum_planshutdown_duration` — deferred by decision.** Every NHT module reads `runInfo.sum_planshutdown_duration`, but the SQL emits `sum_planstop_duration` ([`buildRunningTimeSql.js:152`](../../local-backend/util/buildRunningTimeSql.js)). So `plan_shutdown` is always `0` fleet-wide, inflating `availability` and `oee`. Confirmed in the live ANT payload. **Out of scope for this plan** — it affects all nine `api_nht` modules and belongs in its own change. Logged under Follow-ups.

---

## Testing note

`local-backend/package.json` declares `"test": "node --test services/**/*.test.js"` — the glob covers `services/` only, and `api_nht/` has no existing test coverage. Per the project convention (add tests only where coverage already exists), this plan uses **manual endpoint verification via curl**, not new unit tests. Each task has an explicit verification step with expected output.

The backend must be running for verification: `cd local-backend && npm start`.

---

## Task 0: Establish ANT's real column names — CLOSED

**Resolved 2026-08-25 by the requester. No work required; kept as a record.**

The original ANT file referenced **two overlapping column sets** — `ok_front / ok_rear / ag_front / ng_front / mixball_front / ag_rear / ng_rear / mixball_rear / cycle_time_front / cycle_time_rear`, *and* `ok1 / ok2 / ag / ng / mix / cycle` — and it was not determinable from code which was authoritative.

**Answers:**

- **Production:** `act_pd = ok1 + ok2`. Authoritative.
- **Machine-to-line ratio:** one ANT machine serves **one line**. NAT's per-spindle row split does not apply to NHT.
- **Status:** `item.status` / `item.occurred` do **not** exist — the master query at [`util/mqtt_master_mc_no_front_rear.js:61-64`](../../local-backend/util/mqtt_master_mc_no_front_rear.js) selects only `alarm_front / occurred_front / alarm_rear / occurred_rear`. Task 1 Step 2 depends on this.

The guiding principle from the requester: **source column names may differ from NAT; the output format must not.**

---

## Task 1: Finish `assy_ant_realtime.js`

**Status: partially done (2026-08-25, by the requester).** The file was rewritten by hand using [`assy_aod_realtime.js`](../../local-backend/api_nht/assy_aod_realtime.js) as the template.

**Landed already:**

- The three `ReferenceError`s are gone (`act_ct` / `diff_ct` / `curr_yield` were used undeclared at old lines 56 and 119–121)
- The swapped `s_diff_pd` / `f_diff_pd` at old lines 66–67 is gone
- `f_`/`s_` prefixes removed
- `summary` switched from `"fSpindle"` to `"standard"`
- A `//TODO` at line 10 marks the file as unfinished — remove it when this task closes

**Still broken.** AOD was the wrong template — it is the one file in `api_nht` whose field names match neither `SUMMARY_FIELDS` nor `DefaultCard`, which is why it carries a hand-rolled route handler instead of `makeMachinesHandler`. **FIM is the correct template.**

**One defect remains (rev 4).** The original three collapsed to one once the store was checked against reality: only the field naming is actually wrong. Steps 2 and 3 are closed as no-ops — see below.

**Files:**

- Modify: `local-backend/api_nht/assy_ant_realtime.js`

### Step 1: Rename the output fields to match `standard`

`summary: "standard"` resolves to `target_pd / act_pd / act_ct / curr_utl / oee` ([`util/realtimeMachinesRoute.js:25`](../../local-backend/util/realtimeMachinesRoute.js)). The current AOD-derived names miss four of the five, so `resultSummary` returns `sum_target: 0`, `avg_cycle_t: 0`, `avg_utl: 0`. `DefaultCard` misses the same fields and renders the CT row, yield bar and utilisation blank.

| Current (AOD) | Required (FIM) |
|---|---|
| `target_actual` | `target_pd` |
| `diff_prod` | `diff_pd` |
| `cycle_t` | `act_ct` |
| `yield_rate` | `curr_yield` |
| *(absent)* | `curr_utl` |
| *(absent)* | `target_utl` |
| *(absent)* | `target_yield` |

The `curr_utl` / `target_utl` / `target_yield` additions are not cosmetic — `curr_utl` is **entirely absent** from the current payload, which is why `avg_utl` reads `0`. Add the calculation, copied verbatim from FIM:

```js
    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) || 0 : 0;
```

### Step 2: Restore per-spindle status — CLOSED, no-op

**Superseded by rev 4. No work required; kept as a record.**

This step assumed `item.status` / `item.occurred` did not exist on ANT, because the master loader was `mqtt_master_mc_no_front_rear` (which selects only `alarm_front / occurred_front / alarm_rear / occurred_rear`).

That is no longer true. [`_store_ant.js:33`](../../local-backend/api_nht/_store_ant.js) uses **`master_mc_no_status`**, which selects `ISNULL(a.[mc_status], 'no data run') AS [status]` and `a.[occurred]` ([`util/mqtt_master_mc_no_status.js:45-46`](../../local-backend/util/mqtt_master_mc_no_status.js)). Confirmed against the live payload: `"status": "RUN"`, `"occurred": "2026-08-26T08:43:40.720Z"`.

**The existing line is already correct — leave it alone:**
```js
const status_alarm = determineMachineStatus(item, item.status, item.occurred, "status");
```

There is no `status_front` / `status_rear` to return, and none is needed: NHT ANT is single-spindle. Task 3 Step 4 is rewritten accordingly.

### Step 3: Split the running-time lookup by spindle — CLOSED, no-op

**Superseded by rev 4. No work required; kept as a record.**

This step assumed ANT's running-time rows were grouped by `alarm_base` into `"RUN FRONT"` / `"RUN REAR"`, per SQL mode `withPlanStopAnt`.

[`_store_ant.js:40`](../../local-backend/api_nht/_store_ant.js) uses `mode: "withPlanStop", dataType: "status"` — the same call every other NHT store makes. On the `dataType === "status"` branch, the final SELECT groups by `mc_no` + `mc_status` and emits no `alarm_base` column at all ([`buildRunningTimeSql.js:148-156`](../../local-backend/util/buildRunningTimeSql.js)). There are no front/rear rows to find.

**The existing bare `.find()` on `mc_no` is correct and matches FIM — leave it alone.**

> Caveat, not fixed here: that `.find()` can match either the `run` row or the `plan stop` row, since both share an `mc_no`. This is identical in FIM, GSSM, MBR and every other NHT module, so ANT is no worse than its peers. It rides along with the `sum_planshutdown_duration` fix under Follow-ups.

### Step 4: Tidy the stale markers

Delete the `//TODO` at line 10. If a `// f_ -> Rear, s_ -> Front` comment is still present, delete that too.

Keep `act_pd = item.ok1 + item.ok2` and `ng_pd = item.ag + item.ng + item.mix` as-is — settled in Task 0. Keep `item.cycle / 100` as the cycle-time source; only its output name changes (to `act_ct`).

### Reference implementation

If a full replacement is preferred over patching, this is the finished shape. **It is FIM with ANT's raw column names substituted** — no ANT-specific machinery, because after rev 4 there is none.

```js
const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const status_alarm = determineMachineStatus(item, item.status, item.occurred, "status");

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const target_ct = item.target_ct || 0;
    const target_utl = item.target_utl || 0;
    const target_yield = item.target_yield || 0;

    const act_pd = item.ok1 + item.ok2 || 0;
    const ng_pd = item.ag + item.ng + item.mix || 0;
    const act_ct = item.cycle / 100 || 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const total_pd = act_pd + ng_pd;
    const diff_pd = act_pd - target_pd;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));

    const curr_yield = Number(((act_pd / total_pd) * 100 || 0).toFixed(2));

    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) || 0 : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const denom_perf = target_ct > 0 && total_time - plan_shutdown > 0 ? (total_time - plan_shutdown) / target_ct : 0;
    const performance = denom_perf > 0 ? Number(((total_pd / denom_perf) * 100).toFixed(2)) || 0 : 0;
    const oee = Number(((performance / 100) * (availability / 100) * (curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      status_alarm,
      target,
      target_pd,
      total_pd,
      act_pd,
      ng_pd,
      diff_pd,
      act_ct,
      target_ct,
      diff_ct,
      curr_yield,
      target_yield,
      curr_utl,
      target_utl,
      sum_run,
      total_time,
      opn,
      downtime_seconds,
      plan_shutdown,
      availability,
      performance,
      oee,
    };
  });
};
```

The `...item` spread is retained deliberately: FIM, GSSM, MBR and MBR_F all do it, and the raw columns it leaks are what made this rev's verification possible. Diverging from the fleet here would be an unrelated change.

Diff against the current file is four renames, three added `const`s, and two added return keys. Nothing else moves.

### Step 5: Verify the endpoint returns real numbers

Run:
```bash
curl -s http://localhost:3001/nht/assy/ant-realtime/machines \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok:',j.success);console.log('sample:',JSON.stringify(j.data[0],null,2).slice(0,600));console.log('summary:',j.resultSummary)})"
```

Expected:

- `ok: true`
- The sample record carries `target_pd`, `act_pd`, `act_ct`, `diff_pd`, `curr_yield`, `curr_utl`, `target_utl`, `status_alarm` — and **no** `target_actual` / `diff_prod` / `cycle_t` / `yield_rate`
- `resultSummary` has non-zero `sum_target`, `sum_daily`, `avg_cycle_t` **and** `avg_utl`

`avg_utl` and `avg_cycle_t` are the tell for Step 1: while the AOD-derived names are in place they read exactly `0`, because `summarize()` looks up keys the payload doesn't have.

**Baseline to diff against.** A live record taken 2026-08-26 08:50, *before* this task:

```
mc_no ANTMA01 | ok1 5892 ok2 0 | ag 55 ng 0 mix 0 | cycle 156
target_special 53000 | target_ct 1.5 | target_utl 85 | target_yield 95 | ring_factor 1
status "RUN" -> status_alarm "RUNNING"
target_actual 6256  diff_prod -364  yield_rate 99.08  cycle_t 1.56   <- AOD names, to be renamed
curr_utl: ABSENT                                                     <- to be added
```

After this task the same machine should read `target_pd 6256`, `diff_pd -364`, `curr_yield 99.08`, `act_ct 1.56`, and a **newly present** `curr_utl` near **91**. The four AOD keys must be gone.

**Spindle scaling is already settled at 1** — see Settled decisions. `curr_utl` near 91% simply reconfirms it. A reading near 200% would contradict the measurement and means something else changed; stop and re-measure rather than adding a factor.

**Status needs no check** — Step 2 is a no-op and `status_alarm` was already correct in the baseline.

### Step 6: Confirm the standalone ANT page now renders

Open `http://localhost:5173/nht/assy-ant-realtime`. Cards should show numbers instead of blanks.

This page was already broken before this plan: [`MasterRtPage.jsx:42`](../../../dx-center-front/src/components/redesign/realtime/MasterRtPage.jsx) has `doubleData = ["MBR", "GSSM"]` — ANT is not in it, so ANT has always been routed to `DefaultCard`, which reads bare fields the BE never sent. Task 1 fixes that as a side effect. Do not add ANT to `doubleData`.

### Step 7: Lint and commit

```bash
cd local-backend && npm run build 2>/dev/null || echo "no build script — skip"
git add local-backend/api_nht/assy_ant_realtime.js
git commit -m "fix(nht): repair ANT realtime and flatten to bare field names"
```

---

## Task 2: Add ALU to the combine payload as the PACKING source

ALU gets no card. It is included solely so the line header can show a packing count, mirroring how NAT reads `ALU-*.act_pd`.

**Files:**
- Modify: `local-backend/api_nht/assy_combine_realtime.js`

### Step 1: Add the import

After line 7 (the ANT import), add:

```js
const { queryCurrentRunningTime: currentALU, getMachineData: machineDataALU, prepareRealtimeData: prepareALU } = require("./assy_alu_realtime");
```

### Step 2: Pass `now` explicitly and add ALU to the fan-out

Replace the body of the handler's data-gathering block (currently lines 11–15) with:

```js
  const now = moment();
  const [runMBRF, runMBR, runGSSM, runFIM, runANT, runALU] = await Promise.all([
    currentMBRF(),
    currentMBR(),
    currentGSSM(),
    currentFIM(),
    currentANT(),
    currentALU(),
  ]);

  const dataMBRF = prepareMBRF(machineDataMBRF(), runMBRF, now);
  const dataMBR = prepareMBR(machineDataMBR(), runMBR, now);
  const dataGSSM = prepareGSSM(machineDataGSSM(), runGSSM, now);
  const dataFIM = prepareFIM(machineDataFIM(), runFIM, now);
  const dataANT = prepareANT(machineDataANT(), runANT, now);
  const dataALU = prepareALU(machineDataALU(), runALU, now);
```

Add `const moment = require("moment");` at the top of the file if not present.

Two things fixed here beyond adding ALU:
- Every `prepareRealtimeData` in `api_nht` takes `(machines, runningTime, now)`, but the combine route was calling with two args. It worked only because `moment(undefined)` happens to mean "now" — so each process silently computed its own shift window at a slightly different instant. Passing one shared `now` makes the snapshot coherent.
- The `await`s were sequential; five round-trips became one `Promise.all`.

### Step 3: Include ALU in the spread

Change the `combinedData` spread (line 18) from:
```js
  const combinedData = [...dataMBR, ...dataMBRF, ...dataGSSM, ...dataFIM, ...dataANT].map((item) => {
```
to:
```js
  const combinedData = [...dataMBR, ...dataMBRF, ...dataGSSM, ...dataFIM, ...dataANT, ...dataALU].map((item) => {
```

### Step 4: Verify ALU lands under the expected keys — SUPERSEDED by Task 2.5

The original check asserted `ALU-FIRST` / `ALU-SECOND` keys under `MA` / `MD`. Those keys no longer exist. Verify ALU via Task 2.5's check instead: `ALU` should appear in `machines` for every line whose master shape includes it (the 5- and 6-machine lines, not the 17 three-machine lines).

### Step 5: Commit

```bash
git add local-backend/api_nht/assy_combine_realtime.js
git commit -m "feat(nht): add ALU to combine payload and share one shift-window instant"
```

---

## Task 2.5: Reshape the combine response to one row per line — DONE

**Implemented 2026-09-01.** Recorded here because it invalidates Tasks 3–5.

Replaces `mc_no` string-parsing with the `master_data` line master. Requested outcome: no pair grouping, no `MA`/`MD` split, one entry per production line, and a line carries only the machines it actually has.

**Files:**

- Add: `local-backend/api_nht/_master_assy_line.js`
- Modify: `local-backend/api_nht/assy_combine_realtime.js`

### Decisions taken

| Question | Decision |
|---|---|
| Container shape | **Array** ordered by `line_id`, so the FE just `.map()`s it |
| Lines with no live data | **Kept**, with `machines: {}` — the line set comes from master so the layout is stable across restarts |
| Machine with no live record | **Key omitted entirely** |
| Over Line 1 / Over Line 2 | **Included** as ordinary lines (they hold real ANT machines) |
| Master caching | 10-minute TTL via the existing `createRunningTimeCache`, joined into the route's `Promise.all` |
| Live machine absent from master | Dropped, but logged once by `warnUnmapped` and re-logged only when the set changes |

### Response shape

```json
{
  "success": true,
  "message": "NHT Assembly Combine Realtime API is working",
  "data": [
    { "line_id": 1,  "line_name": "FL-01", "machines": { "MBR": {…}, "MBR_F": {…}, "GSSM": {…}, "AN": {…}, "ALU": {…} } },
    { "line_id": 2,  "line_name": "FL-02", "machines": {} },
    { "line_id": 17, "line_name": "FL-17", "machines": { "MBR": {…}, "MBR_F": {…}, "GSSM": {…}, "AN": {…} } },
    { "line_id": 52, "line_name": "FL-52", "machines": { "MBR": {…}, "MBR_F": {…}, "GSSM": {…}, "FIM": {…}, "AN": {…}, "ALU": {…} } },
    { "line_id": 76, "line_name": "Over Line 2", "machines": { "AN": {…} } }
  ]
}
```

Each machine value is the unchanged `prepareRealtimeData` record — same fields as before, only the nesting changed.

### Verification

Exercised with the real master and stubbed live modules (no MQTT needed):

```
lines: 76
FL-01        ["ALU","AN","GSSM","MBR","MBR_F"]
FL-17        ["AN","GSSM","MBR","MBR_F"]
FL-52        ["ALU","AN","FIM","GSSM","MBR","MBR_F"]
Over Line 2  ["AN"]        <- CRLF master row joins correctly
FL-02        []            <- no live data, line still present
AVS anywhere? false
FL-52.AN.mc_no = WANTMD01
```

Live check once the backend is up:

```bash
curl -s http://localhost:3001/nht/assy/combine-realtime \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('lines:',j.data.length);for(const l of j.data.slice(0,5))console.log(l.line_name,Object.keys(l.machines).sort().join(' '))})"
```

---

## Tasks 3, 4, 5 — SUPERSEDED by Task 6

Removed in rev 5. They targeted `data[TYPE][pair][PROCESS-HALF]`, which no longer exists. What they were for, and where it now lives:

| Old task | Substance | Now in |
|---|---|---|
| Task 3 | ANT cards read `s_act_pd` etc.; those fields never existed on NHT ANT | Task 6 Step 3 — cards read `line.machines.AN` bare fields |
| Task 3 Step 4 | Flow bar read `s_status_alarm` / `f_status_alarm`, neither of which exists | Task 6 Step 4 — gates on `status_alarm === "RUNNING"` |
| Task 4 | PACKING + TOTAL YIELD header tiles | Task 6 Step 2 — reads `machines.ALU.act_pd` and products `curr_yield` |
| Task 5 | Uncomment route, un-disable home card | Task 6 Step 6 — unchanged in substance |

---

## Task 6: Rewrite the FE page for the flat line array

The page is built around four near-identical blocks (MA/MD × FIRST/SECOND) reading `data[TYPE][pair][PROCESS-HALF]`. The new payload is one entry per line, so those four blocks collapse into a single component mapped over `data`. This is the DRY cleanup the plan previously deferred — it is no longer optional, because the duplication has nothing left to duplicate.

**Files:**

- Modify: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx`
- Modify: `dx-center-front/src/App.jsx`
- Modify: `dx-center-front/src/pages/nhtNew/NhtHomeNew.jsx`

**Layout decision (settled 2026-09-01):** **one flat list**, FL-01 → FL-74 followed by the two Over Lines, in `line_id` order. No MA/MD sections — the distinction is not in the payload and the requester does not want it reintroduced.

### Step 1: Replace the data plumbing

`data` is now an array. The fetch and countdown logic stay; the consumer changes from `data.MA` / `data.MD` object walks to a single `data.map()`. Render order is the array's own order — do not re-sort.

### Step 2: Build `LineRow`

One component per line, receiving `{ line_name, machines }`. It renders:

- the header tiles — `LINE : {line_name}`, `PACKING` from `machines.ALU?.act_pd`, `TOTAL YIELD` from the helper below
- one card per process in fixed display order: `MBR` → `GSSM` → `FIM` → `AN`
- the flow bar between cards

**Cards render only for processes present in `machines`.** A 3-machine line (FL-17…FL-36) has no FIM and no ALU; it must not render an empty FIM card or a `PACKING` of `NaN`. Decide once whether an absent process yields a gap or a greyed placeholder, and apply it consistently — the master shapes table says 17 lines will exercise this.

Total-yield helper, now reading a `machines` object rather than a group:

```js
const YIELD_PROCESSES = ["MBR", "GSSM", "FIM", "AN"];

// Line yield is the product of each present process's yield. Absent or
// zero-yield processes are skipped; if none reported, there is nothing to show.
const lineTotalYield = (machines) => {
  const rates = YIELD_PROCESSES
    .map((p) => machines?.[p])
    .map((row) => row?.s_curr_yield ?? row?.curr_yield)
    .filter((v) => typeof v === "number" && v > 0);

  if (rates.length === 0) return "0.00";
  return (rates.reduce((acc, v) => acc * (v / 100), 1) * 100).toFixed(2);
};
```

`s_curr_yield ?? curr_yield` still covers the mixed prefix convention: MBR and GSSM are `s_`-prefixed, FIM and ANT are bare. See the field-name contract table.

**Why not NAT's version:** NAT multiplies `yield_calc_total`, which no NHT module returns. Copying it unchanged gives `0.00` on every line. Deferred backend alternative is logged under Follow-ups.

### Step 3: Point the ANT card at bare field names

Inside `LineRow`, the ANT card reads `machines.AN` with **bare** names — `act_pd`, `diff_pd`, `act_ct`, `diff_ct`, `target_yield`, `curr_yield`, `status_alarm`. The old page used `s_`-prefixed reads, which the NHT backend has never sent.

Title is `machines.AN?.mc_no` with **no** `(FRONT)` / `(REAR++)` / `(REAR!!)` suffix — NHT ANT is single-spindle and there is one per line, so the front/rear labelling was always a NAT concept.

### Step 4: Flow bar gates on `status_alarm`

```jsx
className={`w-3 h-full ${
  machines.AN?.status_alarm === "RUNNING"
    ? "animated-flow"
    : machines.AN?.status_alarm === undefined
    ? "bg-gray-300"
    : "bg-red-500"
}`}
```

### Step 5: Verify

Reload the page and check:

1. 76 rows, FL-01 first, Over Line 2 last
2. FL-01 shows MBR / GSSM / AN / (no FIM); FL-52 shows all four; FL-17 shows MBR / GSSM / AN
3. `PACKING` is non-zero on lines with an ALU, blank or `—` on the 3-machine lines — **not** `NaN`
4. `TOTAL YIELD` is a plausible percentage, not `0.00` across the board
5. Countdown ticks 30 → 0 and the payload refreshes

If every `TOTAL YIELD` reads `0.00`, the keys in `YIELD_PROCESSES` don't match the payload — remember ANT is `AN`, not `ANT`.

### Step 6: Enable the route and the entry points

`App.jsx:241` — uncomment:

```jsx
<Route path="assy-combine-realtime" element={<NhtMbrCombineRealtime />} />
```

`NhtMbrCombineRealtime` is imported eagerly at `App.jsx:14`. Every other NHT page is `lazy()`-loaded (`App.jsx:67-77`), so convert it: delete the line-14 import and add

```js
const NhtMbrCombineRealtime = lazy(() => import("./pages/nhtNew/assy/NhtMbrCombineRealtime"));
```

`NhtHomeNew.jsx:54` — remove the `disabled` prop. `NhtSidebar.jsx:54` already links correctly.

Then verify end to end: `/nht` → Combine card → page; sidebar → Assy → Combine → same page.

### Step 7: Lint and commit

```bash
cd dx-center-front && npm run lint:fix
git add src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx src/App.jsx src/pages/nhtNew/NhtHomeNew.jsx
git commit -m "feat(nht): rewrite assy combine page for per-line payload and enable the route"
```

## Follow-ups (not in scope — raise separately)

- ~~**`NhtMbrCombineRealtime.jsx` is ~630 lines of four-way duplication.**~~ Promoted into Task 6 by rev 5 — the flat payload leaves nothing to duplicate, so the `LineRow` extraction is now mandatory rather than deferred.
- **`summarize()`'s `avg_oee` is wrong for every plant.** [`util/realtimeMachinesRoute.js:37`](../../local-backend/util/realtimeMachinesRoute.js) multiplies per-machine OEE ratios, so the "average" collapses toward zero as machine count rises. Affects every `/machines` endpoint using `makeMachinesHandler`.
- **`MBR_F` has no status field.** `f_status_alarm` is commented out at [`assy_mbrf_realtime.js:16,60`](../../local-backend/api_nht/assy_mbrf_realtime.js), so the MBR card's GAUGE column can never show a status colour. Uncommenting it needs a check on which raw field carries gauge-spindle status.
- **AOD's field names are a trap.** `target_actual / diff_prod / cycle_t / yield_rate` match neither `DefaultCard` nor any `SUMMARY_FIELDS` entry. The next person who copies AOD as a template inherits a broken card. ANT is the second file to have fallen into this.
- **`plan_shutdown` is always `0` across all of NHT.** Every `api_nht` module reads `runInfo.sum_planshutdown_duration`, but the running-time SQL emits **`sum_planstop_duration`** ([`buildRunningTimeSql.js:152`](../../local-backend/util/buildRunningTimeSql.js)). `availability` and `oee` are therefore overstated everywhere. Nine files, one-word fix each — deferred by decision on 2026-08-26. The same change should address the neighbouring issue that `runningTimeData.find((rt) => rt.mc_no === item.mc_no)` can match the `plan stop` row instead of the `run` row, since `dataType:"status"` emits one row per `mc_status`.
- **`_store_ant.js`'s header comment is stale.** Lines 4–9 describe `master_mc_no_front_rear` and SQL mode `withPlanStopAnt`; the code at lines 33 and 40 uses `master_mc_no_status` and `withPlanStop` / `dataType:"status"`. This comment cost a full round of misdiagnosis in rev 1–3. Delete or correct it.
- **TOTAL YIELD is computed differently per plant.** NAT multiplies the backend's `yield_calc_total`; NHT derives the product from `curr_yield` in the frontend (Task 6 Step 2). Adding `yield_calc_total` to NHT's MBR, GSSM, FIM and ANT modules would let both pages share one implementation — four one-line backend changes, deferred here by decision.
- **`DefaultCard`'s `assyProcess` list is missing `'AN'`.** [`DefaultCard.jsx:44-45`](../../../dx-center-front/src/components/redesign/realtime/DefaultCard.jsx) gates the Yield gauge on `assyProcess.includes(data.process)`. The array contains `'ANT'`, but ANT's `process` value is `"AN"`, so the standalone ANT page returns `target_yield` / `curr_yield` and renders no Yield row. One-word fix, but it touches a component shared by every plant — raised 2026-08-26, not applied.
- **Two `assy_machine` rows have a trailing CRLF.** `WANTMD98\r\n` and `WANTMD99\r\n`, both on the Over Lines. `_master_assy_line.js` strips control characters in SQL so they join correctly, but the rows should be cleaned at source and the import that produced them checked.
- **`createRunningTimeCache` is misnamed.** It is a generic TTL cache with single-flight coalescing; `_master_assy_line.js` now uses it for master data. Either rename it or move it to a neutral module name.
- **The page name no longer fits.** `NhtMbrCombineRealtime` renders MBR, GSSM, FIM and ANT. `NhtAssyCombineRealtime` would match the NAT/MCB naming, but renaming touches `App.jsx` and both entry points — do it as its own change.
