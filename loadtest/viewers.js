/**
 * Wall-clock-aligned burst load against tn-realtime-redis.
 *
 *   docker compose -f docker-compose.loadtest.yml run --rm \
 *     -e VIEWERS=50 -e K=250 k6 run /scripts/viewers.js
 *
 * VIEWERS  concurrent dashboards
 * K        machines each one filters to (0 = unfiltered, the worst case)
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const VIEWERS = Number(__ENV.VIEWERS || 50);
const K = Number(__ENV.K || 250);
const POOL = Number(__ENV.POOL || 1000);
const TICK = 5;
const BASE = `${__ENV.BASE_URL}/nat/tn/tn-realtime-redis`;

const wrongCount = new Counter("wrong_machine_count");
const bodyKB = new Trend("body_kb");

export const options = {
  scenarios: {
    dashboards: {
      executor: "per-vu-iterations",
      vus: VIEWERS,
      iterations: Number(__ENV.TICKS || 12), // 12 ticks = ~1 minute
      maxDuration: "5m",
    },
  },
  thresholds: {
    // A viewer that does not get its data inside one tick is a stale dashboard.
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    wrong_machine_count: ["count==0"],
  },
};

const names = Array.from({ length: POOL }, (_, i) => `tb${String(i + 1).padStart(4, "0")}`);

/**
 * Deterministic per-VU subset, overlapping rather than partitioned: several
 * dashboards watching the same cell is both realistic and the expensive case.
 * Derived from __VU so a VU asks for the same set every tick, exactly as a real
 * dashboard with a fixed URL does.
 */
function subsetFor(vu) {
  if (!K) return null;
  const out = [];
  // Stride by a value coprime with POOL so subsets overlap without repeating.
  let idx = (vu * 37) % POOL;
  for (let i = 0; i < K; i++) {
    out.push(names[idx]);
    idx = (idx + 7) % POOL;
  }
  return out.sort();
}

const mySet = {};

export default function () {
  if (!mySet[__VU]) mySet[__VU] = subsetFor(__VU);
  const set = mySet[__VU];

  // Align to the next wall-clock multiple of TICK, so all VUs fire together.
  const now = Date.now();
  const waitMs = TICK * 1000 - (now % (TICK * 1000));
  sleep(waitMs / 1000);

  const url = set ? `${BASE}/machines?machines=${encodeURIComponent(set.join(","))}` : `${BASE}/machines`;
  const res = http.get(url, { headers: { "Accept-Encoding": "gzip" } });

  bodyKB.add(res.body ? res.body.length / 1024 : 0);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "returned the requested machines": (r) => {
      if (r.status !== 200) return false;
      const n = JSON.parse(r.body).data.length;
      return n === (set ? set.length : POOL);
    },
  });
  // Correctness is not a footnote: a filter bug that returns everything still
  // looks fast, and would otherwise be reported as a pass.
  if (!ok) wrongCount.add(1);
}
