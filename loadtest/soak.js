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
 * per-machine scale — see docs/plans/2026-09-04-sse-viewer-soak.md before
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
    // measured. The REAL signal is drift across the run, read from the CSV by
    // analyze-soak.js, not from these.
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
