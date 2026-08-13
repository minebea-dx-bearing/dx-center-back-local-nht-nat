/**
 * Per-process `data` topic schemas.
 *
 * The ingest server allows at most 50 columns on a process's `data` topic, so
 * wide plants are split across several processes rather than one wide table.
 * This file is the single source of truth for what columns each process has,
 * for both the generator (what to publish) and register.js (what to POST to
 * /api/v1/columns/batch) — a mismatch between those two is invisible at
 * runtime, because an unregistered column is silently dropped by the consumer
 * rather than rejected, exactly like the exact-string matching in values.js.
 *
 * `tn` is the real, measured schema (see payload.js header: verified against
 * `DESCRIBE TABLE` on the ClickHouse sink, not against the doc sample). It is
 * the control run. Every other process here is synthetic and exists only to
 * vary process-count and column-count independently.
 */

/** Types the columns API accepts. Anything else is rejected server-side. */
const COLUMN_TYPES = new Set([
  "Float32", "Float64", "String", "Int32", "Int64",
  "UInt32", "UInt64", "Bool", "DateTime",
]);

const MAX_COLUMNS = 50;

// Cumulative-since-shift counters on the real device — monotonic, Int32.
// Moved here from payload.js so the publish side and the registration side
// cannot drift apart.
const TN_COUNTER_FIELDS = [
  "production_total", "prod_pos4", "prod_pos6", "prod_drop_pos4", "prod_drop_pos6",
  "utilization", "prod_utl", "wait_qa_check", "prod_ok", "total_reject",
  "line_reject", "qa_reject", "total_adjust", "prod_total_1r", "forming_1r",
  "facing_bit_1r", "recess3_1r", "cutoff_1_1r", "recess5_1r", "cutoff_2_1r",
  "drill_1r", "partcheck_1r", "prod_bar_1r", "od_bit_1r", "prod_total_2r",
  "forming_2r", "drill_2r", "center_drill_2r", "facing_2r", "reamer_2r",
  "recess_2r", "cutoff_2r", "partcheck_2r", "prod_bar_2r",
];

/**
 * Column roles drive value generation. The role is derived from the type, not
 * stored per column, so a synthetic schema needs no extra metadata:
 *   integer  -> monotonic counter (matches how every real tn counter behaves)
 *   float    -> bounded jitter
 *   string   -> per-machine constant
 *   bool     -> coin flip
 *   datetime -> now
 */
const roleFor = (type) => {
  if (type === "String") return "const";
  if (type === "Bool") return "bool";
  if (type === "DateTime") return "now";
  if (type === "Float32" || type === "Float64") return "jitter";
  return "counter";
};

const TN_COLUMNS = [
  ...TN_COUNTER_FIELDS.map((name) => ({ name, type: "Int32" })),
  { name: "rssi", type: "Int32" },
  { name: "cycle_t", type: "Float32" },
  { name: "time_hr", type: "Int32" },
  { name: "time_min", type: "Int32" },
  { name: "model", type: "String" },
  // `spec` and `id_num` are published (real devices send them) but map to no
  // ClickHouse column and are dropped — see payload.js. They are deliberately
  // NOT registered as columns, so keep them out of this list.
];

/**
 * Type mix for synthetic schemas, weighted to resemble tn: mostly integer
 * counters, a few floats, one string, one bool. Cycling a fixed pattern rather
 * than randomising keeps a given column-count fully reproducible across runs
 * and across the generator/register split.
 */
const SYNTHETIC_TYPE_CYCLE = [
  "Int32", "Int32", "Int32", "Int32", "Int32",
  "Int64", "Int32", "Float32", "Int32", "Int32",
  "UInt32", "Int32", "Float64", "Int32", "Bool",
  "Int32", "Int32", "String", "Int32", "Int32",
];

/**
 * `<process>_c00`..`<process>_cNN`, deterministic in both name and type.
 *
 * Names are process-prefixed so no column name is ever shared between two
 * processes. It is unknown whether the server scopes column definitions per
 * process or keeps one global dictionary; if it is global, an unprefixed
 * `col00` registered under two processes would either collide or silently
 * share one definition, and a test of N *distinct* schemas would in fact be
 * measuring one schema N times — with nothing in the output to reveal it.
 *
 * The `c` prefix stays synthetic-looking rather than resembling real machine
 * fields, for the same reason device ids are `test*`: permanently greppable,
 * never mistakable for a production column.
 */
const syntheticColumns = (process, columnCount) =>
  Array.from({ length: columnCount }, (_, i) => ({
    name: `${process}_c${String(i).padStart(2, "0")}`,
    type: SYNTHETIC_TYPE_CYCLE[i % SYNTHETIC_TYPE_CYCLE.length],
  }));

/**
 * Columns for a process. `tn` is the real schema and ignores `columnCount` —
 * silently reshaping the control run would invalidate every comparison against
 * results/capacity.md.
 */
const schemaFor = (process, columnCount) => {
  const columns = process === "tn" ? TN_COLUMNS : syntheticColumns(process, columnCount);
  assertValidSchema(process, columns);
  return columns;
};

/**
 * Fails loudly rather than letting a run produce a plausible-looking but
 * meaningless result. Over-limit is checked client-side because it is unknown
 * whether the server rejects it or truncates silently — assume the worse case.
 */
const assertValidSchema = (process, columns) => {
  if (columns.length > MAX_COLUMNS) {
    throw new Error(`process ${process}: ${columns.length} columns exceeds the ${MAX_COLUMNS}-column limit`);
  }
  const seen = new Set();
  for (const { name, type } of columns) {
    if (!COLUMN_TYPES.has(type)) throw new Error(`process ${process}: column ${name} has unsupported type ${type}`);
    if (seen.has(name)) throw new Error(`process ${process}: duplicate column ${name}`);
    seen.add(name);
  }
};

/** Request body shape for POST /api/v1/columns/batch. */
const toRegistrationBody = (process, columns) => ({
  columns: columns.map(({ name, type }) => ({
    process,
    column_name: name,
    column_type: type,
    // No column in either schema is a key — device and timestamp identity is
    // supplied by the topic and the consumer, not by a payload field.
    column_key: false,
  })),
});

module.exports = {
  COLUMN_TYPES,
  MAX_COLUMNS,
  TN_COLUMNS,
  TN_COUNTER_FIELDS,
  roleFor,
  syntheticColumns,
  schemaFor,
  assertValidSchema,
  toRegistrationBody,
};
