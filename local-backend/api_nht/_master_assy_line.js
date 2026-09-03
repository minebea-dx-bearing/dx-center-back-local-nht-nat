/**
 * Line membership master for the NHT assembly combine page.
 *
 * Replaces the old `mc_no`-parsing rules (odd/even -> FIRST/SECOND, "MA"/"MD"
 * substring -> type) with the real mapping from `master_data`.
 *
 * Two shapes are returned because the route needs both directions:
 *   - `lines`  : every line, ordered, so the page renders a stable row set.
 *   - `byMcNo` : machine -> line, so a live record can be placed in O(1).
 *
 * Note `byMcNo` deliberately carries no `mg_code`. MBR and MBR_F share one
 * `mc_no` (`assy_mbrf_realtime.js` strips the `_f` suffix), so `mc_no` cannot
 * identify a process. The route keys off the live record's own `process`
 * instead, which already matches `mg_code` for every process it fans out.
 */

const dbms = require("../instance/ms_instance_nht");
const { createRunningTimeCache } = require("../util/runningTimeCache");

// Master data changes when a machine is installed or moved — minutes of
// staleness are fine, and this keeps it off the 30s realtime poll path.
const TTL_MS = 10 * 60 * 1000;

// Two AN rows carry a trailing CRLF (`WANTMD98\r\n`), which would silently fail
// to join. Strip control characters and normalise case on the way out so the
// route can compare against the uppercased `mc_no` the realtime modules emit.
const SQL = `
  SELECT
    m.line_id,
    l.line_name,
    UPPER(LTRIM(RTRIM(REPLACE(REPLACE(m.mc_no, CHAR(13), ''), CHAR(10), '')))) AS mc_no
  FROM [master_data].[dbo].[assy_machine] m
  LEFT JOIN [master_data].[dbo].[assy_machine_group] g ON g.mg_id = m.mg_id
  LEFT JOIN [master_data].[dbo].[assy_line] l ON l.line_id = m.line_id
  WHERE l.line_id IS NOT NULL
  ORDER BY m.line_id
`;

const cache = createRunningTimeCache({
  ttlMs: TTL_MS,
  keyFn: () => "nht-assy-line-master",
  loader: async () => {
    const rows = (await dbms.query(SQL))[0] || [];

    const lines = [];
    const seen = new Set();
    const byMcNo = new Map();

    for (const row of rows) {
      if (!seen.has(row.line_id)) {
        seen.add(row.line_id);
        lines.push({ line_id: row.line_id, line_name: row.line_name });
      }
      if (row.mc_no) byMcNo.set(row.mc_no, { line_id: row.line_id, line_name: row.line_name });
    }

    return { lines, byMcNo };
  },
});

module.exports = { getLineMaster: () => cache.get() };
