# NHT Assy Combine Realtime — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Ship a working NHT Assembly Combine realtime page at `/nht/assy-combine-realtime`, showing MBR → GSSM → FIM → ANT per line for both MA and MD machine families.

**Architecture:** The BE aggregator (`api_nht/assy_combine_realtime.js`) and the FE page (`nhtNew/assy/NhtMbrCombineRealtime.jsx`) **both already exist** and are already MA/MD-aware with ARP/AOD/AVS/ALU already excluded. This is not a greenfield build — it is a repair-and-finish job, centred on `api_nht/assy_ant_realtime.js`.

**Revisions:**

- *2026-08-25 (initial)* — ANT threw a `ReferenceError` on every call, 500ing the combine endpoint and blanking the standalone ANT page.
- *2026-08-25 (rev 2)* — ANT was rewritten by hand against the AOD template. The crash and the `f_`/`s_` prefixes are gone, but AOD is the one file in `api_nht` whose field names match neither `SUMMARY_FIELDS` nor `DefaultCard`. Task 1 is rewritten as a remediation; **Task 0 added** to settle ANT's raw column names, which blocks both Task 1 and the spindle-scaling decision.
- *2026-08-25 (rev 3)* — **Task 0 resolved** by the requester: `act_pd = ok1 + ok2`, and NHT runs **one ANT machine per line** (not one per line pair as NAT does), so no machine-splitting is needed. Also corrects a factual error in rev 1–2: `yield_calc_total` is **not** a phantom field — every NAT module returns it. It is simply absent from all NHT modules. Task 4 restated accordingly.
- *2026-08-26 (rev 4)* — **Verified against a live payload** from the requester's private-network test. Three corrections, all narrowing scope:
  - **Task 1 Steps 2 and 3 are closed as no-ops.** They assumed `_store_ant.js` used `mqtt_master_mc_no_front_rear` + running-time mode `withPlanStopAnt`. It does not, and has not for some time — it uses `master_mc_no_status` + `dataType:"status"`, exactly like FIM/GSSM/MBR. There is no per-spindle status and no `alarm_base` to split on. The existing single-status line is already correct.
  - **Spindle scaling resolved as 1.** Measured `curr_utl ≈ 91%` off the live payload. No `SPINDLE_COUNT` constant is introduced.
  - **The reference implementation's `item.cycle_t` was wrong** — the raw column is `item.cycle`. `cycle_t` is the AOD *output* name, not an input.
  - Knock-on: **Task 3 Step 4** can no longer read `status_front` / `status_rear`. Rewritten to gate on `status_alarm`.

**Tech Stack:** Express 4 (CommonJS), moment, MQTT-backed process stores; React 19 + Vite + Tailwind, axios, sweetalert2, React Router.

**Plan location note:** `dx-center-front` has no `docs/` directory, so this plan covers both repos and lives in the backend repo.

---

## Ground Truth (verified 2026-08-25)

Read this before touching anything — several of these contradict the obvious assumption.

| Claim | Reality |
|---|---|
| BE combine endpoint needs writing | **Already exists**: [`api_nht/assy_combine_realtime.js`](../../local-backend/api_nht/assy_combine_realtime.js), mounted at `server.js:92`. ARP/AOD/AVS/ALU already absent. |
| FE page needs writing from the NAT template | **Already exists**: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx` (630 lines). Already fetches `/nht/assy/combine-realtime`, already splits `data.MA` / `data.MD` into two stacked sections, already renders MBR/GSSM/FIM/ANT only. |
| ANT's process key is `ANT` | It is **`AN`**. `_store_ant.js:21` sets `dbProcess = "AN"`, and `prepareRealtimeData` returns `process: item.process.toUpperCase()`. The FE correctly reads `data["AN-FIRST"]`. |
| NHT response shape matches NAT's | It does **not**. NAT is `data[groupKey][lineMaster]`; NHT is `data[TYPE][groupKey][lineMaster]` where TYPE ∈ `MA` \| `MD`. The FE already handles this. |
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

### Step 4: Verify ALU lands under the expected keys

Run:
```bash
curl -s http://localhost:3001/nht/assy/combine-realtime \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);for(const t of Object.keys(j.data)){const g=Object.keys(j.data[t])[0];console.log(t,g,Object.keys(j.data[t][g]).sort().join(' '))}})"
```

Expected, for both `MA` and `MD`, keys drawn from:
`ALU-FIRST ALU-SECOND AN-FIRST AN-SECOND FIM-FIRST FIM-SECOND GSSM-FIRST GSSM-SECOND MBR-FIRST MBR-SECOND MBR_F-FIRST MBR_F-SECOND`

**If `ALU-FIRST`/`ALU-SECOND` are missing or land in the wrong line group, stop and report.** The lineMaster rules at `assy_combine_realtime.js:21-51` key off `mc_no.includes("MA")` and `parseInt(mc_no.slice(-2))`; ALU was assumed to follow the same convention but that has not been confirmed against live data. Do not paper over it with an ALU-specific branch without checking with the requester first.

### Step 5: Commit

```bash
git add local-backend/api_nht/assy_combine_realtime.js
git commit -m "feat(nht): add ALU to combine payload and share one shift-window instant"
```

---

## Task 3: Point the ANT cards at the bare field names

The FE page reads ANT through `s_*` (verified 2026-08-26 at lines 212–224, 323–335, 483–495, 594–606). The NHT backend has **never** sent `s_`-prefixed ANT fields, so these cards have always rendered blank — this is not damage introduced by Task 1. Task 1 settles what the real names are; this task points the cards at them.

**Files:**
- Modify: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx`

