const dbms = require("../../instance/ms_instance_nat");

// tedious caps a request at 2100 parameters; 7 params/row -> 200 rows = 1400.
const CHUNK_SIZE = 200;

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/**
 * Upsert one row per machine for a shift.
 *
 * MERGE on the natural key (shift_date, shift, process, mc_no) makes this
 * idempotent: a container restart, a duplicate scheduler in a second app
 * instance, or a manual backfill all converge to the same state instead of
 * duplicating rows.
 *
 * @param {object} ctx  result of resolveShiftContext()
 * @param {Array}  rows result of collectShiftTotals()
 * @returns {Promise<number>} rows written
 */
const persistShiftTotals = async (ctx, rows) => {
  if (!rows.length) return 0;

  const table = process.env.DATA_LAST_PRODUCTION;
  if (!table) throw new Error("persistShiftTotals: DATA_LAST_PRODUCTION is not set");

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",\n        ");
    const replacements = batch.flatMap((r) => [
      ctx.shift_date,
      ctx.shift,
      r.process,
      r.mc_no,
      r.ok_qty,
      r.ng_qty,
      new Date(r.influx_time),
    ]);

    await dbms.query(
      `
      MERGE ${table} AS target
      USING (VALUES
        ${values}
      ) AS source ([shift_date], [shift], [process], [mc_no], [ok_qty], [ng_qty], [influx_time])
        ON  target.[shift_date] = source.[shift_date]
        AND target.[shift]      = source.[shift]
        AND target.[process]    = source.[process]
        AND target.[mc_no]      = source.[mc_no]
      WHEN MATCHED THEN UPDATE SET
        target.[ok_qty]      = source.[ok_qty],
        target.[ng_qty]      = source.[ng_qty],
        target.[influx_time] = source.[influx_time]
      WHEN NOT MATCHED THEN
        INSERT ([shift_date], [shift], [process], [mc_no], [ok_qty], [ng_qty], [influx_time])
        VALUES (source.[shift_date], source.[shift], source.[process],
                source.[mc_no], source.[ok_qty], source.[ng_qty], source.[influx_time]);
      `,
      { replacements }
    );
  }

  return rows.length;
};

module.exports = { persistShiftTotals };
