const schedule = require("node-schedule");
const { resolveShiftContext, SHIFT_CLOSE_HOURS, TZ } = require("./resolveShiftContext");
const { collectShiftTotals } = require("./collectShiftTotals");
const { persistShiftTotals } = require("./persistShiftTotals");

// Both shifts close at :10 past the hour, ~5 minutes after the PLC latch.
// If machines start getting skipped as offline, the latch is running late —
// raise this to 15 (and see WINDOW_MIN in resolveShiftContext.js).
const JOB_MINUTE = 10;

/**
 * Collect and persist one shift's production totals.
 *
 * Single entry point for both the scheduler and the backfill endpoint, so the
 * two paths cannot drift apart.
 *
 * Errors are caught and logged rather than rethrown: an unhandled rejection
 * inside a node-schedule callback would take down the whole process, which
 * also serves every API route in this backend. Recovery is via backfill, which
 * stays valid for ~24h because the PLC counters are latched.
 */
const runShiftSummary = async (fireTime) => {
  const startedAt = Date.now();

  try {
    const ctx = resolveShiftContext(fireTime);
    const rows = await collectShiftTotals(ctx);
    const written = await persistShiftTotals(ctx, rows);

    console.log(
      `[shiftSummary] ${ctx.shift_date} shift ${ctx.shift}: ${written} machines in ${Date.now() - startedAt}ms`
    );
    return { ok: true, shift_date: ctx.shift_date, shift: ctx.shift, written };
  } catch (error) {
    console.error("[shiftSummary] run failed:", error.message);
    return { ok: false, message: error.message };
  }
};

const registerShiftSummaryJobs = () =>
  SHIFT_CLOSE_HOURS.map((hour) => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = hour;
    rule.minute = JOB_MINUTE;
    rule.tz = TZ;

    // node-schedule passes the SCHEDULED fire time, not Date.now(). That matters:
    // if the event loop is busy the callback may run late, and we want the shift
    // resolved from the intended time, not the delayed one.
    const job = schedule.scheduleJob(`shiftSummary-${hour}`, rule, (fireDate) =>
      runShiftSummary(fireDate)
    );

    if (!job) throw new Error(`registerShiftSummaryJobs: failed to schedule hour ${hour}`);

    console.log(`[shiftSummary] scheduled ${String(hour).padStart(2, "0")}:${JOB_MINUTE} ${TZ}`);
    return job;
  });

module.exports = { runShiftSummary, registerShiftSummaryJobs };
