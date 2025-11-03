const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment");
const sum_alarm = require("../util/sum_alarm");
const schedule = require("node-schedule");

const DATABASE_ALARM = "[nat_mc_assy_alu].[dbo].[DATA_ALARMLIS_ALU]";
const DATABASE_SUM_ALARM = "[nat_mc_assy_alu].[dbo].[DATA_SUM_ALARM_ALU]";

// let job = schedule.scheduleJob("*/5 * * * *", async () => {
//   await sum_alarm(dbms, DATABASE_ALARM, DATABASE_SUM_ALARM);
//   console.log(`Running task update data : ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
// });

router.get("/", async (req, res) => {
  try {
    const data_alarm = await sum_alarm(dbms, DATABASE_ALARM, DATABASE_SUM_ALARM);
    res.json({
      success: true,
      data_alarm,
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
