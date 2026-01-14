const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nht");
// const moment = require("moment");
const moment = require("moment-timezone");

router.post("/get_production_daily", async (req, res) => {
  try {
    let data = await dbms.query(`
        
            `);
    res.json({ data: data[0], success: true });
  } catch (error) {
    res.json({ data: error, success: false });
  }
});

module.exports = router;
