const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment");

const time_start = "05:00";

router.post("/select", async (req, res) => {
  let { dateQuery } = req.body;
  try {
    // const response_select = await dbms.query(
    //   `

    //   `
    // );

    res.json({
      success: true,
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
