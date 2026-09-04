# SSE Route Viewer Soak — Implementation Plan

> **For Claude:** Use `skills/collaboration/executing-plans` to implement this plan task-by-task.

**Goal:** Confirm the MMS-SSE-backed `tn-realtime-redis` route holds **N concurrent dashboard viewers for T minutes** (default 50 × 30 min, both configurable) with no error rate, no latency drift, and no memory growth in the backend process.

**Architecture:** k6 runs in a container (`grafana/k6`, capped at 2 CPUs) and drives wall-clock-aligned 5-second bursts against the backend running **on the host** at `localhost:8009` — reached from inside the container as `host.docker.internal:8009`. Because the backend is a host process rather than a container, `docker stats` cannot see it, so a PowerShell sampler records the node process's working set and CPU alongside the run. k6 writes a per-request CSV so latency drift can be measured across the run rather than only summarized at the end.

**Tech Stack:** Docker (k6 image only — no compose stack), k6, PowerShell 5.1 sampler, Node for result analysis.

> **Git Bash trap — applies to every `docker run` below.** MSYS rewrites container-side absolute paths into Windows paths, so `/scripts/soak.js` reaches k6 as `C:/Program Files/Git/scripts/soak.js` and the run dies with "couldn't be found on local disk". Prefix every `docker run` with `MSYS_NO_PATHCONV=1`. Verified 2026-09-04. Not needed from PowerShell.

---

## Context You Need Before Starting

| Read | For |
|---|---|
| `local-backend/util/realtimeMachinesRoute.js` | The two-layer cache under test. **Read this properly.** |
| `local-backend/api_nat/tn_tn_realtime_sse.js` | The route under test |
| `local-backend/util/mmsRealtimeStore.js` | Where live data comes from, and why viewer count does not affect it |
| `loadtest/viewers.js` | The existing k6 burst script this one is derived from |
| `docs/plans/2026-08-03-k6-docker-load-test.md` §"What This Harness Cannot Tell You" | Traps that still apply |

### What changed since the last load test, and why the old harness is dead

`docs/plans/2026-08-03-k6-docker-load-test.md` built a containerized stack seeding **1000 machines into Redis + MSSQL**. The Redis path was deleted on 2026-09-04 (`util/redisRealtimeReader.js`, `instance/redisClient.js`, the `redis` dependency), so that harness's entire fixture layer — `loadtest/seed.js`'s Redis half and `loadtest/writer.js` — no longer feeds the route under test.

**Do not run `docker compose -f docker-compose.loadtest.yml up`.** Two reasons:
1. Its `backend` service publishes host port **8009**, which the host backend already binds. The run fails or, worse, you measure the wrong process.
2. Its `redis` service is now pointless and its `.env.loadtest` points the backend at a Redis that nothing reads.

This plan therefore uses a **standalone `docker run`** for k6 and leaves the compose stack untouched.

### What this soak can and cannot measure

**Can:** viewer fan-out under 50 concurrent clients — the snapshot cache, `?machines=` filter normalization, `JSON.stringify`, gzip, the event loop, and process memory over 30 minutes. This is precisely the layer the SSE migration changed the inputs to.

**Cannot, and must be stated with any result:**
- **Layer 1 at scale.** Only `tb17` and `tb22` exist in master and in the MMS roster. The master merge and `prepareRealtimeData` run over 2 rows, not 1000. Layer 1 runs once per tick regardless of viewer count, so this shifts the curve by a constant — but the constant is unmeasured here.
- **LRU eviction.** `FILTER_CACHE_MAX = 256` (`realtimeMachinesRoute.js:32`). With 2 machines the maximum distinct filter keys is 3 (`__all__`, `tb17`, `tb22`). The cache never evicts. Nothing here tests that bound.
- **Bandwidth on a real link.** Loopback has no RTT and no ceiling.
- **MMS upstream load.** Viewer count does not touch the MMS API at all — the four SSE connections are open regardless. A 30-minute soak adds **zero** load to production upstream. This is a property worth stating, not an assumption to check.

