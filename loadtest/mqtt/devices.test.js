const { test } = require("node:test");
const assert = require("node:assert");
const { deviceIds, allocate, topic, macFor } = require("./devices");

test("deviceIds generates a zero-padded contiguous range", () => {
  const ids = deviceIds(1000);
  assert.strictEqual(ids.length, 1000);
  assert.strictEqual(ids[0], "test000");
  assert.strictEqual(ids[999], "test999");
});

test("deviceIds honours a smaller count for smoke runs", () => {
  assert.deepStrictEqual(deviceIds(3), ["test000", "test001", "test002"]);
});

test("topic builds the four-segment VM topic", () => {
  assert.strictEqual(topic("data", "tn", "test042"), "data/nat/tn/test042");
  assert.strictEqual(topic("alarm", "tn", "test042"), "alarm/nat/tn/test042");
  assert.strictEqual(topic("data", "lt1", "test042"), "data/nat/lt1/test042");
});

test("allocate splits machines evenly across processes", () => {
  const machines = allocate(6, ["tn", "lt1", "lt2"]);
  assert.strictEqual(machines.length, 6);
  assert.deepStrictEqual(machines.map((m) => m.process), ["tn", "tn", "lt1", "lt1", "lt2", "lt2"]);
});

// Reusing test000 under every process would let anything keying on device
// alone silently merge two machines' rows into one series.
test("device ids are disjoint across processes", () => {
  const machines = allocate(9, ["tn", "lt1", "lt2"]);
  assert.strictEqual(new Set(machines.map((m) => m.device)).size, 9);
  assert.deepStrictEqual(machines.map((m) => m.device).slice(0, 4), ["test000", "test001", "test002", "test003"]);
});

test("an uneven split gives the remainder to the earliest processes", () => {
  const sizes = ["tn", "lt1", "lt2"].map(
    (p) => allocate(10, ["tn", "lt1", "lt2"]).filter((m) => m.process === p).length
  );
  assert.deepStrictEqual(sizes, [4, 3, 3]);
});

test("a single process reproduces the pre-multi-process baseline", () => {
  assert.deepStrictEqual(
    allocate(3, ["tn"]).map((m) => m.device),
    deviceIds(3)
  );
});

// A duplicate MAC across simulated devices would make the VM treat two
// machines as one. Deterministic so a run is reproducible.
test("macFor is unique per device and stable across calls", () => {
  const macs = deviceIds(1000).map(macFor);
  assert.strictEqual(new Set(macs).size, 1000);
  assert.strictEqual(macFor("test042"), macFor("test042"));
  assert.match(macFor("test042"), /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
});
