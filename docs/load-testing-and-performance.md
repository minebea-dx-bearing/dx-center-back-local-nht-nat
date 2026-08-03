# Load Testing & Performance Measurement

How to simulate many dashboard viewers against a realtime endpoint, and how to measure CPU/RAM correctly while doing it. Written from an actual test run against `/nat/tn/tn-realtime-redis/machines`.

- **Related:** [scaling-dashboard-viewers.md](./scaling-dashboard-viewers.md) — the caching design these tests validate.

---

## 1. What we are actually testing

Realtime dashboards produce an unusual load shape. Every viewer polls on the **wall clock** (`ss % 5 === 0`), so requests do not arrive spread out — they arrive **all at once**, then nothing until the next tick.

That means a realistic test is **not** "N requests per second". It is:

> Fire **N requests simultaneously**, measure how long until the last one finishes, repeat each tick.

This is called a **burst** test. Testing with steady arrival would understate peak latency and completely miss the thundering-herd problem.

Three questions to answer:

1. **Does it stay correct?** Do all viewers get the same answer, and is the answer valid?
2. **Does it stay fast?** What is p95 latency as viewers grow?
3. **What resources does it cost?** CPU, RAM, bandwidth — at idle and at peak.

---

## 2. Step 0 — measure the data source first

Before load-testing anything, find out how often the underlying data actually changes. This sets the ceiling: polling faster than the source updates cannot make data fresher, it only wastes work.

```bash
cd local-backend
node -e '
require("dotenv").config();
const {getRedis}=require("./util/redisClient");
const {readLiveFields}=require("./util/redisRealtimeReader");
const c=getRedis();
setTimeout(async()=>{
  for(let i=0;i<6;i++){
    const r=await readLiveFields(c,["TB22"],{div:"nat",process:"tn"});
    console.log(new Date().toISOString().slice(11,19),"updated_at:",r.TB22.updated_at,"prod_pos6:",r.TB22.prod_pos6);
    await new Promise(res=>setTimeout(res,5000));
  }
  process.exit(0);
},1500);
'
```

Watch how often `updated_at` advances. That number becomes your `cacheMs` and the frontend's `REFRESH_SECONDS`.

---

## 3. A minimal burst test

Enough to answer "does the cache work?" — run it against the real running server.

```js
// _burst.tmp.js  — run from local-backend/, delete afterwards
const http = require("http");
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

const req = () => new Promise((resolve) => {
  const t0 = process.hrtime.bigint();
  const r = http.get(
    { host:"localhost", port:8009, path:"/nat/tn/tn-realtime-redis/machines", agent },
    (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({
        ok: res.statusCode === 200,
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        body,
      }));
    });
  r.on("error", () => resolve({ ok:false, ms:0, body:"" }));   // never let one socket error kill the run
});

(async () => {
  const t0 = Date.now();
  const out = await Promise.all(Array.from({ length: 100 }, req));   // ← 100 at once
  const wall = Date.now() - t0;

  const lat = out.filter(r => r.ok).map(r => r.ms).sort((a,b) => a-b);
  const distinct = new Set(out.map(r => r.body)).size;

  console.log("wall:", wall, "ms");
  console.log("ok:", lat.length, "fail:", out.length - lat.length);
  console.log("p50:", lat[Math.floor(lat.length*0.5)].toFixed(0), "ms");
  console.log("p95:", lat[Math.floor(lat.length*0.95)].toFixed(0), "ms");
  console.log("distinct bodies:", distinct, "(1 = all served from one shared snapshot)");
})();
```

`Promise.all` is what makes it a burst — all 100 requests are issued before any completes.

**The `distinct bodies` line is the real assertion.** If the snapshot cache is working, 100 requests return **1** distinct body. If it returns 100, every request rebuilt independently and the cache is not working.

Actual result on the Redis route:

```
100 concurrent requests in 160 ms
distinct response bodies: 1 (1 = all served from one shared snapshot)
avg per-request ms: 1.60
```

---

## 4. Measuring CPU and RAM correctly

This is where most measurements go wrong. **Do not sample `process.cpuUsage()` on a short interval and take the peak** — a 500 ms window right after a reset produces nonsense. In an early run this reported **770% CPU** for a load that actually used ~90%.