---

## Ground Rules

**Never commit unless the user asks.** Steps below that say "commit" mean *offer* to commit and wait.

**Do not run the backend under nodemon during a soak.** A restart mid-run resets both the in-process SSE shadow (every machine reads `SIGNAL LOST` until streams re-deliver) and the memory baseline the run exists to measure. Use `node server.js`.

**Do not edit files in `local-backend/` while a soak is running,** for the same reason — if nodemon is watching from another terminal it will restart the process out from under the test.

**One process, host-side.** The backend is a plain host node process. Every resource number comes from the PowerShell sampler in Task 2, not `docker stats`.

---

## Task 1: Write the soak script

**Files:**
- Create: `loadtest/soak.js`

Derived from `loadtest/viewers.js` with four changes, each of which breaks the run if skipped.

**Step 1: Understand what must change from `viewers.js`**

| `viewers.js` | Why it breaks here | `soak.js` |
|---|---|---|
| `POOL = 1000`, names `tb0001`…`tb1000` | Those machines never existed outside the deleted Redis fixture. Real names are `tb17`, `tb22` | Explicit `MACHINES` list, env-overridable |
| `executor: "per-vu-iterations"`, `iterations: 12` | Counts iterations, not wall-clock. A 30-minute run is not expressible | `constant-vus` + `duration` |
| `maxDuration: "5m"` | Hard-caps the run at 5 minutes regardless of anything else | Removed; `duration` governs |
| asserts `n === POOL` | With `K=0` the route returns 2 rows, so this fails every request | Asserts against the actual expected count |

**Step 2: Write the script**

```js
/**
 * Sustained viewer soak against the MMS-SSE-backed realtime route.
 *
 *   docker run --rm --cpus 2 -v "$PWD/loadtest:/scripts" \
 *     -e BASE_URL=http://host.docker.internal:8009 \
 *     -e VIEWERS=50 -e DURATION=30m \
 *     grafana/k6 run /scripts/soak.js
 *
 * VIEWERS   concurrent dashboards          (default 50)
 * DURATION  wall-clock run length          (default 30m)
 * K         machines each viewer filters to (0 = unfiltered, the default)
 * MACHINES  comma list of real machine names in master
 *
 * Only tb17 and tb22 exist. This soak therefore measures viewer fan-out, NOT
 * per-machine scale — see the plan's "Can and cannot measure" section before
 * quoting any number from it.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const VIEWERS = Number(__ENV.VIEWERS || 50);
const DURATION = __ENV.DURATION || "30m";
const K = Number(__ENV.K || 0);
const MACHINES = (__ENV.MACHINES || "tb17,tb22").split(",").map((s) => s.trim()).filter(Boolean);
const TICK = 5;
const BASE = `${__ENV.BASE_URL}/nat/tn/tn-realtime-redis`;

const wrongCount = new Counter("wrong_machine_count");
const bodyKB = new Trend("body_kb");

export const options = {
  scenarios: {
    dashboards: {
      // Wall-clock duration, not an iteration count: this is a duration test.
      // gracefulStop lets in-flight requests finish instead of counting as
      // failures at the cutoff.
      executor: "constant-vus",
      vus: VIEWERS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    // Hard gates only. These are deliberately loose: at 2 machines the payload
    // is tiny and a tight bound here would be a number invented rather than
    // measured. The REAL signal is drift across the run (Task 5), read from the
    // CSV, not from these.
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    wrong_machine_count: ["count==0"],
  },
};

/**
 * Deterministic per-VU subset. With only two machines this yields at most two
 * distinct filter keys, so it exercises normalize() and the filtered code path
 * but cannot pressure the 256-entry LRU. Do not read cache-eviction conclusions
 * from a K>0 run here.
 */
function subsetFor(vu) {
  if (!K) return null;
  const out = [];
  let idx = vu % MACHINES.length;
  for (let i = 0; i < K; i++) {
    out.push(MACHINES[idx]);
    idx = (idx + 1) % MACHINES.length;
  }
  return [...new Set(out)].sort();
}

const mySet = {};

export default function () {
  if (mySet[__VU] === undefined) mySet[__VU] = subsetFor(__VU);
  const set = mySet[__VU];

  // Align to the next wall-clock multiple of TICK so all VUs fire together.
  // Real dashboards poll on `ss % 5 === 0`, so peak concurrency equals viewer
  // count. Modelling this as steady traffic would pass a load the real system
  // would fail.
  const now = Date.now();
  sleep((TICK * 1000 - (now % (TICK * 1000))) / 1000);

  const url = set ? `${BASE}/machines?machines=${encodeURIComponent(set.join(","))}` : `${BASE}/machines`;
  const res = http.get(url, { headers: { "Accept-Encoding": "gzip" } });

  bodyKB.add(res.body ? res.body.length / 1024 : 0);

  const expected = set ? set.length : MACHINES.length;
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "returned the requested machines": (r) => {
      if (r.status !== 200) return false;
      try {
        return JSON.parse(r.body).data.length === expected;
      } catch {
        return false;
      }
    },
  });
  // A filter bug that returns everything still looks fast, and would otherwise
  // be reported as a pass.
  if (!ok) wrongCount.add(1);
}
```

