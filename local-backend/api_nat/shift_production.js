const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");
const { runShiftSummary } = require("../services/shiftSummary/shiftSummaryJob");

/**
 * POST /nat/shift-production/backfill?date=2026-08-06&shift=1
 *
 * Re-runs the snapshot for a past shift. Safe to call repeatedly — the
 * underlying MERGE is idempotent.
 *
 * Only valid until the PLC re-latches that field (~24h), after which the
 * source value in InfluxDB has been overwritten and is unrecoverable.
 */
router.post("/backfill", async (req, res) => {
  const { date, shift } = req.query;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !["1", "2"].includes(shift)) {
    return res
      .status(400)
      .json({ success: false, message: "date=YYYY-MM-DD and shift=1|2 are required" });
  }

  // Reconstruct the fire time this shift would have had:
  //   shift 1 closes at 18:10 on shift_date; shift 2 closes at 06:10 the NEXT day.
  const fire =
    shift === "1"
      ? moment.tz(`${date} 18:10:00`, "Asia/Bangkok")
      : moment.tz(`${date} 06:10:00`, "Asia/Bangkok").add(1, "day");

  const result = await runShiftSummary(fire);
  res.status(result.ok ? 200 : 500).json(result);
});

module.exports = router;
