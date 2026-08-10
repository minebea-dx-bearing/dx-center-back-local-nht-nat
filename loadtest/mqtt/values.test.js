const { test } = require("node:test");
const assert = require("node:assert");
const { ALARM_VALUES, STATUS_VALUES } = require("./values");

test("alarm set matches the VM master table exactly", () => {
  assert.strictEqual(ALARM_VALUES.length, 60);
  assert.ok(ALARM_VALUES.includes("COVER OPEN"));
});

// These are stored truncated at the device. "Correcting" them to real words
// makes the VM's exact-match check discard the message silently.
test("upstream-truncated alarm strings are preserved verbatim", () => {
  assert.ok(ALARM_VALUES.includes("GEAR R.P.M NO SETTIN"));
  assert.ok(ALARM_VALUES.includes("INVERTER MAIN MOTO"));
  assert.ok(ALARM_VALUES.includes("EMERGENCE PUSHTBUT"));
  assert.ok(!ALARM_VALUES.includes("INVERTER MAIN MOTOR"));
});

test("status set is the lowercase publishable values only", () => {
  assert.deepStrictEqual(STATUS_VALUES, ["run", "stop", "wait", "alarm", "other"]);
});

// `offline` is derived downstream from staleness. Publishing it would be a
// device claiming a state only the server is allowed to conclude.
test("offline is not publishable", () => {
  assert.ok(!STATUS_VALUES.includes("offline"));
});