**Step 3: Verify it parses**

Run from `dx-center-back-local-nht-nat/`:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "/c/Users/bpa8251/Documents/GitHub/dx-center-nat-nht/dx-center-back-local-nht-nat/loadtest:/scripts" \
  grafana/k6 inspect /scripts/soak.js
```

Expected: JSON describing the `dashboards` scenario — `"executor": "constant-vus"`, `"vus": 50`, `"duration": "30m0s"`. A parse error prints here rather than 30 minutes into a run.

**Verified 2026-09-04:** passes.

---

## Task 2: Write the host resource sampler

**Files:**
- Create: `loadtest/sample-host.ps1`

`docker stats` reports containers. The backend is a host process, so it is invisible to it. Without this task the soak produces latency numbers and no idea what they cost.

**Step 1: Write the sampler**

```powershell
# Samples the backend node process (found by whoever is listening on the port)
# every N seconds into a CSV. The backend runs on the HOST, so docker stats
# cannot see it — this is the equivalent.
#
#   powershell -File loadtest/sample-host.ps1 -OutFile loadtest/results/soak-X/host.csv
param(
  [int]$Port = 8009,
  [int]$IntervalSec = 30,
  [string]$OutFile = "loadtest/results/host.csv"
)

$pid_ = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess | Select-Object -First 1
if (-not $pid_) { Write-Error "nothing listening on $Port"; exit 1 }
$proc = Get-Process -Id $pid_
Write-Host "sampling PID $pid_ ($($proc.ProcessName)) every ${IntervalSec}s -> $OutFile"

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
"epoch,rss_mb,cpu_total_s,threads,handles" | Out-File -FilePath $OutFile -Encoding utf8