**Use deltas across the whole burst window instead.** Expose a cumulative snapshot from inside the server:

```js
const os = require("os");
app.get("/_snap", (req, res) => {
  const c = process.cpuUsage();          // cumulative microseconds since process start
  const m = process.memoryUsage();
  res.json({ t: Date.now(), cpuUs: c.user + c.system, rss: m.rss, heap: m.heapUsed, cores: os.cpus().length });
});
```

Then the client brackets the burst and computes the difference:

```js
const a = await snap();
const out = await Promise.all(Array.from({ length: n }, req));
const b = await snap();

const wall   = b.t - a.t;                                  // ms
const cpuPct = ((b.cpuUs - a.cpuUs) / 1000) / wall * 100;  // % of ONE core
const rssMB  = b.rss / 1048576;
```

### Reading the numbers

| Metric | Meaning |
|---|---|
| `cpuPct` = 100% | one core fully busy — **Node's JS thread is saturated** |
| `cpuPct` > 100% | work spilling into the libuv threadpool (zlib, fs, crypto) |
| `cpuPct` ÷ 100 | approximate cores in use |
| `rss` | total process memory (heap + buffers + sockets) |
| `heapUsed` | JS objects only — **excludes** socket send-buffers, which dominate here |

**Watch `rss`, not `heapUsed`.** Queued response bytes live in socket buffers outside the JS heap. In our test `heapUsed` barely moved (9 → 11 MB) while `rss` went 53 → 224 MB. Reading only `heapUsed` would have hidden the entire memory cost.

---

## 5. Testing at a machine count you do not have

Production data may only contain a handful of machines. To test 1000, build an isolated harness that reuses the **real** handler with synthetic data:

```js
// _scale_harness.tmp.js — scratch file, delete after use
const express = require("express");
const os = require("os");
const { makeMachinesHandler } = require("./util/realtimeMachinesRoute");

const mk = (i) => ({
  mc_no:`TB${String(i).padStart(4,"0")}`, process:"TN", part_no:`part${i}`,
  target_ct:2.4, target_utl:80, ring_factor:1,
  prod_pos6:16325+i, prod_drop_pos6:184, cycle_time:157,
  mqtt_status:"run", broker:1, status_alarm:"RUNNING",
  target_pd:13160, total_pd:16325+i, diff_pd:3165, drop:184,
  act_ct:1.57, diff_ct:-0.83, curr_utl:109.05,
});

const machines = Array.from({ length: 1000 }, (_, i) => mk(i + 1));

const app = express();
app.get("/machines", makeMachinesHandler({
  getMachines: () => machines,
  getRunningTime: async () => [],
  prepareRealtimeData: (m) => m,   // already shaped; isolates serialize + deliver cost
  summary: "standard",
  cacheMs: 5_000,
}));

app.get("/_snap", (req,res) => {
  const c = process.cpuUsage(), m = process.memoryUsage();
  res.json({ t:Date.now(), cpuUs:c.user+c.system, rss:m.rss, heap:m.heapUsed, cores:os.cpus().length });
});

app.listen(8010, () => console.log(`harness :8010 — ${machines.length} machines`));
```

Key points:

- **Import the real `makeMachinesHandler`.** Testing a reimplementation tells you nothing about production.
- **Put the file inside `local-backend/`,** not `/tmp` — otherwise `require("express")` fails, as `node_modules` resolution walks up from the *script's* directory.
- **Use a separate port** (8010) so the real server keeps running for comparison.
- **Name it `_*.tmp.js` and delete it afterwards.** This is scratch, not code to commit.

---

## 6. Results — measured at 1000 machines

Payload: **581,029 B** plain → **15,857 B** gzipped. Warm/idle: **RSS 53 MB, heap 9 MB** (identical for both modes — gzip adds no baseline cost).

**Plain**

| Viewers | ok | p95 | Data moved | CPU (1 core) | Peak RSS |
|---|---|---|---|---|---|
| 100 | 100 | 245 ms | 55 MB | 91% | 65 MB |
| 500 | 500 | 900 ms | 277 MB | 109% | 121 MB |
| 1000 | 1000 | 1801 ms | 554 MB | 104% | 224 MB |

