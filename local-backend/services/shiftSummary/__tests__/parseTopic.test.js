const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTopic } = require("../parseTopic");

test("extracts process and machine number", () => {
  assert.deepEqual(parseTopic("data/hat/abc/acd01"), { process: "abc", mc_no: "acd01" });
});

// An unexpected topic shape must not silently produce a row with garbage keys,
// because process + mc_no are part of the primary key.
test("returns null for a topic with the wrong segment count", () => {
  assert.equal(parseTopic("data/hat/abc"), null);
  assert.equal(parseTopic("data/hat/abc/acd01/extra"), null);
  assert.equal(parseTopic(""), null);
});

test("returns null when a segment is empty", () => {
  assert.equal(parseTopic("data/hat//acd01"), null);
});
