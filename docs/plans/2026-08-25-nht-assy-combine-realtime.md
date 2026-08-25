# NHT Assy Combine Realtime — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Ship a working NHT Assembly Combine realtime page at `/nht/assy-combine-realtime`, showing MBR → GSSM → FIM → ANT per line for both MA and MD machine families.

**Architecture:** The BE aggregator (`api_nht/assy_combine_realtime.js`) and the FE page (`nhtNew/assy/NhtMbrCombineRealtime.jsx`) **both already exist** and are already MA/MD-aware with ARP/AOD/AVS/ALU already excluded. This is not a greenfield build — it is a repair-and-finish job. The dominant blocker is that `api_nht/assy_ant_realtime.js` is a half-finished copy of the NAT version that throws a `ReferenceError` on every call, which 500s the combine endpoint and blanks the standalone ANT page too.

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
| `yield_calc_total` is a real field | It is **not** — no module in either plant returns it. The NAT page's TOTAL YIELD math is dead code producing `NaN`. Do not copy it. |
| The route is wired up | Route is **commented out** at `App.jsx:241`. Sidebar (`NhtSidebar.jsx:54`) and home (`NhtHomeNew.jsx:54`, `disabled`) already point at `/nht/assy-combine-realtime`. |

### Field-name contract per process (NHT)

| Process key | Prefix | Status field | Notes |
|---|---|---|---|
| `MBR` | `s_` | `s_status_alarm` | Ball spindle |
| `MBR_F` | `f_` | **none** — commented out at [`assy_mbrf_realtime.js:16,60`](../../local-backend/api_nht/assy_mbrf_realtime.js) | Gauge spindle; card's GAUGE half never colours |
| `GSSM` | `f_` (grease) + `s_` (shield) | `s_status_alarm` | |
| `FIM` | none (bare) | `status_alarm` | Reference shape — matches `standard` summary and `DefaultCard` |
| `AN` | `f_` + `s_` today → **bare after Task 1** | `s_status_alarm` → `status_alarm` | |
| `ALU` | none (bare) | `status_alarm` | Added in Task 2 for PACKING only, no card |

`DefaultCard` and the `standard` summary both read bare `act_pd / act_ct / diff_pd / diff_ct / curr_yield / curr_utl / target_pd / status_alarm`. **AOD is deliberately not the naming model** — it returns `target_actual / diff_prod / cycle_t / yield_rate`, which matches neither, which is why it has a hand-rolled handler instead of `makeMachinesHandler`. Follow FIM.

---

## DECISION NEEDED BEFORE TASK 1

ANT is dual-spindle. Collapsing to a single bare `act_pd` means `act_pd = ok_front + ok_rear` — roughly **double** a single spindle's output. But `target` is computed from a single-spindle formula:

```js
target = Math.floor((86400 / target_ct) * (target_utl / 100) * (target_yield / 100) * ring_factor)
```

and `curr_utl`'s denominator is likewise single-spindle:

```js
denom_utl = (elapsedSec * ring_factor) / target_ct
```

If both stay single-spindle while `act_pd` is summed, ANT will report ~**+100% utilisation** and a permanently green `diff_pd`.

**Three options — pick one and record it here before starting:**

- **(A) Scale both denominators by 2** — introduce `const SPINDLE_COUNT = 2` and multiply `target` and `denom_utl` by it. Correct arithmetic. Changes the daily target number the plant currently sees on the standalone ANT page.
- **(B) Leave target single-spindle** — accept that ANT shows ~200% achievement. Wrong, but matches whatever the plant may already be reading elsewhere.
- **(C) Store the doubled target in the master table** — no code change to the formula; `target_special` or `ring_factor` absorbs the factor of 2. Cleanest long-term, needs a DB change and is out of scope here.

> **Decision:** _(fill in before Task 1)_

Tasks below are written for **(A)**. If (B) or (C) is chosen, drop the `SPINDLE_COUNT` multiplications from Task 1 Step 2.

---

## Testing note

`local-backend/package.json` declares `"test": "node --test services/**/*.test.js"` — the glob covers `services/` only, and `api_nht/` has no existing test coverage. Per the project convention (add tests only where coverage already exists), this plan uses **manual endpoint verification via curl**, not new unit tests. Each task has an explicit verification step with expected output.

The backend must be running for verification: `cd local-backend && npm start`.

---

