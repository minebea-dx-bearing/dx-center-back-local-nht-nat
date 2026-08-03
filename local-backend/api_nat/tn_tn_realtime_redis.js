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
const { getRedis } = require("../util/redisClient");
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
router.get(
  "/machines",
  makeMachinesHandler({
    getMachines,
    getRunningTime: async () => [], // OEE not rendered; see plan
    prepareRealtimeData: prepare,
    summary: "standard",
    // Upstream writes to Redis roughly every ~15s (measured), so a 5s shared
    // snapshot costs no freshness while making Redis load independent of how
    // many dashboards are open.
    cacheMs: 5_000,
    // `?machines=a,b,c` — a dashboard receives only the machines it renders.
    // The Redis read and derive still happen once per tick regardless of how
    // many distinct filters are in play; only slice+serialize+gzip is per
    // filter. Measured at 50 viewers x 750 of 1000 machines: ~110ms per tick.
    filterable: true,
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
