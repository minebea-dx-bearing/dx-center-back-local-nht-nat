# Review: `GET /get_combined_data` — 500 Risk Analysis

**File:** [local-backend/api_nat/gd_2gd_combine_realtime.js](../local-backend/api_nat/gd_2gd_combine_realtime.js)
**Date:** 2026-08-05
**Scope:** Enumerate realistic scenarios in which this endpoint returns HTTP 500.

The handler catches all throws and responds with `500 { data: error.message, api_result: "nok" }`. Any unhandled rejection or synchronous throw inside the `try` block ends here. Below are the concrete paths, grouped by cause.

---

## 1. Null / undefined dereferences (most likely triggers)

- [line 116](../local-backend/api_nat/gd_2gd_combine_realtime.js#L116) `mc.mc_no.slice(0, -1)` — if any row in `DATA_MASTER_2GD` has `mc_no = NULL`, this throws `TypeError: Cannot read properties of null (reading 'slice')`. Same risk at [line 117](../local-backend/api_nat/gd_2gd_combine_realtime.js#L117), [line 120](../local-backend/api_nat/gd_2gd_combine_realtime.js#L120), [line 128](../local-backend/api_nat/gd_2gd_combine_realtime.js#L128), [line 129](../local-backend/api_nat/gd_2gd_combine_realtime.js#L129).
- [line 107](../local-backend/api_nat/gd_2gd_combine_realtime.js#L107) `row.mc_no.toLowerCase()` — same risk on `MONITOR_IOT` rows.
- [line 178](../local-backend/api_nat/gd_2gd_combine_realtime.js#L178) `latestStatus[0].find(...)` — if `latestStatus` is not shaped as `[rows, meta]` (e.g. driver returns rows directly), `latestStatus[0]` is a single row object with no `.find`. Same at [line 181](../local-backend/api_nat/gd_2gd_combine_realtime.js#L181).
- [line 165–168](../local-backend/api_nat/gd_2gd_combine_realtime.js#L165-L168) `(mqttArray[0]?.registered).toISOString()` — the optional chaining stops **inside** the parens, then `.toISOString()` is invoked on the result. Throws when:
  - `registered` is a string (common for `mssql`/`tedious` returning `datetime2` as ISO string) → `toISOString is not a function`.
  - `registered` is `null` → `Cannot read properties of null`.

## 2. Data-shape assumptions from the driver

- Result access is **inconsistent**. Lines [50](../local-backend/api_nat/gd_2gd_combine_realtime.js#L50), [53](../local-backend/api_nat/gd_2gd_combine_realtime.js#L53), [71](../local-backend/api_nat/gd_2gd_combine_realtime.js#L71) treat the result as `[rows, meta]` via index `[0]`, but [line 89](../local-backend/api_nat/gd_2gd_combine_realtime.js#L89) destructures `[mqttRows]`. If `dbNAT.query` returns rows directly (non-Sequelize instance), the `[0]` variants break; if it returns `[rows, meta]`, the destructured variant is fine but the others need the same treatment.
- If `mcList` at [line 50](../local-backend/api_nat/gd_2gd_combine_realtime.js#L50) resolves to `undefined`, `for (const mc of mcList)` at [line 114](../local-backend/api_nat/gd_2gd_combine_realtime.js#L114) throws `undefined is not iterable`.

## 3. External dependency failures

- [line 8](../local-backend/api_nat/gd_2gd_combine_realtime.js#L8) `realtimeCache` — if the module export is renamed/removed, `realtimeCache[...]` at [line 128](../local-backend/api_nat/gd_2gd_combine_realtime.js#L128) throws.
- [line 9](../local-backend/api_nat/gd_2gd_combine_realtime.js#L9) `dbNAT` — if the pool isn't connected, first `await dbNAT.query(...)` rejects on connection timeout / login failure / TLS error.
- MSSQL connection pool exhausted under load → `ConnectionError` / `RequestError`.
- Query timeout on any of the 4 sequential queries. The CTE at [line 17–49](../local-backend/api_nat/gd_2gd_combine_realtime.js#L17-L49) joins `DATA_MASTER_2GD` to `DATA_PRODUCTION_2GD` with **no date filter on `m`**, wrapping the day filter in `format(iif(...))` — non-SARGable, so the plan scans production rows.

## 4. SQL / query-time errors

- [line 33](../local-backend/api_nat/gd_2gd_combine_realtime.js#L33) string-interpolates `moment().format(...)`. Currently safe (fixed format), but not parameterized. Any future change or locale-driven digit substitution silently breaks the query.
- SQL Server deadlock (error 1205) on any read under contention → rejected promise → 500.
- Idle Sequelize pool token expiration → `ELOGIN` on the first query after idle.

## 5. Runtime / logic edges (silent-bad, not 500)

- [line 138](../local-backend/api_nat/gd_2gd_combine_realtime.js#L138) `new Date(mqttArray[0].registered).getTime()` — an invalid string yields `NaN`, `diffMinutes` becomes `NaN`, the `> 5` branch is skipped, and the `.includes(1)` path runs on possibly non-numeric values. No throw, but wrong `iot_broker` / `iot_modbus` output.

---

## Recommended fixes (priority order)

1. **Guard `mc.mc_no`** at [line 114–120](../local-backend/api_nat/gd_2gd_combine_realtime.js#L114-L120):
   ```js
   for (const mc of mcList ?? []) {
     if (!mc?.mc_no) continue;
     ...
   }
   ```
2. **Fix the `.toISOString()` on a possibly-string value** at [line 165](../local-backend/api_nat/gd_2gd_combine_realtime.js#L165):
   ```js
   const raw = mqttArray[0]?.registered;
   const time_mqtt = raw
     ? new Date(raw).toISOString().replace("T", " ").substring(0, 19)
     : "-";
   ```
3. **Normalize query result access.** Pick one style project-wide. If Sequelize:
   ```js
   const [mcList] = await dbNAT.query(...);
   const [statusRows] = await dbNAT.query(...);
   const [alarmRows] = await dbNAT.query(...);
   const [mqttRows]  = await dbNAT.query(...);
   ```
   Then guard `rows ?? []` before `.find` / `for..of`.
4. **Parameterize the date** at [line 33](../local-backend/api_nat/gd_2gd_combine_realtime.js#L33) using Sequelize `replacements` / bind params.
5. **Defensive `.find`** at [line 178](../local-backend/api_nat/gd_2gd_combine_realtime.js#L178) / [line 181](../local-backend/api_nat/gd_2gd_combine_realtime.js#L181) — after normalization, `(statusRows ?? []).find(...)`.
6. **Consider parallelizing** the 4 queries with `Promise.all` — they are independent and currently run sequentially, magnifying tail latency and pool-hold time.

---

## Discovered issues (unrelated, flagged only)

- The CTE at [line 17–49](../local-backend/api_nat/gd_2gd_combine_realtime.js#L17-L49) uses `format(iif(DATEPART(HOUR, p.[registered]) < 7, dateadd(day, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = '...'` — non-SARGable, forces a scan. Consider a computed/persisted "shift date" column or rewriting the filter as a half-open range.
- `LEFT JOIN` in the master CTE with a `WHERE` on the right-hand side ([line 32–33](../local-backend/api_nat/gd_2gd_combine_realtime.js#L32-L33)) effectively converts it to an inner join. If the intent is "all masters, even without production today," this is a bug.
