const moment = require("moment-timezone");

const TZ = "Asia/Bangkok";

/**
 * Minutes before fire time that the read window opens.
 *
 * The PLC latches shift_m_* at ~18:05 and shift_n_* at ~06:05. With the job
 * firing at :10, a 3-minute window spans :07-:10 — safely after the latch,
 * and wide enough that any live machine (publishing every ~2s) lands ~90
 * points in it. If machines start getting skipped, the latch is running late:
 * move JOB_MINUTE to 15 rather than widening this, because a window that
 * reaches back before the latch reintroduces the stale-read hazard.
 */
const WINDOW_MIN = 3;

const SHIFTS = {
  // Fired at 18:10 -> closes the morning shift that began 06:00 the same day.
  18: { shift: 1, okField: "shift_m_ok", ngField: "shift_m_ng", dateOffsetDays: 0 },
  // Fired at 06:10 -> closes the night shift that began 18:00 the day before.
  6: { shift: 2, okField: "shift_n_ok", ngField: "shift_n_ng", dateOffsetDays: -1 },
};

/**
 * The hours the scheduler must fire at are exactly the hours SHIFTS knows how
 * to resolve. Deriving them keeps the two from drifting apart — a hardcoded
 * list in the scheduler fails silently (a new shift never gets scheduled, with
 * no error at startup) or fails 12 hours late (an unknown hour fires and
 * throws inside a caught handler).
 */
const SHIFT_CLOSE_HOURS = Object.keys(SHIFTS).map(Number);

/**
 * Map a fire time to everything the collector and writer need.
 *
 * Pure — no I/O, no clock reads, no side effects. The fire time is passed in
 * explicitly so both the scheduler and the backfill endpoint can drive it.
 *
 * @param {moment.MomentInput} fireTime  moment the job fired (any zone; normalised to Bangkok)
 * @returns {{shift_date: string, shift: number, okField: string, ngField: string,
 *            windowStartUtc: string, windowEndUtc: string}}
 * @throws {Error} if fireTime is not within a recognised shift-close hour
 */
const resolveShiftContext = (fireTime) => {
  const fire = moment.tz(fireTime, TZ);
  const spec = SHIFTS[fire.hour()];

  if (!spec) {
    throw new Error(
      `resolveShiftContext: ${fire.format()} is not a shift-close time (expected hour 06 or 18 in ${TZ})`
    );
  }

  return {
    shift_date: moment(fire).add(spec.dateOffsetDays, "days").format("YYYY-MM-DD"),
    shift: spec.shift,
    okField: spec.okField,
    ngField: spec.ngField,
    windowStartUtc: moment(fire).subtract(WINDOW_MIN, "minutes").utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
    windowEndUtc: moment(fire).utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
  };
};

module.exports = { resolveShiftContext, SHIFT_CLOSE_HOURS, TZ, WINDOW_MIN };