# CPU is cumulative seconds, not a percentage. Percentage is derived in Task 6
# as a delta between consecutive samples — a running total read as a rate is
# the most common way this kind of sampling lies.
while ($true) {
  try {
    $p = Get-Process -Id $pid_ -ErrorAction Stop
    $line = "{0},{1},{2},{3},{4}" -f `
      [int][double]::Parse((Get-Date -UFormat %s)),
      [math]::Round($p.WorkingSet64 / 1MB, 2),
      [math]::Round($p.CPU, 2),
      $p.Threads.Count,
      $p.HandleCount
    Add-Content -Path $OutFile -Value $line -Encoding utf8
  } catch {
    Add-Content -Path $OutFile -Value "PROCESS_GONE" -Encoding utf8
    break
  }
  Start-Sleep -Seconds $IntervalSec
}
```

**Step 2: Verify it samples**

```bash
powershell -File loadtest/sample-host.ps1 -IntervalSec 2 -OutFile loadtest/results/_smoke/host.csv
```

Let it write ~4 rows, then Ctrl+C. Expected: a header plus rows where `rss_mb` is plausible (~100 MB) and `cpu_total_s` **increases** between rows.

**If `PROCESS_GONE` appears immediately,** nothing is listening on 8009 — start the backend first (Task 3).

---

## Task 3: Establish the baseline

This task produces no code. It exists because the most common way a soak lies is that the idle baseline was never taken, so normal startup behaviour gets attributed to load.

**Step 1: Start the backend, not under nodemon**

```bash
cd local-backend && node server.js
```

Leave it in its own terminal for the whole exercise. Expect `Server is running on port 8009`, MQTT connections, and per-process master reloads.

**Step 2: Let the SSE shadow warm up**

The shadow starts blank on boot. Wait ~60s, then:

```bash
curl -s "http://localhost:8009/nat/tn/tn-realtime-redis/machines" | head -c 400
```

Expected: two rows, each with `"source":"MMS-SSE"`, a populated `updated_at`, and `status_alarm` **not** `SIGNAL LOST`. If both read `SIGNAL LOST`, the streams have not delivered yet — wait longer before starting any run, or the soak measures the cold-start branch.

**Step 3: Record idle**

Run the sampler for 2 minutes with no load. Record median `rss_mb` and the per-sample CPU delta. **Every number in Task 6 is a delta from this, not an absolute.**

**Step 4: Confirm k6 can reach the host**

```bash
docker run --rm grafana/k6 version
MSYS_NO_PATHCONV=1 docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "/c/Users/bpa8251/Documents/GitHub/dx-center-nat-nht/dx-center-back-local-nht-nat/loadtest:/scripts" \
  -e BASE_URL=http://host.docker.internal:8009 -e VIEWERS=2 -e DURATION=15s \
  grafana/k6 run /scripts/soak.js
```

Expected: all checks pass, `wrong_machine_count 0`, `http_req_failed 0.00%`.

**This is the gate for the whole plan.** If it fails with a connection error, `host.docker.internal` is not resolving — on Docker Desktop it should be automatic and the `--add-host` flag is belt-and-braces. Do not proceed to a 30-minute run until this 15-second one is green.

---

## Task 4: Smoke run at full concurrency, short duration

Full viewer count, 2 minutes. Catches everything a 30-minute run would catch about *correctness* and costs 2 minutes instead of 30.

**Step 1: Run it**

```bash
MSYS_NO_PATHCONV=1 docker run --rm --cpus 2 --add-host=host.docker.internal:host-gateway \
  -v "/c/Users/bpa8251/Documents/GitHub/dx-center-nat-nht/dx-center-back-local-nht-nat/loadtest:/scripts" \
  -e BASE_URL=http://host.docker.internal:8009 \
  -e VIEWERS=50 -e DURATION=2m \
  grafana/k6 run /scripts/soak.js
```

**Step 2: Read it before committing 30 minutes**

| Check | Expected | If not |
|---|---|---|
| `http_req_failed` | 0.00% | Stop. Read the backend terminal for stack traces |
| `wrong_machine_count` | 0 | Stop. Filter or row count is wrong — a correctness bug, not a perf one |
| `http_reqs` | ≈ `VIEWERS × 12 × 2` (~1200) | Far fewer means VUs are not aligning to the tick; check the sleep math |
| `http_req_duration p(95)` | note it | This is the reference the 30-minute run's drift is measured against |

Record p95 here. It is the baseline for Task 6.

---

## Task 5: The soak run

**Files:**
- Create: `loadtest/run-soak.sh`

**Step 1: Write the runner**

Wraps sampler + k6 so the two cover the same window, and names an output directory per run.

```bash
#!/usr/bin/env bash
# Viewer soak against the host backend. Usage:
#   VIEWERS=50 DURATION=30m bash loadtest/run-soak.sh
set -euo pipefail

VIEWERS="${VIEWERS:-50}"
DURATION="${DURATION:-30m}"
K="${K:-0}"
PORT="${PORT:-8009}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="soak-v${VIEWERS}-k${K}-$(date +%Y%m%d-%H%M%S)"
OUT="$REPO/loadtest/results/$NAME"
mkdir -p "$OUT"

echo "=== $NAME : $VIEWERS viewers for $DURATION ==="

# Fail fast rather than 30 minutes later.
curl -sf "http://localhost:$PORT/nat/tn/tn-realtime-redis/available" > /dev/null \
  || { echo "backend not responding on $PORT — start it with 'node server.js'"; exit 1; }

powershell -File "$REPO/loadtest/sample-host.ps1" \
  -Port "$PORT" -IntervalSec 30 -OutFile "$OUT/host.csv" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

# --out csv gives per-request rows, which is the only way to see DRIFT. The
# end-of-run summary collapses 30 minutes into one p95 and would hide a slope.
MSYS_NO_PATHCONV=1 docker run --rm --cpus 2 --add-host=host.docker.internal:host-gateway \
  -v "$REPO/loadtest:/scripts" \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  -e VIEWERS="$VIEWERS" -e DURATION="$DURATION" -e K="$K" \
  grafana/k6 run \
    --out "csv=/scripts/results/$NAME/raw.csv" \
    --summary-export="/scripts/results/$NAME/summary.json" \
    /scripts/soak.js 2>&1 | tee "$OUT/k6.log"

echo "results in $OUT"
```

**Step 2: Run it**

```bash
chmod +x loadtest/run-soak.sh
VIEWERS=50 DURATION=30m bash loadtest/run-soak.sh
```

Takes 30 minutes. Do not touch `local-backend/` files while it runs.

---

## Task 6: Read the results

**Files:**
- Create: `loadtest/analyze-soak.js`

The k6 summary gives one p95 for the whole run, which cannot distinguish "flat" from "rising". This computes windowed percentiles from the CSV.

**Step 1: Write the analyzer**

```js
/**
 * Windowed latency + host memory trend for a soak run.
 *
 *   node loadtest/analyze-soak.js loadtest/results/soak-v50-k0-YYYYMMDD-HHMMSS
 *
 * Drift, not the headline p95, is what a duration test exists to find.
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) { console.error("usage: node analyze-soak.js <results-dir>"); process.exit(1); }

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

// ---- latency, bucketed into 5-minute windows ----
const raw = fs.readFileSync(path.join(dir, "raw.csv"), "utf8").trim().split("\n");
const head = raw[0].split(",");
const iMetric = head.indexOf("metric_name");
const iTs = head.indexOf("timestamp");
const iVal = head.indexOf("metric_value");

const buckets = new Map();
let t0 = Infinity;
for (let i = 1; i < raw.length; i++) {
  const c = raw[i].split(",");
  if (c[iMetric] !== "http_req_duration") continue;
  const ts = Number(c[iTs]);
  t0 = Math.min(t0, ts);
  buckets.set(ts, Number(c[iVal]));
}

const rows = [...buckets.entries()].map(([ts, v]) => ({ w: Math.floor((ts - t0) / 300), v }));
const byWindow = new Map();
for (const r of rows) {
  if (!byWindow.has(r.w)) byWindow.set(r.w, []);
  byWindow.get(r.w).push(r.v);
}

console.log("window        n     p50      p95      max");
const p95s = [];
for (const w of [...byWindow.keys()].sort((a, b) => a - b)) {
  const s = byWindow.get(w).sort((a, b) => a - b);
  p95s.push(pct(s, 0.95));
  console.log(
    `${String(w * 5).padStart(3)}-${String(w * 5 + 5).padStart(3)}min ${String(s.length).padStart(6)} ` +
    `${pct(s, 0.5).toFixed(1).padStart(8)} ${pct(s, 0.95).toFixed(1).padStart(8)} ${s[s.length - 1].toFixed(1).padStart(8)}`,
  );
}

const firstP95 = p95s.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, p95s.length);
const lastP95 = p95s.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, p95s.length);
console.log(`\np95 drift: ${firstP95.toFixed(1)}ms -> ${lastP95.toFixed(1)}ms (${((lastP95 / firstP95 - 1) * 100).toFixed(1)}%)`);

// ---- host memory + CPU ----
const host = fs.readFileSync(path.join(dir, "host.csv"), "utf8").trim().split("\n").slice(1)
  .filter((l) => l !== "PROCESS_GONE")
  .map((l) => l.split(","))
  .map((c) => ({ epoch: Number(c[0]), rss: Number(c[1]), cpu: Number(c[2]) }));

if (host.length > 1) {
  const rssFirst = host.slice(0, Math.ceil(host.length / 4)).map((h) => h.rss);
  const rssLast = host.slice(-Math.ceil(host.length / 4)).map((h) => h.rss);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\nRSS  first quarter ${mean(rssFirst).toFixed(1)}MB -> last quarter ${mean(rssLast).toFixed(1)}MB ` +
              `(${((mean(rssLast) / mean(rssFirst) - 1) * 100).toFixed(1)}%)`);
  console.log(`RSS  min ${Math.min(...host.map((h) => h.rss)).toFixed(1)}MB  max ${Math.max(...host.map((h) => h.rss)).toFixed(1)}MB`);

  const span = host[host.length - 1].epoch - host[0].epoch;
  const cpu = host[host.length - 1].cpu - host[0].cpu;
  console.log(`CPU  ${cpu.toFixed(1)}s over ${span}s = ${((cpu / span) * 100).toFixed(1)}% of one core`);
}
```

**Step 2: Run it**

```bash
node loadtest/analyze-soak.js loadtest/results/soak-v50-k0-<timestamp>
```

**Step 3: Judge it**

| Signal | Pass | Fail means |
|---|---|---|
| `http_req_failed` | 0% | Investigate before believing any other number |
| `wrong_machine_count` | 0 | A row-count or filter bug. Stop and fix; invalidates the run |
| p95 drift first→last | flat, within noise | Degradation under sustained load — GC pressure or an unbounded structure |
| RSS first quarter → last quarter | flat within ~5% | Leak. Suspect the shadow Map or the payload cache holding references |
| RSS shape | sawtooth is a **pass** | A **rising floor** — each trough higher than the last — is the leak shape |
| CPU % of one core | well under 100% | At 2 machines this should be near-idle. High CPU here is a real finding |

**Step 4: State the caveats with the result**

Any writeup must carry the "Cannot measure" list from the top of this plan. A "50 viewers for 30 minutes, flat" result is real and useful, and it says nothing about 1000 machines.

**Step 5: Offer to commit**

```bash
git add loadtest/soak.js loadtest/sample-host.ps1 loadtest/run-soak.sh loadtest/analyze-soak.js
git commit -m "test: add viewer soak harness for the SSE realtime route"
```

`loadtest/results/` is already gitignored — results stay local.

---

## Task 7 (optional): Filtered variant

Only if the `?machines=` path specifically needs exercising. 5 minutes, not 30.

```bash
VIEWERS=50 DURATION=5m K=1 bash loadtest/run-soak.sh
```

Each VU requests a single machine, so `normalize()`, the sha1 key, and the per-key payload cache all run. **Two distinct keys total** — this confirms the filtered path works under concurrency and proves nothing about cache eviction. Compare its p95 against the `K=0` run: filtered should be equal or faster (smaller body), never slower.

---

## Open Risks

- **Two machines is not a scale test.** The single largest gap. If a 1000-machine number is needed, that is a separate build: a stub MMS SSE server plus reseeded master, replacing what `seed.js`/`writer.js` used to do for Redis.
- **The host is also running Docker Desktop.** k6 is capped at 2 CPUs to limit contention, but the VM itself competes with the backend for host cores. If p95 rises while sampled backend CPU stays low, **suspect contention before believing the route is slow.**
- **Live upstream, not a fixture.** Values change because real machines are running. A plant stoppage mid-soak changes `status_alarm` and payload entropy. Note the wall-clock window so a surprising result can be checked against what the plant was doing.
