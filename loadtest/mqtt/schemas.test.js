const { test } = require("node:test");
const assert = require("node:assert");
const {
  MAX_COLUMNS,
  TN_COLUMNS,
  roleFor,
  syntheticColumns,
  schemaFor,
  assertValidSchema,
  toRegistrationBody,
} = require("./schemas");

test("tn matches the schema measured against the ClickHouse sink", () => {
  // 34 counters + rssi, cycle_t, time_hr, time_min, model. `spec` and `id_num`
  // are published but map to no column, so they are not registered.
  assert.strictEqual(TN_COLUMNS.length, 39);
  assert.ok(TN_COLUMNS.some((c) => c.name === "prod_pos4" && c.type === "Int32"));
  assert.ok(TN_COLUMNS.some((c) => c.name === "model" && c.type === "String"));
});

test("tn stays under the server's column limit", () => {
  assert.ok(TN_COLUMNS.length <= MAX_COLUMNS);
});

// Registering these would change what the control run inserts, invalidating
// every comparison against results/capacity.md.
test("dropped-by-design fields are not registered as tn columns", () => {
  const names = TN_COLUMNS.map((c) => c.name);
  assert.ok(!names.includes("spec"));
  assert.ok(!names.includes("id_num"));
});

test("tn ignores the requested column count", () => {
  assert.deepStrictEqual(schemaFor("tn", 10), TN_COLUMNS);
  assert.deepStrictEqual(schemaFor("tn", 50), TN_COLUMNS);
});

test("synthetic schemas are deterministic for a given count", () => {
  assert.deepStrictEqual(syntheticColumns("lt1", 20), syntheticColumns("lt1", 20));
  // A wider schema is a strict superset of a narrower one — so a 10-column and
  // a 50-column run share their first 10 columns and differ only in width.
  assert.deepStrictEqual(syntheticColumns("lt1", 50).slice(0, 10), syntheticColumns("lt1", 10));
});

// If the server keeps one global column dictionary rather than scoping by
// process, a shared name would make N "distinct" schemas secretly one schema,
// invisibly to every metric in the run.
test("no column name is shared between two processes", () => {
  const a = syntheticColumns("lt1", 50).map((c) => c.name);
  const b = syntheticColumns("lt2", 50).map((c) => c.name);
  assert.strictEqual(a.filter((n) => b.includes(n)).length, 0);
  assert.strictEqual(a[0], "lt1_c00");
  assert.strictEqual(b[0], "lt2_c00");
});

// Same column index carries the same type across processes, so a wider or
// narrower run differs only in width — never in the type mix being inserted.
test("column types are positional, not per-process", () => {
  const a = syntheticColumns("lt1", 20).map((c) => c.type);
  const b = syntheticColumns("lt2", 20).map((c) => c.type);
  assert.deepStrictEqual(a, b);
});

test("synthetic schemas cover every value-generation role", () => {
  const roles = new Set(syntheticColumns("lt1", 20).map((c) => roleFor(c.type)));
  assert.ok(roles.has("counter"));
  assert.ok(roles.has("jitter"));
  assert.ok(roles.has("const"));
  assert.ok(roles.has("bool"));
});

test("integer types generate counters, not jitter", () => {
  for (const t of ["Int32", "Int64", "UInt32", "UInt64"]) {
    assert.strictEqual(roleFor(t), "counter");
  }
  assert.strictEqual(roleFor("Float32"), "jitter");
  assert.strictEqual(roleFor("Float64"), "jitter");
});

// An over-wide schema must not reach the server: it is unknown whether the API
// rejects it or truncates silently, and a truncated run produces a plausible
// but meaningless result.
test("over-limit schemas throw client-side", () => {
  assert.throws(() => schemaFor("lt1", MAX_COLUMNS + 1), /exceeds the 50-column limit/);
});

test("unsupported types and duplicate names throw", () => {
  assert.throws(() => assertValidSchema("lt1", [{ name: "a", type: "Decimal" }]), /unsupported type/);
  assert.throws(
    () => assertValidSchema("lt1", [{ name: "a", type: "Int32" }, { name: "a", type: "Int32" }]),
    /duplicate column/
  );
});

test("registration body matches the API's documented shape", () => {
  const body = toRegistrationBody("lt1", [{ name: "lt1_c00", type: "Int32" }]);
  assert.deepStrictEqual(body, {
    columns: [{ process: "lt1", column_name: "lt1_c00", column_type: "Int32", column_key: false }],
  });
});
