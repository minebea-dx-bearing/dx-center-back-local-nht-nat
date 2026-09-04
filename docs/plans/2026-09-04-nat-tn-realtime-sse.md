# NAT TN realtime: Redis → MMS SSE

**Status:** draft, awaiting approval
**Scope:** prototype, NAT TN only (`tn_tn_realtime_redis.js` / `NatTnRedisRt.jsx`)
**Branch:** current working branch (user confirmed Redis removal is safe here)

---

## 1. What changes and what does not

The data source flips from **pull** (Redis hashes, read fresh every 5s tick) to
**push** (four long-lived SSE connections feeding an in-process shadow map).

Unchanged — this is the point of the design:

- `util/realtimeMachinesRoute.js` (two-layer cache, filtering, gzip)
- `util/masterStorage.js`
- `prepareRealtimeData` in `api_nat/tn_tn_realtime.js`
- `util/determineMachineStatus.js`
- `dx-center-front/src/pages/natNew/tn/NatTnRedisRt.jsx` — **zero frontend change**

`getMachines()` stops being `await redis.hmGet(...)` and becomes a synchronous
read of a `Map` the subscriber keeps warm. `makeMachinesHandler` already accepts
a sync `getMachines` (`Promise.resolve(getMachines())`, `realtimeMachinesRoute.js:145`),
so the route options need no edit.

### Consequence to accept up front

Redis was a **shared, durable** shadow. An in-process Map is neither:

- A restart starts blank. Each device appears only when it next emits. `rt_data`
  devices recover in seconds; `machine-status` / `alarm-status` are edge-triggered
  and may take minutes. During that window `determineMachineStatus` returns
  `SIGNAL LOST` (`updated_at` absent, `determineMachineStatus.js:14`).
- Two backend instances each hold their own 4 connections and their own shadow.
  Fine for a prototype; **not** the shape to scale to all 17 realtime routes without
  revisiting this.

Both are accepted for the prototype. Do not add persistence in this plan.

---

## 2. Endpoints and wire format (verified against saved Bruno responses)

Base: `{{baseUrlRealtime}}`, header `apikey: {{apikey}}`.

| Stream | Path | Replaces |
|---|---|---|
| Data | `/api/v1/device/realtime/data?process=tn&devices=a,b` | `rt_data` |
| Machine Status | `/api/v1/device/realtime/machine-status?...` | `rt_status` |
| Alarm Status | `/api/v1/device/realtime/alarm-status?...` | `rt_alarm` |
| Status | `/api/v1/device/realtime/status?...` | `rt_mqtt` |

Device roster: `GET /api/v1/devices` → `[{last_update, process, device}]`.
`devices=` accepts a **comma list only** — no wildcard, no omission. The roster call
is therefore a hard prerequisite for opening any stream.

Frame format, all four streams:

```
data: [{"device":"tb17","status":"...","payload":{...},"timestamp":"...Z"}]\n\n
```

Differences from the Redis format that will bite if ignored:

1. `payload` is a **real object**, not a double-encoded JSON string. The
   `JSON.parse` twice in `redisRealtimeReader.js:45` must not be carried over.
2. The frame value is an **array** — one connection can deliver several devices
   per event. Iterate it; never take `[0]`.
3. For `machine-status` and `alarm-status` the useful value is top-level
   `status`, not `payload.status`.
4. `timestamp` is **UTC with a `Z` suffix and nanosecond precision**. Redis
   timestamps were parsed with `Date.parse` and rendered local
   (`redisRealtimeReader.js:80-86`). `Date.parse` handles the `Z` and truncates
   the fraction correctly, so the existing approach carries over verbatim —
   keep the local `.format()`, since `updated_at` has always been local and
   `determineMachineStatus` diffs it against local `moment()`.

### Field mapping

| Shadow field | Source | Note |
|---|---|---|
| `prod_pos4`, `prod_pos6` | data `payload` | |
| `prod_drop_pos4`, `prod_drop_pos6` | data `payload` | present on tb22, absent on tb17 — device-dependent, **not** missing from the API |
| `cycle_time` | data `payload.cycle_t` | rename, as today |
| `model` | data `payload.model` | tb22 sends `0`, tb17 omits it. Falls through to `"NO DATA"` (`tn_tn_realtime.js:74`). Same as today; not a regression |
| `mqtt_status` | machine-status **top-level** `status` | |
| `mqtt_alarm` | alarm-status **top-level** `status` | |
| `broker` | status `payload.broker` | `0` ⇒ `SIGNAL LOST` |
| `updated_at` | newest `timestamp` across all four streams | local `YYYY-MM-DD HH:mm:ss` |
| `source` | literal | `"MMS-SSE"` (was `"REDIS"`) |

Payload shape is **device-dependent** (tb17 lean, tb22 rich). Map defensively:
copy the keys we know, leave the rest absent, never assume presence.

---

## 3. Environment variables (user adds values)

Add to `local-backend/.env`, names only — no values committed:

```
MMS_REALTIME_URL=
MMS_REALTIME_APIKEY=
```

Read once at module load. If either is unset the store logs a single warning and
stays idle (route serves master-only rows, i.e. every machine `SIGNAL LOST`)
rather than crashing the whole backend at boot.

