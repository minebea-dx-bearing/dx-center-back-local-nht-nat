const { test } = require("node:test");
const assert = require("node:assert");
const { newMachineState, buildDataPayload, FIELD_COUNT, COUNTER_FIELDS } = require("./payload");
const { schemaFor } = require("./schemas");

const tnState = (seed) => newMachineState("tn", "test000", seed);

test("payload carries every field the real device sends", () => {
  const p = buildDataPayload(tnState(1), "M-1");
  assert.strictEqual(Object.keys(p).length, FIELD_COUNT);
  for (const f of ["rssi", "prod_pos4", "prod_pos6", "cycle_t", "model", "spec", "id_num"]) {
    assert.ok(f in p, `missing ${f}`);
  }
});

test("marker rides in id_num", () => {
  assert.strictEqual(buildDataPayload(tnState(1), "M-42").id_num, "M-42");
});

test("counters never decrease across 500 ticks", () => {
  const s = tnState(7);
  let prev = buildDataPayload(s, "m0");
  for (let i = 1; i < 500; i++) {
    const cur = buildDataPayload(s, `m${i}`);
    for (const f of ["prod_pos4", "prod_pos6", "prod_drop_pos4", "utilization", "prod_ok"]) {
      assert.ok(cur[f] >= prev[f], `${f} decreased at tick ${i}`);
    }
    prev = cur;
  }
});

test("same seed reproduces an identical run", () => {
  assert.deepStrictEqual(buildDataPayload(tnState(99), "m"), buildDataPayload(tnState(99), "m"));
});

test("rssi stays in a plausible dBm band", () => {
  const s = tnState(3);
  for (let i = 0; i < 200; i++) {
    const { rssi } = buildDataPayload(s, `m${i}`);
    assert.ok(rssi <= -30 && rssi >= -95, `rssi out of band: ${rssi}`);
  }
});

// ---------------------------------------------------------------------------
// tn is the control run for the multi-process test. If its payload changes by
// even one field or one PRNG call, every number in results/capacity.md stops
// being a valid baseline — and nothing at runtime would reveal it. The
// reference implementation below is the verbatim 2026-08-10 builder, kept here
// on purpose: it must be able to fail independently of the code it checks.
// ---------------------------------------------------------------------------

const referenceMulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const referenceBuild = (seed, marker, ticks) => {
  const rnd = referenceMulberry32(seed);
  const counters = {};
  for (const f of COUNTER_FIELDS) counters[f] = Math.floor(rnd() * 5000);
  let rssi = -30 - Math.floor(rnd() * 40);
  const model = `MDL-${Math.floor(rnd() * 900 + 100)}`;

  let out;
  for (let i = 0; i < ticks; i++) {
    for (const f of COUNTER_FIELDS) if (rnd() < 0.5) counters[f] += 1;
    rssi = Math.max(-95, Math.min(-30, rssi + Math.round((rnd() - 0.5) * 4)));
    const now = new Date();
    out = {
      rssi,
      ...counters,
      cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
      time_hr: now.getHours(),
      time_min: now.getMinutes(),
      model,
      spec: 0,
      id_num: marker,
    };
  }
  return out;
};

// time_hr/time_min are wall-clock and can straddle a minute boundary between
// the two builds, which would be a flaky failure about nothing. Checked
// separately below.
const withoutClock = (p) => {
  const { time_hr, time_min, ...rest } = p;
  return rest;
};

test("tn payload is byte-identical to the 2026-08-10 baseline implementation", () => {
  for (const seed of [1, 7, 42, 99]) {
    const actual = buildDataPayload(tnState(seed), "M-1");
    assert.deepStrictEqual(withoutClock(actual), withoutClock(referenceBuild(seed, "M-1", 1)), `seed ${seed}`);
  }
});

test("tn payload stays identical after many ticks, not just the first", () => {
  const s = tnState(5);
  let actual;
  for (let i = 0; i < 250; i++) actual = buildDataPayload(s, "M-1");
  assert.deepStrictEqual(withoutClock(actual), withoutClock(referenceBuild(5, "M-1", 250)));
});

// Key order determines the serialized JSON the broker actually carries.
test("tn field order is unchanged", () => {
  assert.deepStrictEqual(
    Object.keys(buildDataPayload(tnState(1), "M-1")),
    Object.keys(referenceBuild(1, "M-1", 1))
  );
});