**Gzip (compressed once per tick)**

| Viewers | ok | p95 | Data moved | CPU (1 core) | Peak RSS |
|---|---|---|---|---|---|
| 100 | 100 | **106 ms** | 1.5 MB | 82% | 57 MB |
| 500 | 500 | **333 ms** | 7.6 MB | 92% | 67 MB |
| 1000 | 1000 | **586 ms** | 15.1 MB | 96% | 74 MB |

**Conclusions:**

- Gzip is **3× faster** and uses **3× less memory** at 1000 viewers.
- CPU sits at ~1 core in both — Node's JS thread is the limit, and gzip does not add to it because it runs once per tick, not per request.
- Plain moved 554 MB in 1.9 s ≈ **290 MB/s**. That already exceeds a gigabit link (~125 MB/s), so plain would fail over a real network even though it passed on localhost.

---

## 7. Traps that produce fake results

Every one of these bit us during the real test run. Treat unexpected results as suspect until you have ruled these out.

### 7.1 The load generator fails before the server does

Early runs showed 616 failures at 2000 viewers — but CPU was only 7–9%. **A server that is failing is not idle.** Those failures were the *client* exhausting Windows ephemeral ports (`ECONNRESET`), not the server.

**Fix:** cap sockets — `new http.Agent({ keepAlive: true, maxSockets: 256 })`. With that, 1000 viewers ran with zero failures.

**Rule of thumb:** if failures rise while CPU stays low, suspect your test tool. A single Windows load generator cannot honestly measure much beyond ~1000 concurrent; past that you need multiple machines or a dedicated tool (k6, autocannon).

### 7.2 Memory readings polluted by the previous run

A gzip run reported **2120 MB RSS at only 100 viewers**, then 74 MB at 1000. That is impossible — it was un-GC'd residue from a preceding 2.7 GB plain run.

**Fix:** restart the server process between modes, and allow settle time between bursts.

### 7.3 Stale server process

Two symptoms, same cause: gzip sizes identical to plain, or a new endpoint returning 404.

**Node caches modules at boot — editing a file changes nothing until you restart.** Also, on Windows `pkill` does **not** reliably kill node. Kill by port:

```powershell
$c = Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue
if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force } }
```

Then confirm the port is actually free before restarting. We lost time to an old harness that survived `pkill` and kept answering requests.

### 7.4 Synthetic data compresses unrealistically well

Our synthetic machines were near-identical, giving a **36×** compression ratio. Real data with varied part numbers, counters and timestamps compresses closer to **8–12×**. Plan with the conservative number.

### 7.5 Localhost is not a network

Localhost has no RTT and no bandwidth ceiling. A result that passes locally can be impossible in production — see §6, where 290 MB/s passed on loopback but exceeds gigabit. Always convert throughput to Mbps and sanity-check it against the real link.

### 7.6 Unhandled errors in the harness itself

An unhandled `ECONNRESET` on the metrics call crashed the whole test mid-run, losing all results. Attach `.on("error", ...)` to **every** request in the harness, including instrumentation calls.

---

## 8. Checklist

**Before:**
- [ ] Measure the data source's real update cadence (§2)
- [ ] Restart the server so it runs current code (§7.3)
- [ ] Cap `maxSockets` in the load generator (§7.1)
- [ ] Record warm/idle RSS and heap as a baseline

**During:**
- [ ] Use `Promise.all` bursts, not steady arrival (§1)
- [ ] Bracket each burst with `/_snap` for CPU/RAM deltas (§4)
- [ ] Assert `distinct bodies === 1` to prove the cache works (§3)
- [ ] Ramp viewers (100 → 500 → 1000) with settle time between

**After:**
- [ ] Cross-check failures against CPU — low CPU + failures = test tool artifact (§7.1)
- [ ] Convert throughput to Mbps and compare against the real network (§7.5)
- [ ] Delete `_*.tmp.js` scratch files
- [ ] Kill harness processes by port (§7.3)
- [ ] Re-verify the real endpoint still works

**Report honestly.** State what was measured, on what hardware, with what data — and state what could *not* be measured. "5000 viewers is unverified because a single Windows load generator exhausts ephemeral ports" is a useful finding. A confident number derived from a broken test is worse than no number.
