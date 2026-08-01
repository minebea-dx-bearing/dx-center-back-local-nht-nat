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

const DIV = "nat";
const PROCESS = "tn"; // matches master_mc_storage_tb.process and the rt_* key segment, both lowercase
const START_MINUTE = 0; // 05:00 — matches where the Redis counters reset
const MASTER_TABLE = `[${process.env.MASTER_DB}].[dbo].[master_mc_storage_tb]`;

const redis = getRedis();
const masterCache = createMasterCache({ dbms, table: MASTER_TABLE, process: PROCESS });

/** master ⊕ live, shaped exactly as prepareRealtimeData expects. */
const getMachines = async () => {
  const master = await masterCache.get();
  const live = await readLiveFields(redis, master.map((m) => m.mc_no), { div: DIV, process: PROCESS });

  return master.map((m) => ({
    ...m,
    ...(live[m.mc_no] || {}),
    process: PROCESS,
  }));
};

const prepare = (machines, runningTime, now) => prepareRealtimeData(machines, runningTime, now, START_MINUTE);

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines,
    getRunningTime: async () => [], // OEE not rendered; see plan
    prepareRealtimeData: prepare,
    summary: "standard",
  }),
);

/** Called by the master-edit API after a successful write to master_mc_storage_tb. */
router.post("/master/reload", (req, res) => {
  masterCache.invalidate();
  res.json({ success: true });
});

module.exports = { router, masterCache };