---

## 4. Tasks

### Task 1 — `util/mmsRealtimeStore.js` (new)

A factory, `createMmsRealtimeStore({ baseUrl, apiKey, process })`, returning
`{ start, stop, getSnapshot, getDevices }`.

Uses Node's built-in `fetch` + `AbortController` (Node 24 — see `package.json`).
**No new dependency.** `axios` is not used here: its stream mode needs a Node
`Readable` shim per stream and buys nothing.

Steps:

1. `fetchDevices()` — `GET /api/v1/devices`, filter `d.process === process`,
   return lowercased device ids sorted. Roster is refreshed on an interval
   (10 min) and the streams reconnect only when the list actually changes.
2. `subscribe(stream)` — opens one SSE connection, reads
   `res.body` as a byte stream, buffers, splits on `\n\n`, strips the `data: `
   prefix, `JSON.parse`s, and applies each array element through that stream's
   mapper into the shadow `Map` keyed by lowercase device.
3. Reconnect on close/error with exponential backoff, 1s → 30s cap, jittered.
   A stream that ends cleanly (server closed) reconnects the same way — an SSE
   stream ending is normal, not an error.
4. `getSnapshot()` — returns the live `Map` (read-only by convention; the route
   spreads it into fresh objects anyway).
5. `stop()` — aborts all four controllers and clears the roster timer. Needed so
   nodemon restarts do not leak connections.

Design notes to write into the file header:

- Why the shadow is in-process and what that costs on restart (§1).
- Why frames are arrays and why `payload` is not double-encoded (§2) — these are
  the two silent-failure traps.
- Backoff exists to stop a dead upstream turning into a reconnect storm across
  four streams.

**Verify:** `node --check`, plus an offline harness under `test/` that feeds
recorded frames (the Bruno `response *` files) through the mapper and asserts the
shadow for `tb17` and `tb22`.

### Task 2 — rewrite `api_nat/tn_tn_realtime_redis.js`

Rename to `api_nat/tn_tn_realtime_sse.js`. Body:

- Drop `getRedis` / `readLiveFields` / `redis` / `FACTORY`.
- Instantiate the store, call `store.start()` at module load.
- `getMachines`: `master.map(m => ({ ...m, ...(shadow.get(m.mc_no.toLowerCase()) || {}), process: PROCESS }))`.
  Note the **lowercase join** — master `mc_no` casing is not guaranteed to match
  the API's device ids; the Redis path hid this inside `topicKey`.
- Keep `START_HOUR`/`START_MINUTE`, `prepare`, all `makeMachinesHandler`
  options, `/available`, `/master/reload`, and the `module.exports` shape
  unchanged. Re-check the `cacheMs: 5000` comment: it described Redis write
  cadence and now describes SSE emit cadence (~4-6s for tb17 per the recording) —
  reword, do not change the number.

**Verify:** `node --check`; curl `/machines` and `/machines?machines=tb17` once
the user has env values in place.

### Task 3 — route registration

Update the mount in `server.js` (or wherever `tn-realtime-redis` is registered)
to the new module. **Keep the URL path `/nat/tn/tn-realtime-redis` for now** so
the frontend keeps working untouched; rename the path in Task 5, not here.

**Verify:** backend boots, `/available` returns the master list.

### Task 4 — remove the Redis path

Delete, after Task 3 is confirmed live:

- `util/redisRealtimeReader.js`
- `instance/redisClient.js`
- `test/_write_interval.tmp.js` (its only other consumer)
- `redis` from `package.json` dependencies

**Stop-and-ask gate:** I will grep for any remaining `getRedis` / `redis`
reference across the whole backend and show you the result *before* deleting
anything. If a NHT route or a script I have not seen uses Redis, we keep
`redisClient.js` and delete only the reader.

### Task 5 — rename the surface (optional, do last)

Route path `/nat/tn/tn-realtime-redis` → `/nat/tn/tn-realtime-sse`, and
`NatTnRedisRt.jsx` → `NatTnSseRt.jsx` with its `BASE`, the `"Turning (Redis)"`
label (`NatTnRedisRt.jsx:138`), the prototype footnote (line 144), and the
`App.jsx` route entry. Frontend `lint:fix` runs here.

Skipped entirely if you'd rather keep the existing bookmarks working.

---

## 5. Open risks

- **Roster vs master mismatch.** Subscription list comes from `/api/v1/devices`;
  the render list comes from `master_mc_storage_tb`. A machine in master but not
  in the roster renders `SIGNAL LOST` forever, silently. Task 1 logs the
  difference once at startup so it is visible rather than mysterious.
- **Unmeasured.** Nothing here has been run against the live MMS API. Connection
  limits, whether a 50-device `devices=` list is accepted, and how the server
  behaves on idle are all unknown. Task 1's first curl against the real endpoint
  is the real go/no-go.
- **`prod_drop_*` on tb17.** Confirmed device-dependent, not an API gap — but if
  the Drop tile reads 0 for machines you expect non-zero, that is upstream, not
  this change.

---

## 6. Sequencing

Tasks 1 → 2 → 3, reviewed one at a time as usual. Task 4 only after Task 3 is
confirmed working live. Task 5 on request. Nothing is committed unless you ask.
