const { test } = require("node:test");
const assert = require("node:assert");
const { newMachineState, buildDataPayload, FIELD_COUNT } = require("./payload");

test("payload carries every field the real device sends", () => {
  const p = buildDataPayload(newMachineState("test000", 1), "M-1");
  assert.strictEqual(Object.keys(p).length, FIELD_COUNT);
  for (const f of ["rssi", "prod_pos4", "prod_pos6", "cycle_t", "model", "spec", "id_num"]) {
    assert.ok(f in p, `missing ${f}`);
  }
});

test("marker rides in id_num", () => {
  assert.strictEqual(buildDataPayload(newMachineState("test000", 1), "M-42").id_num, "M-42");
});

test("counters never decrease across 500 ticks", () => {
  const s = newMachineState("test000", 7);
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
  const a = buildDataPayload(newMachineState("test000", 99), "m");
  const b = buildDataPayload(newMachineState("test000", 99), "m");
  assert.deepStrictEqual(a, b);
});

test("rssi stays in a plausible dBm band", () => {
  const s = newMachineState("test000", 3);
  for (let i = 0; i < 200; i++) {
    const { rssi } = buildDataPayload(s, `m${i}`);
    assert.ok(rssi <= -30 && rssi >= -95, `rssi out of band: ${rssi}`);
  }
});
