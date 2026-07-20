const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment-timezone");
const getData = require("../util/analysis_2gd")

const DATABASE_PROD = "[nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]";
const DATABASE_ALARM = "[nat_mc_mcshop_2gd].[dbo].[DATA_ALARMLIS_2GD]";
const DATABASE_STATUS = "[nat_mc_mcshop_2gd].[dbo].[DATA_MCSTATUS_2GD]";
const DATABASE_IOT = "[nat_mc_mcshop_2gd].[dbo].[MONITOR_IOT]";
const DATABASE_MASTER = "[nat_mc_mcshop_2gd].[dbo].[DATA_MASTER_2GD]";

const COLUMN_OK = "[prod_total] - ([ng_p] + [ng_n] + [tng] + [ng_plug])";
const COLUMN_NG = "[ng_p] + [ng_n] + [tng] + [ng_plug]";
const COLUMN_TOTAL = `(${COLUMN_OK} + ${COLUMN_NG})`;
const COLUMN_CT = "[eachct]";

// MASTER MACHINE NO.
router.get("/master_machine", async (req, res) => {
  try {
    let master = await dbms.query(
      `
        SELECT DISTINCT(UPPER(mc_no)) AS mc_no
        FROM ${DATABASE_PROD}
        WHERE [mc_no] LIKE 'IR%B' -- มีเฉพาะเครื่อง 2nd In Bore
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
    const result = await getData.productionByHour(DATABASE_PROD, COLUMN_OK, COLUMN_TOTAL, COLUMN_CT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

router.get("/status/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    const result = await getData.status(DATABASE_PROD, DATABASE_STATUS, DATABASE_IOT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  try {
    const { mc_no, date } = req.params;
    const result = await getData.productionDaily(DATABASE_PROD, DATABASE_MASTER, COLUMN_TOTAL, COLUMN_OK, COLUMN_NG, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
