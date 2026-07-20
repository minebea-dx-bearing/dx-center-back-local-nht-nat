const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nht");
const moment = require("moment-timezone");
const getData = require("../util/analysis_assy")

const DATABASE_PROD = "[data_machine_avs].[dbo].[DATA_PRODUCTION_AVS]";
const DATABASE_ALARM = "[data_machine_avs].[dbo].[DATA_ALARMLIS_AVS]";
const DATABASE_STATUS = "[data_machine_avs].[dbo].[DATA_MCSTATUS_AVS]";
const DATABASE_IOT = "[data_machine_avs].[dbo].[MONITOR_IOT]";
const DATABASE_MASTER = "[data_machine_avs].[dbo].[DATA_MASTER_AVS]";

const COLUMN_OK = "[ok]";
const COLUMN_NG = "[ng_1] + [ng_2]";
const COLUMN_TOTAL = `(${COLUMN_OK} + ${COLUMN_NG})`;
const COLUMN_CT = "[cycletime]";

// MASTER MACHINE NO.
router.get("/master_machine", async (req, res) => {
  try {
    let master = await dbms.query(
      `
        SELECT DISTINCT(UPPER(mc_no)) AS mc_no
        FROM ${DATABASE_PROD}
        ORDER BY mc_no ASC
      `
    );

    res.json({ data: master[0], success: true, message: "ok" });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

// PRODUCTION BY HOUR
router.get("/production_hour_by_mc/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    const result = await getData.productionByHour(dbms, DATABASE_PROD, COLUMN_OK, COLUMN_TOTAL, COLUMN_CT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

router.get("/status/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    const result = await getData.status(dbms, DATABASE_PROD, DATABASE_STATUS, DATABASE_IOT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  try {
    const { mc_no, date } = req.params;
    const result = await getData.productionDaily(dbms, DATABASE_PROD, DATABASE_MASTER, COLUMN_TOTAL, COLUMN_OK, COLUMN_NG, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