## Task 1: Fix and de-prefix `assy_ant_realtime.js`

This is the blocker. Until it lands, `/nht/assy/combine-realtime` and `/nht/assy/ant-realtime/machines` both return 500.

**Files:**
- Modify: `local-backend/api_nht/assy_ant_realtime.js` (full rewrite of `prepareRealtimeData` + the router options)

### Step 1: Confirm the endpoint is currently broken

Run:
```bash
curl -s http://localhost:3001/nht/assy/ant-realtime/machines | head -c 300
```

Expected: `{"success":false,"message":"Internal Server Error"}`

Check the server console — you should see `ReferenceError: act_ct is not defined`. This confirms you are fixing a real fault, not a phantom. The three faults are:
- `assy_ant_realtime.js:56` — `const diff_ct = Number((act_ct - s_target_ct)...)`, `act_ct` never declared
- `assy_ant_realtime.js:119-121` — returns `s_act_ct: act_ct`, `s_diff_ct: diff_ct`, `s_curr_yield: curr_yield`, none declared
- `assy_ant_realtime.js:66-67` — `s_diff_pd` is computed from `f_act_pd` and `f_diff_pd` from `s_act_pd`; the two are swapped

### Step 2: Replace `prepareRealtimeData` in full

Replace lines 11–128 of `local-backend/api_nht/assy_ant_realtime.js` with:

```js
const SPINDLE_COUNT = 2; // ANT runs front + rear; act_pd sums both, so targets scale to match

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const status_front = determineMachineStatus(item, item.alarm_front, item.occurred_front, "status");
    const status_rear = determineMachineStatus(item, item.alarm_rear, item.occurred_rear, "status");
    // A line is only genuinely running when both spindles are; otherwise surface the faulted one.
    const status_alarm = status_front === "RUNNING" ? status_rear : status_front;

    const runFront = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN FRONT") || {};
    const runRear = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN REAR") || {};

    const sum_run = (runFront.sum_duration || 0) + (runRear.sum_duration || 0);
    const total_time = (runFront.total_time || 0) + (runRear.total_time || 0);
    const plan_shutdown = (runFront.sum_planshutdown_duration || 0) + (runRear.sum_planshutdown_duration || 0);
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor * SPINDLE_COUNT) || 0;
    }
    const target_ct = item.target_ct || 0;
    const target_yield = item.target_yield || 0;
    const target_utl = item.target_utl || 0;

    const act_pd = (item.ok_front || 0) + (item.ok_rear || 0);
    const ng_pd =
      (item.ag_front || 0) + (item.ng_front || 0) + (item.mixball_front || 0) + (item.ag_rear || 0) + (item.ng_rear || 0) + (item.mixball_rear || 0);

    const ct_front = (item.cycle_time_front || 0) / 100;
    const ct_rear = (item.cycle_time_rear || 0) / 100;
    const running_cts = [ct_front, ct_rear].filter((ct) => ct > 0);
    const act_ct = running_cts.length > 0 ? Number((running_cts.reduce((a, b) => a + b, 0) / running_cts.length).toFixed(2)) : 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const total_pd = act_pd + ng_pd;
    const diff_pd = act_pd - target_pd;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));

    const curr_yield = Number(((act_pd / total_pd) * 100 || 0).toFixed(2));

    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor * SPINDLE_COUNT) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) || 0 : 0;

    const downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const denom_perf = target_ct > 0 && total_time - plan_shutdown > 0 ? (total_time - plan_shutdown) / target_ct : 0;
    const performance = denom_perf > 0 ? Number(((total_pd / denom_perf) * 100).toFixed(2)) || 0 : 0;
    const oee = Number(((performance / 100) * (availability / 100) * (curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no === "" ? item.model : item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      status_alarm,
      status_front,
      status_rear,
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

`status_front` / `status_rear` are kept alongside `status_alarm` because the FE flow-bar (Task 4) needs both spindles independently. Everything else is bare, matching FIM.

### Step 3: Switch the summary to `standard`

In the `router.get("/machines", ...)` call at the bottom of the file, change:

```js
    summary: "fSpindle",
```
to:
```js
    summary: "standard",