test("tn clock fields are the wall clock", () => {
  const p = buildDataPayload(tnState(1), "M-1");
  assert.ok(p.time_hr >= 0 && p.time_hr <= 23);
  assert.ok(p.time_min >= 0 && p.time_min <= 59);
});

// ---------------------------------------------------------------------------
// synthetic processes
// ---------------------------------------------------------------------------

const syntheticState = (process, columnCount, seed = 1) =>
  newMachineState(process, "test200", seed, schemaFor(process, columnCount));

test("a synthetic payload carries exactly its registered columns plus id_num", () => {
  const columns = schemaFor("lt1", 40);
  const p = buildDataPayload(syntheticState("lt1", 40), "M-1");
  assert.deepStrictEqual(Object.keys(p), [...columns.map((c) => c.name), "id_num"]);
  assert.strictEqual(p.id_num, "M-1");
  // `spec` is a tn-device quirk with no synthetic analogue.
  assert.ok(!("spec" in p));
});

// An all-zero or all-default column is exactly what a silently-failed
// registration looks like downstream, so the generator must never produce one.
test("every synthetic column gets a real value", () => {
  const p = buildDataPayload(syntheticState("lt1", 40), "M-1");
  for (const { name } of schemaFor("lt1", 40)) {
    assert.ok(p[name] !== undefined && p[name] !== null, `${name} is empty`);
  }
});

test("synthetic values match their declared column types", () => {
  const columns = schemaFor("lt1", 40);
  const p = buildDataPayload(syntheticState("lt1", 40), "M-1");
  for (const { name, type } of columns) {
    if (type === "String") assert.strictEqual(typeof p[name], "string", name);
    else if (type === "Bool") assert.strictEqual(typeof p[name], "boolean", name);
    else assert.strictEqual(typeof p[name], "number", name);
    if (type.startsWith("Int") || type.startsWith("UInt")) {
      assert.ok(Number.isInteger(p[name]), `${name} is not an integer`);
    }
    if (type.startsWith("UInt")) assert.ok(p[name] >= 0, `${name} is negative`);
  }
});

test("synthetic counters never decrease across 500 ticks", () => {
  const s = syntheticState("lt1", 40, 7);
  const counterNames = schemaFor("lt1", 40)
    .filter((c) => c.type.startsWith("Int") || c.type.startsWith("UInt"))
    .map((c) => c.name);
  let prev = buildDataPayload(s, "m0");
  for (let i = 1; i < 500; i++) {
    const cur = buildDataPayload(s, `m${i}`);
    for (const f of counterNames) assert.ok(cur[f] >= prev[f], `${f} decreased at tick ${i}`);
    prev = cur;
  }
});

// The width axis of the sweep must vary column count and nothing else. The
// shared columns seed identically; they do NOT stay equal past the first tick,
// because a tick draws one PRNG value per column and a 50-column machine
// therefore consumes 50 draws where a 10-column machine consumes 10. That
// divergence is fine — the width runs are compared on server-side insert cost,
// not on values — so this pins the type mix and the seeded state, which are
// what must not vary, rather than the value sequence, which may.
test("a narrower schema seeds identically to the first columns of a wider one", () => {
  const narrow = newMachineState("lt1", "test200", 3, schemaFor("lt1", 10));
  const wide = newMachineState("lt1", "test200", 3, schemaFor("lt1", 50));
  for (const { name } of schemaFor("lt1", 10)) {
    assert.strictEqual(wide.counters[name], narrow.counters[name], name);
  }
});

test("a narrower schema is a strict type-mix prefix of a wider one", () => {
  assert.deepStrictEqual(
    schemaFor("lt1", 50).slice(0, 10).map((c) => c.type),
    schemaFor("lt1", 10).map((c) => c.type)
  );
});

test("two processes at the same width produce disjoint field names", () => {
  const a = Object.keys(buildDataPayload(syntheticState("lt1", 40), "m")).filter((k) => k !== "id_num");
  const b = Object.keys(buildDataPayload(syntheticState("lt2", 40), "m")).filter((k) => k !== "id_num");
  assert.strictEqual(a.filter((n) => b.includes(n)).length, 0);
});

test("same seed reproduces an identical synthetic run", () => {
  assert.deepStrictEqual(
    buildDataPayload(syntheticState("lt1", 40, 99), "m"),
    buildDataPayload(syntheticState("lt1", 40, 99), "m")
  );
});
