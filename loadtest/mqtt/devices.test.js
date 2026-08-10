const { test } = require("node:test");
const assert = require("node:assert");
const { deviceIds, topic, macFor } = require("./devices");

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
  assert.strictEqual(topic("data", "test042"), "data/nat/tn/test042");
  assert.strictEqual(topic("alarm", "test042"), "alarm/nat/tn/test042");
});

// A duplicate MAC across simulated devices would make the VM treat two
// machines as one. Deterministic so a run is reproducible.
test("macFor is unique per device and stable across calls", () => {
  const macs = deviceIds(1000).map(macFor);
  assert.strictEqual(new Set(macs).size, 1000);
  assert.strictEqual(macFor("test042"), macFor("test042"));
  assert.match(macFor("test042"), /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
});
