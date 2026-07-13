# Field ownership — NAT realtime stores

This document is the **merge contract** for `processStore` instances used by `api_nat/*_realtime.js`. It records which fields on a `machineData[mc_no]` snapshot originate from SQL (master) vs. MQTT (live), so future maintainers know who is authoritative for what.

## Runtime model — separation by storage, not by allowlist

The store keeps two independent maps:

```
master[mc_no] = whole row returned by master_mc_no(...)   (SQL, refreshed every 5 min)
live[mc_no]   = accumulated MQTT payloads merged in       (MQTT, updated per message)
```

Reads merge with **live winning** on key conflicts:

```js
getSnapshot(filter) → matching mc_no.map(mc => ({ ...master[mc], ...live[mc] }))
```

**Why this matters:** the two writers cannot clobber each other because they write to separate objects. No field allowlist is required at the write boundary — every field SQL returns or MQTT sends flows through to the API response unchanged, preserving the existing `/machines` body shape.

The tables below are documentation, not a runtime filter. They explain who owns each field today, so future fixes (e.g., "stop trusting SQL for `prod_total`") can be reasoned about.

---

## SQL-owned fields (master, refreshed every 5 min)

Source: [util/mqtt_master_mc_no.js](../local-backend/util/mqtt_master_mc_no.js) and [util/mqtt_master_mc_no_front_rear.js](../local-backend/util/mqtt_master_mc_no_front_rear.js) (ANT).

### From `DATA_PRODUCTION_<process>` (`p.*` — every column in PROD)

| Field | Type | Notes |
|---|---|---|
| `registered` | datetime | Row timestamp |
| `mc_no` | varchar(10) | Machine identifier (also store key) |
| `process` | varchar(10) | e.g. "2GD", "TN", "ANT" |
| `rssi` | float | Wireless signal — **also pushed by MQTT** (overlap) |
| `model` | varchar(25) | |
| `spec` | varchar(25) | |
| `avgct`, `eachct`, `yieldrt` | float | Cycle-time + yield aggregates — **also MQTT** |
| `ng_p`, `ng_n`, `tng` | float | NG counters — **also MQTT** |
| `prod_total` | float | Daily good count — **also MQTT** |
| `utilization`, `utl_total` | float | Utilization — **also MQTT** |
| `prod_s1`, `prod_s2`, `prod_s3` | float | Stage counters — possibly MQTT |
| `cth1`, `cth2`, `idh1`, `idh2` | float | Sensor heights — possibly MQTT |
| `yield_ok`, `yield_ng_pos`, `yield_ng_neg` | float | Yield breakdown — possibly MQTT |
| `time_full[1]`, `time_wait[1]`, `time_run[1]`, `time_alarm[1]`, `time_worn[1]`, `time_warm[1]`, `time_dress[1]`, `time_other[1]` | float | State accumulators |
| `idl` | float | Idle indicator — **also MQTT** |
| `hour`, `min` | float | |

### From `DATA_MASTER_<process>` (machine targets — pure config)

| Field | Type | Notes |
|---|---|---|
| `part_no` | int | |
| `target_ct` | int | Target cycle time |
| `target_utl` | int | Target utilization % |
| `target_yield` | int | Target yield % |
| `target_special` | int | Override for daily target |
| `ring_factor` | int | Multiplier for `target` computation |

**Pure SQL-only** — never pushed by MQTT. Safe to treat as static-ish.

### From `DATA_ALARMLIS_<process>` (latest RUN-class alarm)

Single-spindle (everything except ANT):
| Field | Notes |
|---|---|
| `alarm` | Latest RUN-class alarm string — **also MQTT** (overlap) |
| `occurred` | Timestamp of that alarm — **also MQTT** |

Dual-spindle (ANT only — uses `master_mc_no_front_rear`):
| Field | Notes |
|---|---|
| `alarm_front`, `occurred_front` | Latest front-spindle alarm — **also MQTT** |
| `alarm_rear`, `occurred_rear` | Latest rear-spindle alarm — **also MQTT** |

---

## MQTT-owned fields (live, updated per message)

MQTT publishes to multiple topics per machine. The store accumulates each payload into `live[mc_no]` via spread-merge, so any topic can contribute any field.

### Confirmed MQTT-only (not in any SQL table)

| Field | Used by | Source |
|---|---|---|
| `status` | `determineMachineStatus` (all files) | MQTT status topic — separate from production-metrics topic |
| `broker` | `determineMachineStatus` (SIGNAL LOSE check) | MQTT |
| `updated_at` | `determineMachineStatus` (staleness check) | Stamped by store on every MQTT write |
| `id_num` | Not currently read by any `prepareRealtimeData` | MQTT metadata (seen in user-provided sample) |
| `source` | Legacy marker — currently set to `"MQTT"` or `"SQL"` per writer | Decorative; kept for API-shape parity |

### Read by `prepareRealtimeData` but not in 2GD PROD schema

These are MQTT-pushed (or live in a process-specific PROD column not in the schema the user provided). Either way, the spread merge passes them through unchanged.

