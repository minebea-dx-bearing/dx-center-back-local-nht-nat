const axios = require("axios");
const { parseTopic } = require("./parseTopic");

const INFLUX_TIMEOUT_MS = 30000;

/**
 * Read the latched shift counters for every reporting machine.
 *
 * ONE query for all machines (LAST(...) GROUP BY topic) rather than one query
 * per machine — at ~1000 machines the per-machine loop used elsewhere in this
 * codebase would mean 1000 round trips.
 *
 * `epoch=ms` is REQUIRED: raw InfluxDB timestamps are nanoseconds
 * (e.g. 1785991085769420139), which exceeds Number.MAX_SAFE_INTEGER and would
 * be silently corrupted by JSON.parse.
 *
 * A machine absent from the result is OFFLINE, not zero. It is omitted from the
 * return value so the caller writes no row at all.
 *
 * @param {object} ctx result of resolveShiftContext()
 * @returns {Promise<Array<{process: string, mc_no: string, ok_qty: number, ng_qty: number, influx_time: number}>>}
 */
const collectShiftTotals = async (ctx) => {
  const { okField, ngField, windowStartUtc, windowEndUtc } = ctx;

  const q =
    `SELECT LAST("${okField}") AS ok_qty, LAST("${ngField}") AS ng_qty ` +
    `FROM mqtt_consumer ` +
    `WHERE time >= '${windowStartUtc}' AND time <= '${windowEndUtc}' ` +
    `GROUP BY "topic"`;

  const { data } = await axios.get(`${process.env.INFLUX_URL}:${process.env.INFLUX_PORT}/query`, {
    params: { db: process.env.INFLUX_DB, epoch: "ms", q },
    timeout: INFLUX_TIMEOUT_MS,
  });

  const series = data?.results?.[0]?.series || [];

  return series
    .map((s) => {
      const parsed = parseTopic(s.tags?.topic);
      const row = s.values?.[0];
      if (!parsed || !row) return null;

      const ok = row[s.columns.indexOf("ok_qty")];
      if (ok === null || ok === undefined) return null;

      return {
        ...parsed,
        ok_qty: Number(ok),
        ng_qty: Number(row[s.columns.indexOf("ng_qty")] ?? 0),
        influx_time: row[s.columns.indexOf("time")],
      };
    })
    .filter(Boolean);
};

module.exports = { collectShiftTotals };