### Step 1: Update the MA ANT card (around lines 204–226)

In the `CardProcess` for `data["AN-FIRST"]`, rename the seven reads:

| Before | After |
|---|---|
| `s_act_pd` | `act_pd` |
| `s_diff_pd` | `diff_pd` |
| `s_act_ct` | `act_ct` |
| `s_diff_ct` | `diff_ct` |
| `s_target_yield` | `target_yield` |
| `s_curr_yield` | `curr_yield` |
| `s_status_alarm` | `status_alarm` |

Also drop the `(FRONT)` suffix from `title` — NHT ANT is single-spindle, so the front/rear labelling is a NAT concept that never applied here:
```jsx
title={data["AN-FIRST"]?.mc_no || "N/A"}
```

### Step 2: Repeat for `AN-SECOND` (around lines 316–337)

Same seven renames. Drop the `(REAR++)` suffix the same way — `AN-SECOND` is the **second ANT machine of the line pair**, not a rear spindle. (The MD block's copy reads `(REAR!!)`; both are placeholders left over from the NAT template.)

### Step 3: Repeat for the MD section

The MD block (from line ~360) is a near-duplicate of MA. Apply the identical renames to its `AN-FIRST` (lines ~476–495) and `AN-SECOND` (lines ~587–606) cards.

> Four near-identical ANT card blocks is the DRY smell flagged at the end of this plan. Do **not** refactor it as part of this task — get the page working first, then see Follow-ups.

### Step 4: Fix the flow-bar spindle check

At `NhtMbrCombineRealtime.jsx:340-352` the bar reads `s_status_alarm` and `f_status_alarm` off `AN-FIRST`. Neither ever existed on ANT — both were always `undefined`, so the bar could never be green.

**Rewritten in rev 4.** The original version of this step replaced them with `status_front` / `status_rear`. Those fields do not exist either, and Task 1 no longer creates them — NHT ANT is single-spindle. Gate on the one real field:

```jsx
                  className={`w-3 h-full ${
                    data["AN-FIRST"]?.status_alarm === "RUNNING"
                      ? "animated-flow"
                      : data["AN-FIRST"]?.status_alarm === undefined
                      ? "bg-gray-300"
                      : "bg-red-500"
                  }`}
```

Apply to the MD section's equivalent block too.

### Step 5: Verify

Reload `/nht/assy-combine-realtime` (the route is still commented out — temporarily uncomment `App.jsx:241` to check, or wait for Task 5). ANT cards show numbers; the flow bar animates when both spindles run.

### Step 6: Lint and commit

```bash
cd dx-center-front && npm run lint:fix
git add src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx
git commit -m "fix(nht): read ANT combine cards from bare field names"
```

---

## Task 4: Add PACKING and TOTAL YIELD tiles to the line header

The line header currently renders only `LINE : n` (`NhtMbrCombineRealtime.jsx:100-113` and its three siblings). NAT shows LINE / PACKING / TOTAL YIELD.

**Files:**
- Modify: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx`

### Step 1: Add a shared total-yield helper

Above the component's `return`, add:

```js
const YIELD_PROCESSES = ["MBR", "GSSM", "FIM", "AN"];

// Line yield is the product of each process's yield. Processes with no data
// contribute 1 (neutral); if none reported, the line has no yield to show.
const lineTotalYield = (group, half) => {
  const rates = YIELD_PROCESSES.map((p) => group?.[`${p}-${half}`]).map((row) => row?.s_curr_yield ?? row?.curr_yield).filter((v) => typeof v === "number" && v > 0);

  if (rates.length === 0) return "0.00";
  return (rates.reduce((acc, v) => acc * (v / 100), 1) * 100).toFixed(2);
};
```

**Why not copy NAT's version.** NAT's page multiplies `yield_calc_total` (`NatAssyCombineRealtime.jsx:62-84`), which is a genuine field — every NAT module returns it (`api_nat/assy_mbr_realtime.js:101`, `assy_ant_realtime.js:183`, and so on). **No NHT module returns it.** Copying NAT's math unchanged gives `0.00` on every line.

Per the requester's decision, NHT derives the tile from `curr_yield` in the frontend rather than adding `yield_calc_total` to the four NHT backend modules. `s_curr_yield ?? curr_yield` covers the mixed prefix convention documented in Ground Truth (MBR and GSSM are `s_`-prefixed; FIM and ANT are bare).

Consequence to accept: the two plants now compute the same tile by different routes, so a future change to yield semantics must be made twice. Logged under Follow-ups.

### Step 2: Extract the header tile into a local component

Replace the inline header markup with a reusable helper, defined next to `lineTotalYield`:

```jsx
const LineHeader = ({ lineNo, packing, totalYield }) => (
  <div className="flex gap-[0.83vw] mb-2">
    <div className="w-[8.33vw] h-[4.0vw] font-semibold text-slate-700 rounded-xl border bg-white shadow-md flex flex-col justify-center items-center">
      <div className="text-[clamp(1rem,1.25vw,1.5rem)]">LINE : {lineNo}</div>
    </div>
    <div className="w-[9vw] h-[4.0vw] font-semibold text-slate-700 rounded-xl border bg-white shadow-md flex flex-col justify-center items-center">
      <div className="text-[clamp(0.8rem,0.94vw,1.125rem)]">PACKING</div>
      <div className="text-[clamp(0.875rem,1.04vw,1.25rem)]">{packing}</div>
    </div>
    <div className="w-[9vw] h-[4.0vw] font-semibold text-slate-700 rounded-xl border bg-white shadow-md flex flex-col justify-center items-center">
      <div className="text-[clamp(0.8rem,0.94vw,1.125rem)]">TOTAL YIELD</div>
      <div className="text-[clamp(0.875rem,1.04vw,1.25rem)]">{totalYield}%</div>
    </div>
  </div>
);
```

### Step 3: Use it in all four header slots

In each of the four places (MA odd, MA even, MD odd, MD even), replace the inline `<div className="flex gap-[0.83vw] mb-2">…</div>` block with:

```jsx
<LineHeader
  lineNo={item.split("&")[0]}
  packing={(data["ALU-FIRST"]?.act_pd ?? 0).toLocaleString()}
  totalYield={lineTotalYield(data, "FIRST")}
/>
```

and for the even/`SECOND` rows, `item.split("&")[1]`, `data["ALU-SECOND"]`, `"SECOND"`.

### Step 4: Verify

Reload the page. Each line header shows three tiles. PACKING is non-zero for lines that have an ALU machine; TOTAL YIELD is a plausible percentage (typically 90–100), **not** `NaN` and not `0.00` across the board.

If every TOTAL YIELD reads `0.00`, the process keys in `YIELD_PROCESSES` don't match the payload — re-check against the key list from Task 2 Step 4 (remember ANT is `AN`, not `ANT`).

### Step 5: Lint and commit

```bash
cd dx-center-front && npm run lint:fix
git add src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx
git commit -m "feat(nht): add PACKING and TOTAL YIELD tiles to combine line headers"
```

---

## Task 5: Enable the route and the entry points

**Files:**
- Modify: `dx-center-front/src/App.jsx:241`
- Modify: `dx-center-front/src/pages/nhtNew/NhtHomeNew.jsx:54`

### Step 1: Uncomment the route

`App.jsx:241`, change:
```jsx
              {/* <Route path="assy-combine-realtime" element={<NhtMbrCombineRealtime />} /> */}
```
to:
```jsx
              <Route path="assy-combine-realtime" element={<NhtMbrCombineRealtime />} />
```

`NhtMbrCombineRealtime` is already imported eagerly at `App.jsx:14`. Every other NHT page is `lazy()`-loaded (`App.jsx:67-77`), so convert it for consistency: delete the line-14 import and add alongside the others:

```js
const NhtMbrCombineRealtime = lazy(() => import("./pages/nhtNew/assy/NhtMbrCombineRealtime"));
```

### Step 2: Un-disable the home card

`NhtHomeNew.jsx:54`, remove the `disabled` prop:
```jsx
<CardButton title="Combine" color="bg-lightblue" path="/nht/assy-combine-realtime"/>
```

`NhtSidebar.jsx:54` already links to the route and needs no change.

### Step 3: Verify end to end

1. Navigate `/nht` → click the Combine card → lands on the page
2. Sidebar → Assy → Combine → same page
3. Both MA and MD sections render, each with line groups
4. All four card types show data; the countdown ticks 30 → 0 and the payload refreshes

### Step 4: Lint and commit

```bash
cd dx-center-front && npm run lint:fix
git add src/App.jsx src/pages/nhtNew/NhtHomeNew.jsx
git commit -m "feat(nht): enable assy combine realtime route and home entry"
```

---

## Follow-ups (not in scope — raise separately)

- **`NhtMbrCombineRealtime.jsx` is ~630 lines of four-way duplication.** MA and MD blocks are near-identical, and within each, FIRST and SECOND are near-identical. A `<LineGroup type half data />` extraction would cut it by roughly two thirds. Worth doing once the page is confirmed correct — not before, since the duplication is currently the only thing making the two halves independently debuggable.
- **`summarize()`'s `avg_oee` is wrong for every plant.** [`util/realtimeMachinesRoute.js:37`](../../local-backend/util/realtimeMachinesRoute.js) multiplies per-machine OEE ratios, so the "average" collapses toward zero as machine count rises. Affects every `/machines` endpoint using `makeMachinesHandler`.
- **`MBR_F` has no status field.** `f_status_alarm` is commented out at [`assy_mbrf_realtime.js:16,60`](../../local-backend/api_nht/assy_mbrf_realtime.js), so the MBR card's GAUGE column can never show a status colour. Uncommenting it needs a check on which raw field carries gauge-spindle status.
- **AOD's field names are a trap.** `target_actual / diff_prod / cycle_t / yield_rate` match neither `DefaultCard` nor any `SUMMARY_FIELDS` entry. The next person who copies AOD as a template inherits a broken card. ANT is the second file to have fallen into this.
- **`plan_shutdown` is always `0` across all of NHT.** Every `api_nht` module reads `runInfo.sum_planshutdown_duration`, but the running-time SQL emits **`sum_planstop_duration`** ([`buildRunningTimeSql.js:152`](../../local-backend/util/buildRunningTimeSql.js)). `availability` and `oee` are therefore overstated everywhere. Nine files, one-word fix each — deferred by decision on 2026-08-26. The same change should address the neighbouring issue that `runningTimeData.find((rt) => rt.mc_no === item.mc_no)` can match the `plan stop` row instead of the `run` row, since `dataType:"status"` emits one row per `mc_status`.
- **`_store_ant.js`'s header comment is stale.** Lines 4–9 describe `master_mc_no_front_rear` and SQL mode `withPlanStopAnt`; the code at lines 33 and 40 uses `master_mc_no_status` and `withPlanStop` / `dataType:"status"`. This comment cost a full round of misdiagnosis in rev 1–3. Delete or correct it.
- **TOTAL YIELD is computed differently per plant.** NAT multiplies the backend's `yield_calc_total`; NHT derives the product from `curr_yield` in the frontend (Task 4). Adding `yield_calc_total` to NHT's MBR, GSSM, FIM and ANT modules would let both pages share one implementation — four one-line backend changes, deferred here by decision.
- **The page name no longer fits.** `NhtMbrCombineRealtime` renders MBR, GSSM, FIM and ANT. `NhtAssyCombineRealtime` would match the NAT/MCB naming, but renaming touches `App.jsx` and both entry points — do it as its own change.
