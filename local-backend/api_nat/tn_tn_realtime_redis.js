/**
 * PROTOTYPE — NAT TN realtime fed by Redis instead of MQTT.
 *
 * Redis is the store: there is no in-memory live cache and no subscriber. A
 * request reads the four rt_* hashes in one pipelined round trip, merges each
 * device with its cached master row, and hands the result to the SAME
 * prepareRealtimeData the MQTT route uses.
 *
 * Shift starts at 05:00 here, not 05:30 as in tn_tn_realtime.js: the Redis
 * production counters are cumulative since 05:00. Expect target_pd and
 * curr_utl to differ from the MQTT page by that offset. Do not "fix" it.
 *
 * OEE is intentionally 0 — nothing renders it. See the plan's "OEE is dropped"
 * section before adding the running-time query back.
 */
const express = require("express");
const router = express.Router();

const dbms = require("../instance/ms_instance_nat");
const { getRedis } = require("../instance/redisClient");
const { readLiveFields } = require("../util/redisRealtimeReader");
const { createMasterCache } = require("../util/masterStorage");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { prepareRealtimeData } = require("./tn_tn_realtime");

const FACTORY = "nat";
const PROCESS = "tn"; // matches master_mc_storage_tb.process and the rt_* key segment, both lowercase
// Shift start for the Redis counters: 05:00. Stated explicitly here rather than
// inherited from tn_tn_realtime.js's module-level `startTime` — that file's
// value (also 5) is a coincidence, not a guarantee, and prepareRealtimeData's
// signature makes both hour and minute explicit for exactly this reason.
const START_HOUR = 5;
const START_MINUTE = 0;
const MASTER_TABLE = `[${process.env.MASTER_DB}].[dbo].[master_mc_storage_tb]`;

const redis = getRedis();
const masterCache = createMasterCache({ dbms, table: MASTER_TABLE, process: PROCESS });

/** master ⊕ live, shaped exactly as prepareRealtimeData expects. */
const getMachines = async () => {
  const master = await masterCache.get();
  const live = await readLiveFields(redis, master.map((m) => m.mc_no), { div: FACTORY, process: PROCESS });

  return master.map((m) => ({
    ...m,
    ...(live[m.mc_no] || {}),
    process: PROCESS,
  }));
};

const prepare = (machines, runningTime, now) =>
  prepareRealtimeData(machines, runningTime, now, START_HOUR, START_MINUTE);

//* we need rate limiting
router.get(
  "/machines",
  makeMachinesHandler({
    getMachines,
    getRunningTime: async () => [], // OEE not rendered; see plan
    prepareRealtimeData: prepare,
    summary: "standard",
    // 5s is a deliberate freshness floor, not a rate chosen to sit under the
    // writes. Upstream write interval is per-machine and cycle-driven, not
    // fixed: measured over 90s, tb17 changed every ~2s (min 1, max 3) while
    // tb22 averaged ~11s (min 1, max 18). rt_status/rt_alarm are edge-
    // triggered and may not change for minutes.
    //
    // So a fast machine produces ~2-3 values per window and viewers see only
    // the last. Acceptable here because the cards render cumulative counters
    // and averages, not a per-cycle event log — dropping intermediate values
    // changes nothing on screen. Do NOT reuse this reasoning for a view that
    // needs every cycle.
    cacheMs: 5_000,
    // `?machines=a,b,c` — a dashboard receives only the machines it renders.
    // The Redis read and derive still happen once per tick regardless of how
    // many distinct filters are in play; only slice+serialize+gzip is per
    // filter.
    //
    // NOT yet measured against this route at scale: the only load numbers we
    // have come from a synthetic harness, and they predate the fix that moved
    // the filter lookup map out of the per-request path. Treat the design as
    // sound and the numbers as absent.
    filterable: true,
    // Below the ~900 where nginx's default 8k request-line buffer would reject
    // the URL outright. A dashboard needing more than 500 machines wants a
    // different transport, not a bigger number here.
    maxFilter: 500,
    // Redis and the master SQL load both sit inside the build. Without this a
    // hang (not a rejection) parks `inflight` forever and takes every viewer
    // down until restart. Well above the 5s tick so a slow tick is never
    // mistaken for a dead one.
    timeoutMs: 10_000,
  }),
);

/**
 * Machine list for the dashboard's filter selector, so the frontend can build a
 * `?machines=` query without first downloading every machine's live data.
 *
 * Served straight from masterCache: this is master data, already cached
 * indefinitely and already invalidated by /master/reload below. No snapshot
 * cache here — the payload is small and the read never touches Redis.
 */
router.get("/available", async (req, res) => {
  try {
    const master = await masterCache.get();
    res.json({ success: true, data: master.map(({ mc_no, part_no }) => ({ mc_no, part_no })) });
  } catch (error) {
    console.error("API Error in /available: ", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

/** Called by the master-edit API after a successful write to master_mc_storage_tb. */
router.post("/master/reload", (req, res) => {
  masterCache.invalidate();
  res.json({ success: true });
});

module.exports = { router, masterCache };
