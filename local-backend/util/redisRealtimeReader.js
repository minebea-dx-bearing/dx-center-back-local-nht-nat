/**
 * Reads the four rt_* hashes and returns one flat live-field object per device.
 *
 * Wire format (verified against live data):
 *   field key = "{type}/{div}/{process}/{device}"   e.g. "data/nat/tn/tb17"
 *   value     = {"device","div","process","topic","timestamp","payload":"<JSON STRING>"}
 *
 * `payload` is double-encoded. Decoding it once yields a string, not an object —
 * the single most likely silent failure in this file.
 */

const moment = require("moment");

/** Which hash feeds which live fields. */
const SOURCES = [
  {
    hash: "rt_data",
    type: "data",
    map: (p) => ({
      prod_pos4: p.prod_pos4,
      prod_pos6: p.prod_pos6,
      prod_drop_pos4: p.prod_drop_pos4,
      prod_drop_pos6: p.prod_drop_pos6,
      cycle_time: p.cycle_t, // Redis name -> the name prepareRealtimeData reads
      model: p.model,
    }),
  },
  { hash: "rt_status", type: "status", map: (p) => ({ mqtt_status: p.status }) },
  { hash: "rt_alarm", type: "alarm", map: (p) => ({ mqtt_alarm: p.status }) },
  { hash: "rt_mqtt", type: "mqtt", map: (p) => ({ broker: p.broker }) },
];

const topicKey = (type, div, process_, device) => `${type}/${div}/${process_}/${String(device).toLowerCase()}`;

/**
 * Decode one raw hash value. Returns null for absent/corrupt entries rather
 * than throwing — one bad device must not blank the whole page.
 *
 * @returns {{payload: object, timestamp: string} | null}
 */
const decodeEntry = (raw) => {
  if (!raw) return null;
  try {
    const row = JSON.parse(raw);
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== "object") return null;
    return { payload, timestamp: row.timestamp };
  } catch {
    return null;
  }
};

/**
 * @param {object} redis   connected node-redis client
 * @param {string[]} devices  device ids (master mc_no; case-insensitive)
 * @param {{div: string, process: string}} scope
 * @returns {Promise<Record<string, object>>} keyed by the ORIGINAL device string
 */
const readLiveFields = async (redis, devices, { div, process: process_ }) => {
  const results = await Promise.all(
    SOURCES.map((src) => redis.hmGet(src.hash, devices.map((d) => topicKey(src.type, div, process_, d)))),
  );

  const out = {};
  devices.forEach((device, i) => {
    const live = {};
    let newest = null;

    SOURCES.forEach((src, s) => {
      const entry = decodeEntry(results[s][i]);
      if (!entry) return;
      Object.assign(live, src.map(entry.payload));
      // updated_at must be the freshest signal across ALL hashes: rt_mqtt
      // heartbeats independently of rt_data (observed ~1h apart on one device).
      //
      // Compared as epoch ms, not moments. This runs 4x per device — 4000 moment
      // constructions per tick at 1000 machines, for four integer comparisons.
      // Date.parse agrees with moment to the millisecond on these timestamps,
      // including their nanosecond fraction, which it truncates the same way.
      const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(ms) && (newest === null || ms > newest)) newest = ms;
    });

    // The one moment that earns its keep: .format() renders LOCAL time, and
    // updated_at has always been local. Do not swap this for toISOString().
    if (newest !== null) live.updated_at = moment(newest).format("YYYY-MM-DD HH:mm:ss");
    live.source = "REDIS";
    out[device] = live;
  });

  return out;
};

module.exports = { readLiveFields, decodeEntry, topicKey };
