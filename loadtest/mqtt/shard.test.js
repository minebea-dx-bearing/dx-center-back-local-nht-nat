const { test } = require("node:test");
const assert = require("node:assert");
const { shardFor } = require("./shard");

test("shards partition the device list with no gaps or overlaps", () => {
  const all = [];
  for (let w = 0; w < 4; w++) all.push(...shardFor(1000, 4, w));
  assert.strictEqual(all.length, 1000);
  assert.strictEqual(new Set(all).size, 1000);
});

test("uneven splits differ by at most one device", () => {
  const sizes = [0, 1, 2].map((w) => shardFor(1000, 3, w).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test("more workers than devices yields empty shards, not crashes", () => {
  assert.deepStrictEqual(shardFor(2, 4, 3), []);
});
