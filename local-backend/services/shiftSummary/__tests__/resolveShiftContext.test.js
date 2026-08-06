const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");

const { resolveShiftContext } = require("../resolveShiftContext");

// 18:10 Bangkok closes the MORNING shift that started the same day at 06:00.
test("evening run resolves to shift 1 on the same calendar date", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 18:10:00", "Asia/Bangkok"));

  assert.equal(ctx.shift, 1);
  assert.equal(ctx.shift_date, "2026-08-06");
  assert.equal(ctx.okField, "shift_m_ok");
  assert.equal(ctx.ngField, "shift_m_ng");
});

// 06:10 Bangkok closes the NIGHT shift that started the PREVIOUS day at 18:00.
test("morning run resolves to shift 2 dated the previous day", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 06:10:00", "Asia/Bangkok"));

  assert.equal(ctx.shift, 2);
  assert.equal(ctx.shift_date, "2026-08-05");
  assert.equal(ctx.okField, "shift_n_ok");
  assert.equal(ctx.ngField, "shift_n_ng");
});

// The window must START AFTER the ~18:05 / ~06:05 latch, or a dead machine's
// stale value gets read as if it were fresh.
test("window opens after the latch and closes at fire time, in UTC", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 18:10:00", "Asia/Bangkok"));

  assert.equal(ctx.windowStartUtc, "2026-08-06T11:07:00Z"); // 18:07 +07
  assert.equal(ctx.windowEndUtc, "2026-08-06T11:10:00Z");   // 18:10 +07
});

test("window is correct across the UTC date boundary on the morning run", () => {
  const ctx = resolveShiftContext(moment.tz("2026-08-06 06:10:00", "Asia/Bangkok"));

  assert.equal(ctx.windowStartUtc, "2026-08-05T23:07:00Z"); // previous UTC day
  assert.equal(ctx.windowEndUtc, "2026-08-05T23:10:00Z");
});

// Guard against a hand-triggered backfill at a nonsense hour silently
// producing a wrong shift instead of failing loudly.
test("throws when fired outside a recognised shift-close hour", () => {
  assert.throws(
    () => resolveShiftContext(moment.tz("2026-08-06 12:00:00", "Asia/Bangkok")),
    /not a shift-close/i
  );
});