```

`fSpindle` maps to `f_target_pd / s_act_pd / s_act_ct / s_curr_utl / f_oee` ([`util/realtimeMachinesRoute.js:26`](../../local-backend/util/realtimeMachinesRoute.js)), all of which no longer exist. `standard` maps to `target_pd / act_pd / act_ct / curr_utl / oee`.

### Step 4: Verify the endpoint recovers

Run:
```bash
curl -s http://localhost:3001/nht/assy/ant-realtime/machines \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok:',j.success);console.log('sample:',JSON.stringify(j.data[0],null,2).slice(0,600));console.log('summary:',j.resultSummary)})"
```

Expected:
- `ok: true`
- The sample record has `act_pd`, `act_ct`, `status_alarm` and **no** `s_`/`f_`-prefixed production fields
- `resultSummary` has non-zero `sum_target` and `sum_daily`

**Sanity check the SPINDLE_COUNT decision here:** `curr_utl` should land in a believable band (roughly 60–110%), not ~200%. If it reads ~200%, `SPINDLE_COUNT` is being applied to `act_pd` but not the denominators — re-read Step 2.

### Step 5: Confirm the standalone ANT page now renders

Open `http://localhost:5173/nht/assy-ant-realtime`. Cards should show numbers instead of blanks.

This page was already broken before this plan: [`MasterRtPage.jsx:42`](../../../dx-center-front/src/components/redesign/realtime/MasterRtPage.jsx) has `doubleData = ["MBR", "GSSM"]` — ANT is not in it, so ANT has always been routed to `DefaultCard`, which reads bare fields the BE never sent. Task 1 fixes that as a side effect. Do not add ANT to `doubleData`.

### Step 6: Lint and commit

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

The FE page reads ANT through `s_*`, which Task 1 removed. Without this the ANT cards go blank.

**Files:**
- Modify: `dx-center-front/src/pages/nhtNew/assy/NhtMbrCombineRealtime.jsx`

### Step 1: Update the MA ANT card (around lines 204–226)

In the `CardProcess` for `data["AN-FIRST"]`, rename the five reads:

| Before | After |
|---|---|
| `s_act_pd` | `act_pd` |
| `s_diff_pd` | `diff_pd` |
| `s_act_ct` | `act_ct` |
| `s_diff_ct` | `diff_ct` |
| `s_target_yield` | `target_yield` |
| `s_curr_yield` | `curr_yield` |
| `s_status_alarm` | `status_alarm` |

Also drop the `(FRONT)` suffix from `title` — the card now represents both spindles:
```jsx
title={data["AN-FIRST"]?.mc_no || "N/A"}
```

### Step 2: Repeat for `AN-SECOND` (around lines 316–337)

Same seven renames, same title change.

### Step 3: Repeat for the MD section

The MD block (from line ~360) is a near-duplicate of MA. Apply the identical renames to its `AN-FIRST` and `AN-SECOND` cards.

> Four near-identical ANT card blocks is the DRY smell flagged at the end of this plan. Do **not** refactor it as part of this task — get the page working first, then see Follow-ups.

### Step 4: Fix the flow-bar spindle check

At `NhtMbrCombineRealtime.jsx:340-352` the bar reads `s_status_alarm` and `f_status_alarm` off `AN-FIRST`. `f_status_alarm` never existed on ANT — it was always `undefined`, so the bar could never be green. Replace the condition with the two real spindle fields Task 1 added:

```jsx
                  className={`w-3 h-full ${
                    data["AN-FIRST"]?.status_front === "RUNNING" &&
                    data["AN-FIRST"]?.status_rear === "RUNNING"
                      ? "animated-flow"
                      : data["AN-FIRST"]?.status_front === undefined &&
                        data["AN-FIRST"]?.status_rear === undefined
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

Note this deliberately does **not** reproduce the NAT page's `yield_calc_total` logic (`NatAssyCombineRealtime.jsx:62-84`) — that field is returned by no module in either plant, so the NAT computation multiplies `undefined` and the tile is meaningless. `s_curr_yield ?? curr_yield` covers the mixed prefix convention documented in Ground Truth.

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
- **AOD's field names are a trap.** `target_actual / diff_prod / cycle_t / yield_rate` match neither `DefaultCard` nor any `SUMMARY_FIELDS` entry. The next person who copies AOD as a template inherits a broken card.
- **The page name no longer fits.** `NhtMbrCombineRealtime` renders MBR, GSSM, FIM and ANT. `NhtAssyCombineRealtime` would match the NAT/MCB naming, but renaming touches `App.jsx` and both entry points — do it as its own change.