| Field family | Fields | Used in |
|---|---|---|
| TN-style counters | `prod_pos4`, `prod_pos6`, `prod_drop_pos4`, `prod_drop_pos6`, `cycle_time` | `tn_tn_realtime.js` |
| ANT dual-spindle | `ok_front`, `ok_rear`, `ag_front`, `ag_rear`, `ng_front`, `ng_rear`, `mixball_front`, `mixball_rear`, `cycle_time_front`, `cycle_time_rear` | `assy_ant_realtime.js` |
| ASSY counters | `daily_ok`, `daily_ng`, `daily_ag`, `daily_ag1`, `daily_ag2` | various `assy_*` |
| ASSY NG breakdowns | `a_ng`, `a_ng_neg`, `a_ng_pos`, `a_unm`, `b_ng_neg`, `b_ng_pos`, `b_unm`, `chamfer_ng`, `grease_ng`, `grease_ok`, `id_ng`, `mix_ng`, `od_ng`, `ro1_ng`, `ro2_ng`, `shield_a_ng`, `shield_b_ng`, `shield_ok`, `snap_a_ng`, `snap_b_ng`, `width_ng` | various `assy_*` |
| Other live fields | `prod_cnt`, `prod_ok`, `fim_ok`, `match`, `cycle_t` | various |

---

## Overlap fields — the clobber surface (today's bug)

These fields appear in **both** SQL master and MQTT live updates. Today's `*_realtime.js` files spread both writers into the same object, so the SQL reload every 5 min silently rolls these values back to whatever the PROD table last recorded — which lags the live MQTT stream by seconds to minutes.

After the refactor, `live` is stored separately and wins on read, so the rollback is eliminated.

| Field | SQL source | MQTT topic (inferred) | Authoritative source |
|---|---|---|---|
| `prod_total` | PROD | production-metrics | **MQTT** (live tick) |
| `eachct`, `avgct` | PROD | production-metrics | **MQTT** |
| `rssi` | PROD | production-metrics or device-stats | **MQTT** |
| `idl` | PROD | production-metrics | **MQTT** |
| `utilization`, `utl_total` | PROD | production-metrics | **MQTT** |
| `yield_ok` | PROD | production-metrics | **MQTT** |
| `yieldrt`, `yield_ng_pos`, `yield_ng_neg` | PROD | production-metrics | **MQTT** |
| `ng_p`, `ng_n`, `tng` | PROD | production-metrics | **MQTT** |
| `cth1`, `cth2`, `idh1`, `idh2` | PROD | production-metrics | **MQTT** |
| `prod_s1`, `prod_s2`, `prod_s3` | PROD | production-metrics | **MQTT** |
| `time_*` accumulators | PROD | possibly MQTT | **MQTT** if present, else SQL |
| `alarm`, `occurred` (single-spindle) | ALARM | status topic | **MQTT** (per `determineMachineStatus` precedence) |
| `alarm_front`, `alarm_rear`, `occurred_front`, `occurred_rear` (ANT) | ALARM | status topic | **MQTT** |

**Confirmed via user-provided MQTT sample** (`{rssi, avgct, eachct, idl, prod_total, utilization, yield_ok, id_num}`) — every metric in the sample is also a PROD column.

---

## Per-process-family notes

| Family | File count | DB / broker | Special handling |
|---|---|---|---|
| **2GD** | 5 (Bore, InRace, InSuper, OutRace, OutSuper) | `nat_mc_mcshop_2gd` / `NAT_MQTT_MC_SHOP` | One shared store. Filter applied per route (`isInBoreMachine`, `isInRaceMachine`, etc.) |
| **TN** | 1 | `nat_mc_mcshop_tn` / `NAT_MQTT_MC_SHOP` | Standalone store. `startTime = 5:30` shift offset |
| **ANT** | 1 | `nat_mc_assy_ant_new` / `NAT_MQTT_ASSY` | Standalone store. **Dual-spindle**: uses `master_mc_no_front_rear`, has `alarm_front`/`alarm_rear` + `occurred_front`/`occurred_rear` instead of `alarm`/`occurred` |
| **ALU, AOD, ARP, AVS, FIM, GSSM, MBR, MBR_F** | 8 (1 each) | `nat_mc_assy_<name>` / `NAT_MQTT_ASSY` | Standalone stores, same shape as TN |

---

## Implications for `processStore.js`

1. **No allowlist needed at write time.** `master` and `live` are stored in separate maps. Whatever SQL or MQTT provides is preserved verbatim.
2. **Merge at read time is `{ ...master, ...live }`.** This guarantees:
   - Every field today's `...item` spread emits continues to be emitted (API shape preserved).
   - For overlap fields, the live MQTT value always wins (bug fix).
   - SQL-only fields (`target_ct`, `ring_factor`, `part_no`, etc.) always pass through because `live` never sets them.
3. **`updated_at`, `source`, `mc_no`** are added at the merge layer for compatibility with existing callers.
4. **ANT** uses a different `masterLoader` (`master_mc_no_front_rear`) and consumers read `alarm_front`/`alarm_rear` etc. — handled by the store factory taking `masterLoader` as a parameter.
5. **`SIGNAL LOSE`** logic in `determineMachineStatus` keys on `item.broker`, `item.updated_at` — both are MQTT-owned and naturally present after merge. No change needed.

---

## Open follow-ups (out of scope for this PR)

- **Per-field staleness tracking** in `live`: tag each MQTT field with its arrival timestamp so the FE can show "stale" indicators if a specific subsystem stops publishing. Currently `updated_at` is a single global timestamp per machine.
- **ANT's MQTT payload schema** is not directly sampled — we infer the field set from `prepareRealtimeData`. If a new field is added to ANT MQTT, it will still flow through (storage-separation design) but won't be documented here until this table is updated.
- **NHT mirror** (`api_nht/*_realtime.js`) follows the same model — same audit applies when refactoring NHT.
