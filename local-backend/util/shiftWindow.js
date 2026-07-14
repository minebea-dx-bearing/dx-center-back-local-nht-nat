const moment = require("moment");

/**
 * Compute the current shift window relative to a reference moment.
 *
 * A shift is defined as starting at HH:MM each day and lasting 24 hours.
 * If `now` is before today's HH:MM, we are still inside YESTERDAY's shift,
 * so the anchor is rolled back one day.
 *
 * Pure function — no I/O, no side effects, safe to unit test.
 *
 * @param {moment.MomentInput} now           reference moment (e.g. moment() or moment(item.updated_at))
 * @param {number}             startHour     shift start hour, 0-23
 * @param {number}             [startMinute] shift start minute, 0-59 (default 0)
 * @returns {{ start_time: moment.Moment, elapsedMin: number, elapsedSec: number }}
 *          start_time is the shift anchor;
 *          elapsedMin/elapsedSec are clamped to >= 0 to defend against clock skew.
 */
const shiftWindow = (now, startHour, startMinute = 0) => {
  const ref = moment(now); //! use local time bangkok time zone, not UTC, to align with factory operations and avoid confusion around DST changes
  const todaysStart = moment(ref).startOf("day").hour(startHour).minute(startMinute);
  const start_time = ref.isBefore(todaysStart) ? moment(todaysStart).subtract(1, "day") : todaysStart;

  return {
    start_time,
    elapsedMin: Math.max(ref.diff(start_time, "minutes"), 0),
    elapsedSec: Math.max(ref.diff(start_time, "second"), 0),
  };
};

module.exports = shiftWindow;
