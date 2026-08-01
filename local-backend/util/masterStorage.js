/**
 * In-memory cache over master_mc_storage_tb.
 *
 * Master data changes only through the master-edit API, so it is cached
 * indefinitely and invalidated explicitly on write. The TTL is a safety net,
 * NOT the primary refresh path: it exists to recover from edits made directly
 * in SQL Server and from a second backend instance that never received the
 * invalidation call. Without it a stale master is unrecoverable without a
 * restart.
 */

const SAFETY_TTL_MS = 30 * 60 * 1000;

/** table defaults to `[${MASTER_DB}].[dbo].[master_mc_storage_tb]` — see .env. */
const createMasterCache = ({ dbms, table, process: process_ }) => {
  let state = { at: 0, rows: null, inflight: null };

  const load = async () => {
    // ROW_NUMBER guards against the table being append-only history. If it is
    // upserted one-row-per-mc_no this is a harmless no-op.
    const sql = `
      WITH Latest AS (
        SELECT mc_no, process, part_no, target_ct, target_utl, target_yield,
               target_special, ring_factor,
               ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY created_at DESC) AS rn
        FROM ${table}
        WHERE process = '${process_}'
      )
      SELECT mc_no,
             process,
             ISNULL(part_no, 'no setup')  AS part_no,
             ISNULL(target_ct, 0)         AS target_ct,
             ISNULL(target_utl, 0)        AS target_utl,
             ISNULL(target_yield, 0)      AS target_yield,
             ISNULL(target_special, 0)    AS target_special,
             ISNULL(ring_factor, 0)       AS ring_factor
      FROM Latest WHERE rn = 1 ORDER BY mc_no;`;

    const result = await dbms.query(sql);
    return result[0] || [];
  };

  const get = () => {
    const fresh = state.rows && Date.now() - state.at < SAFETY_TTL_MS;
    if (fresh) return Promise.resolve(state.rows);
    if (state.inflight) return state.inflight;

    const inflight = (async () => {
      const rows = await load();
      state = { at: Date.now(), rows, inflight: null };
      console.info(`[master:${process_}] loaded ${rows.length} machines`);
      return rows;
    })();

    state = { ...state, inflight };
    inflight.catch(() => {
      if (state.inflight === inflight) state.inflight = null;
    });
    return inflight;
  };

  /** Called by the master-edit API after a successful write. */
  const invalidate = () => {
    state = { at: 0, rows: null, inflight: null };
    console.info(`[master:${process_}] cache invalidated`);
  };

  return { get, invalidate };
};

module.exports = { createMasterCache };
