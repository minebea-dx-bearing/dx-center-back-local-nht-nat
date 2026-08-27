# NHT AOD + ANT Analysis Page Implementation Plan

> **For Claude:** Use `@skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Give NHT ASSY processes AOD and ANT a per-machine analysis page identical to the existing NHT AVS one (shift production table, hourly production chart, cycle-time chart, status timeline, alarm summary table).

**Architecture:** Both processes fit the existing template exactly. The backend is a thin router that hands four endpoints to the shared `util/analysis_assy.js` helpers with per-process DB/column constants — no new query logic. The frontend is a copy of `NhtAvsAnalysisMachine.jsx` with one changed constant (`process_mc`). Navigation from the realtime cards already works generically (`DefaultCard.jsx:157` pushes `${location.pathname}/analysis-mc?mc_no=…`), so **no realtime page needs to change** — only the two React Router routes must exist.

**Tech Stack:** Express 4 + Sequelize raw queries against MS SQL Server (`instance/ms_instance_nht`), React 19 + React Router 7 + Ant Design + ECharts on the frontend.

---

## Context an engineer with zero repo knowledge needs

### The shared helper

`local-backend/util/analysis_assy.js` exports four functions. Every ASSY analysis router is nothing but a parameter list for them:

| Export | Used by endpoint | Reads |
|---|---|---|
| `productionByHour` | `/production_hour_by_mc/:mc_no/:date` | prod table |
| `status` | `/status/:mc_no/:date` | prod + `DATA_MCSTATUS_*` + `MONITOR_IOT` |
| `alarm` | (NAT only) `/status/...` | `DATA_ALARMLIS_*` + `MONITOR_IOT` |
| `productionDaily` | `/get_production_analysis_by_mc/:mc_no/:date` | prod + `DATA_MASTER_*` |

**NHT uses `status`, not `alarm`.** NHT machines report machine state into `DATA_MCSTATUS_*`; NAT reports paired alarm/alarm_ rows into `DATA_ALARMLIS_*`. Both target DBs (`data_machine_aod`, `data_machine_an2`) have been confirmed by the user to contain `MONITOR_IOT`, which `status` needs.

### Where the column names came from

`util/mqtt_master_mc_no_status.js:44` selects `p.*` from the production table, so the field names the realtime handlers destructure **are** the production-table column names. Reading `assy_aod_realtime.js:34-36` and `assy_ant_realtime.js:32-34` gives:

| Process | DB stem | Table suffix | OK | NG | CT |
|---|---|---|---|---|---|
| AOD | `data_machine_aod` | `AOD` | `[ok_prod]` | `[ng_prod]` | `[cycletime]` |
| ANT | `data_machine_an2` | `AN` | `[ok1] + [ok2]` | `[ag] + [ng] + [mix]` | `[cycle]` |

Two traps:

1. **ANT's table suffix is `AN`, not `ANT`.** See `_store_ant.js:21-25` (`dbProcess = "AN"`). The HTTP route path is still `ant-analysis-by-mc`.
2. **ANT's multi-term OK/NG expressions must be parenthesized.** `analysis_assy.js:153` interpolates `COLUMN_OK` into `cast((${COLUMN_OK} * 1.0 / ${COLUMN_TOTAL}) * 100 AS decimal(20,2))`. Without parens, `[ok1] + [ok2] * 1.0 / …` binds `*` before `+` and silently returns a wrong yield. AVS gets away with a bare `[ng_1] + [ng_2]` only because its NG never lands in a multiplicative slot.

### Cycle time is passed raw

`COLUMN_CT` is emitted as-is; the frontend divides by 100 at `NhtAvsAnalysisMachine.jsx:79` (`item.cycle_t / 100`). Do **not** pre-divide in SQL — you would get CT/10000.

### Testing reality

- `local-backend` has **no** `lint:fix` and no `build` script — only `test` and `start`. `node --check <file>` is the only offline gate for backend files.
- Claude cannot reach `localhost:3001`; the backend runs on the user's private network. **Every curl step below is run by the user, who pastes the output back.**
- Frontend gate is `npm run lint` in `dx-center-front`.

### Reference files to read before starting

- `local-backend/api_nht/assy_avs_analysis_by_mc.js` — the backend template (67 lines)
- `dx-center-front/src/pages/nhtNew/assy/NhtAvsAnalysisMachine.jsx` — the frontend template (238 lines)

---

## Task 1: AOD backend router — DONE

**Status:** Complete, `node --check` passes, not yet verified against the live DB.

**Files:**
- Create: `local-backend/api_nht/assy_aod_analysis_by_mc.js` ✅

Copy of `assy_avs_analysis_by_mc.js` with the DB stem changed to `data_machine_aod`, table suffix `AOD`, and `COLUMN_OK`/`COLUMN_NG`/`COLUMN_CT` set to `[ok_prod]` / `[ng_prod]` / `[cycletime]`.

`DATABASE_ALARM` is declared but unused, matching the AVS template (which also declares it and calls `getData.status`). Left in place for parity across the nine sibling `api_nht/*_analysis_by_mc.js` files.

---

## Task 2: ANT backend router — DONE

**Status:** Complete, `node --check` passes, not yet verified against the live DB.

**Files:**
- Create: `local-backend/api_nht/assy_ant_analysis_by_mc.js` ✅

Same copy, with stem `data_machine_an2`, table suffix `AN`, and the parenthesized `([ok1] + [ok2])` / `([ag] + [ng] + [mix])` / `[cycle]`.

---

## Task 3: Register both routes in server.js

**Files:**
- Modify: `local-backend/server.js:91` (append after the ALU line)

**Step 1: Add the two lines**

Existing block ends at line 91:

```js
app.use("/nht/assy/avs-analysis-by-mc", require("./api_nht/assy_avs_analysis_by_mc"));
app.use("/nht/assy/alu-analysis-by-mc", require("./api_nht/assy_alu_analysis_by_mc"));
```

Becomes:

```js
app.use("/nht/assy/avs-analysis-by-mc", require("./api_nht/assy_avs_analysis_by_mc"));
app.use("/nht/assy/alu-analysis-by-mc", require("./api_nht/assy_alu_analysis_by_mc"));
app.use("/nht/assy/aod-analysis-by-mc", require("./api_nht/assy_aod_analysis_by_mc"));
app.use("/nht/assy/ant-analysis-by-mc", require("./api_nht/assy_ant_analysis_by_mc"));
```

**Step 2: Syntax check**

Run: `node --check local-backend/server.js`
Expected: no output, exit 0.

**Step 3: User restarts the backend and smoke-tests the machine list**

```bash
curl -s http://localhost:3001/nht/assy/aod-analysis-by-mc/master_machine
curl -s http://localhost:3001/nht/assy/ant-analysis-by-mc/master_machine
```

Expected: `{"data":[{"mc_no":"…"},…],"success":true,"message":"ok"}` with a non-empty array for both.

**STOP-AND-REPORT GATE.** If either returns `success:false`, `Invalid object name`, or an empty array, do **not** guess at another table name. Report the exact SQL error and ask — the DB stem or table suffix is wrong and only the user can confirm the real one.

---

## Task 4: Verify the three data endpoints against the live DB

No files change. This task exists because the column-name derivation in the Context section is an *inference* from the realtime handlers, and a wrong column name fails loudly here rather than silently on a rendered page.

**Step 1: User picks a machine and a date with known production**

Use an `mc_no` from Task 3's output and a recent date in `YYYY-MM-DD` form. Below, `$MC` and `$DATE` stand in.

**Step 2: Hourly production**

```bash
curl -s "http://localhost:3001/nht/assy/aod-analysis-by-mc/production_hour_by_mc/$MC/$DATE"
curl -s "http://localhost:3001/nht/assy/ant-analysis-by-mc/production_hour_by_mc/$MC/$DATE"
```

Expected: `success:true`, and `data_ok` / `data_ng` / `yield` / `data_date` each a 24-element array.

Check specifically: **every `yield` value is between 0 and 100.** A value in the thousands on ANT means the parenthesization trap fired.

**Step 3: Status timeline**

```bash
curl -s "http://localhost:3001/nht/assy/aod-analysis-by-mc/status/$MC/$DATE"
curl -s "http://localhost:3001/nht/assy/ant-analysis-by-mc/status/$MC/$DATE"
```

Expected: `success:true`, `data` a non-empty array of segments each with `status_alarm`, `occurred_start`, `occurred_end`, `duration_seconds`, `color`; `dataAlarm` a summary array.

Check: `duration_seconds` values sum to roughly 86400 for a completed past day.

**Step 4: Shift production**

```bash
curl -s "http://localhost:3001/nht/assy/aod-analysis-by-mc/get_production_analysis_by_mc/$MC/$DATE"
curl -s "http://localhost:3001/nht/assy/ant-analysis-by-mc/get_production_analysis_by_mc/$MC/$DATE"
```

Expected: `success:true` and `data` shaped `{M:[…], N:[…], All:[…]}`. For a **past** date all three are populated; for **today** only `M` and `All` are, and `N` is `[]` — that is by design (`analysis_assy.js:23-50`).

Check: `prod_ok <= prod_total`, and `yield` / `utl` / `ach` are plausible percentages.

**STOP-AND-REPORT GATE.** Any `Invalid column name` error names the exact bad column — report it, and correct only that constant in the router. Do not start rewriting `analysis_assy.js`; the helper is shared by nine other working routes.

---

## Task 5: AOD frontend page

**Files:**
- Create: `dx-center-front/src/pages/nhtNew/assy/NhtAodAnalysisMachine.jsx`

**Step 1: Copy the AVS page verbatim**

```bash
cp dx-center-front/src/pages/nhtNew/assy/NhtAvsAnalysisMachine.jsx \
   dx-center-front/src/pages/nhtNew/assy/NhtAodAnalysisMachine.jsx
```

**Step 2: Change exactly two things**

Line 16:

```js
const process_mc = "assy/aod";
```

Line 18:

```js
export default function NhtAodAnalysisMachine({ defaultMC, defaultDate }) {
```

Nothing else changes. Every API path in the file is built from `process_mc`, and `startTime={6}` on `MachineStatusTimeline` is correct for NHT ASSY (shift starts 06:00 — see `_store_assy.js:33`).

**Step 3: Lint**

Run: `cd dx-center-front && npm run lint`
Expected: no new errors for the added file.

---

## Task 6: ANT frontend page

**Files:**
- Create: `dx-center-front/src/pages/nhtNew/assy/NhtAntAnalysisMachine.jsx`

Identical to Task 5 with `const process_mc = "assy/ant";` and `export default function NhtAntAnalysisMachine(…)`.

Note: even though the ANT *tables* are suffixed `AN`, the *route* segment is `ant` — this constant feeds the URL, not the DB.

**Step 3: Lint** — same command, same expectation.

---

## Task 7: Wire both pages into the router

**Files:**
- Modify: `dx-center-front/src/App.jsx:78` (lazy imports)
- Modify: `dx-center-front/src/App.jsx:252` (routes)

**Step 1: Add the lazy imports**

After line 78 (`NhtAluAnalysisMachine`):

```js
const NhtAodAnalysisMachine = lazy(() => import("./pages/nhtNew/assy/NhtAodAnalysisMachine"));
const NhtAntAnalysisMachine = lazy(() => import("./pages/nhtNew/assy/NhtAntAnalysisMachine"));
```

**Step 2: Add the routes**

After line 252, inside the `/nht` route block:

```jsx
<Route path="assy-aod-realtime/analysis-mc" element={<NhtAodAnalysisMachine/>} />
<Route path="assy-ant-realtime/analysis-mc" element={<NhtAntAnalysisMachine/>} />
```

The path must be the realtime path plus `/analysis-mc`, because `DefaultCard.jsx:157` navigates to `${location.pathname}/analysis-mc?mc_no=…` and the realtime routes are `assy-aod-realtime` / `assy-ant-realtime` (`App.jsx:239-240`).

**Step 3: Lint**

Run: `cd dx-center-front && npm run lint`
Expected: no new errors.

---

## Task 8: End-to-end verification in the browser

No files change. User-run.

**Step 1:** Open `/nht/assy-aod-realtime`, click any machine card.
Expected: navigates to `/nht/assy-aod-realtime/analysis-mc?mc_no=<THAT_MC>`; the M/C Select is pre-filled with that machine (`NhtAvsAnalysisMachine.jsx:20-22` reads `mc_no` off the query string).

**Step 2:** Confirm all five panels render with data — production table, production chart, cycle-time chart, status timeline, alarm summary table.

Check the cycle-time chart specifically: values should be a plausible seconds figure (e.g. 2–30), not 0.0x. A number ~100× too small means CT got divided twice.

**Step 3:** Change the DatePicker to a past date. All five panels refresh, and the production table now shows a populated **N** shift row (today shows only M).

**Step 4:** Repeat Steps 1–3 on `/nht/assy-ant-realtime`.

**STOP-AND-REPORT GATE for ANT.** ANT cards may not be clickable at all. `DefaultCard.jsx:44`'s `assyProcess` list is missing `'AN'`, and ANT's `process` field is `AN` (`_store_ant.js:21`). This is a **known pre-existing bug**, already flagged to the user and deliberately not fixed. If ANT cards don't navigate, that is this bug — report it and ask before touching `DefaultCard.jsx`; the ANT analysis page is still reachable by typing the URL directly, so it does not block this plan.

---

## Task 9: Commit

**Ask the user first** — the standing rule in this repo is never to commit unless asked.

If approved, stage explicitly (no `git add -A`):

```bash
git add local-backend/api_nht/assy_aod_analysis_by_mc.js \
        local-backend/api_nht/assy_ant_analysis_by_mc.js \
        local-backend/server.js
git commit -m "feat(nht): add AOD and ANT per-machine analysis endpoints"
```

```bash
git add src/pages/nhtNew/assy/NhtAodAnalysisMachine.jsx \
        src/pages/nhtNew/assy/NhtAntAnalysisMachine.jsx \
        src/App.jsx
git commit -m "feat(nht): add AOD and ANT analysis pages"
```

Note the two repos are separate working trees (`dx-center-back-local-nht-nat`, `dx-center-front`) — run each block from its own repo root.

---

## Known issues deliberately out of scope

Flagged previously, confirmed by the user as not-now:

1. **`sum_planshutdown_duration` typo.** All nine `api_nht` realtime modules read `runInfo.sum_planshutdown_duration`, but the SQL emits `sum_planstop_duration`. `plan_shutdown` is therefore always 0, overstating availability and OEE. Affects the **realtime** pages only — the analysis pages built here don't use that field.
2. **`DefaultCard.jsx:44` missing `'AN'`.** See the Task 8 gate.
3. **`_store_ant.js` header comment (lines 4-9) is stale** — it claims dual front/rear spindles and `withPlanStopAnt`; the code actually uses `master_mc_no_status` and `dataType:"status"`, and ANT is single-spindle. This comment has already misled three plan revisions. Worth deleting, but not in this plan.
