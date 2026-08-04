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

const { withTimeout } = require("./withTimeout");

const SAFETY_TTL_MS = 30 * 60 * 1000;

/**
 * Generous: this is a cold master load, not a per-tick read, and it runs once
 * every 30 minutes at worst. The number exists to catch a wedged connection,
 * not to police query performance.
 */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * table defaults to `[${MASTER_DB}].[dbo].[master_mc_storage_tb]` — see .env.
 *
 * @param {number} [timeoutMs] Fail a hung load. Needed here in its OWN right
 *   even though the calling route also wraps its build: the two caches park
 *   separate `inflight` promises, so a route-level timeout clears the route's
 *   and leaves this one still pointing at the dead query. Every later get()
 *   would join it and the wedge would simply move down a layer.
 */
const createMasterCache = ({ dbms, table, process: process_, timeoutMs = LOAD_TIMEOUT_MS }) => {
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

    const inflight = withTimeout(load(), timeoutMs, `master:${process_} load`).then((rows) => {
      state = { at: Date.now(), rows, inflight: null };
      console.info(`[master:${process_}] loaded ${rows.length} machines`);
      return rows;
    });

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
