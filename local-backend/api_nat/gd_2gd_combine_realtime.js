//Reference
const express = require("express");
const router = express.Router();
// const NodeCache = require("node-cache");
// const myCache = new NodeCache({ stdTTL: 15 }); // cache 15 วินาที
const moment = require("moment-timezone");

const { getFullRealtime, realtimeCache } = require("./gd_2gd_mqttClient");
const dbNAT = require("../instance/ms_instance_nat");

// GET By TWN
router.get("/get_combined_data", async (req, res) => {
  try {
    console.log("date today", moment().format("YYYY-MM-DD"));

    const mcRes = await dbNAT.query(`
          WITH result AS (
            SELECT
                UPPER(m.[mc_no]) AS mc_no,
                LEFT (m.mc_no,
                    LEN (m.mc_no) - 1) AS group_id,
                RIGHT (m.mc_no,
                    1) AS line,
        UPPER([process]) AS process,
        [part_no],
        [target_ct],
        [target_utl],
        [target_yield],
        [target_special],
        [ring_factor],
                ROW_NUMBER() OVER (PARTITION BY p.mc_no ORDER BY p.registered DESC) AS rn
            FROM
        [nat_mc_mcshop_2gd].[dbo].[DATA_MASTER_2GD] m
                LEFT JOIN[nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD] p ON m.mc_no = p.mc_no
            WHERE
                format(iif (DATEPART (HOUR, p.[registered]) < 7, dateadd (day, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = '${moment().format(
                  "YYYY-MM-DD"
                )}')
        SELECT
            mc_no,
            UPPER(group_id) AS group_id,
            UPPER(line) AS line,
            part_no,
            [process],
        [target_ct],
        [target_utl],
        [target_yield],
        [target_special],
        [ring_factor]
        FROM
            result
        WHERE
            rn = 1
        ORDER BY
            mc_no ASC

    `);
    const mcList = mcRes[0];

    const [mqttRows] = await dbNAT.query(`
      WITH ranked_mqtt AS (
          SELECT
              UPPER(mc_no) AS mc_no,
              registered,
              TRY_CAST (TRY_CAST (broker AS float) AS int) AS broker,
              TRY_CAST (TRY_CAST (modbus AS float) AS int) AS modbus,
              mac_id,
              ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY registered DESC) AS rn
          FROM
      [nat_mc_mcshop_2gd].[dbo].[MONITOR_IOT]
          WHERE
              registered > DATEADD (MINUTE, -35, GETDATE ()))
      SELECT
          *
      FROM
          ranked_mqtt
      WHERE
          rn <= 6
      ORDER BY
          mc_no

    `);
    const mqttMap = {};

    for (const row of mqttRows) {
      const mcNo = row.mc_no.toLowerCase();
      if (!mqttMap[mcNo]) mqttMap[mcNo] = [];
      mqttMap[mcNo].push(row);
    }

    const results = {};
    for (const mc of mcList) {
      const mcBase = mc.mc_no.slice(0, -1);
      const type = mc.mc_no.slice(-1);
      if (!results[mcBase]) results[mcBase] = {};

      const mcNo = mc.mc_no.toUpperCase();

      // ดึง 10 แถวของ mc นี้จาก mqttRows
      const mqttForMc = mqttRows.filter((row) => row.mc_no === mcNo);

      let iot_broker = "no_signal";
      let iot_modbus = "no_signal";

      const cached = realtimeCache[mc.mc_no.toLowerCase()] || {};
      const mqttArray = mqttMap[mc.mc_no.toLowerCase()] || [];
      // console.log("Alarm: ",cached.alarm);

      if (mqttForMc.length > 0) {
        const brokers = mqttForMc.map((r) => Number(r.broker));
        const modbuses = mqttForMc.map((r) => Number(r.modbus));

        if (mqttArray.length > 0 && mqttArray[0].registered) {
          const timeInThailand = new Date(
            new Date(mqttArray[0].registered).getTime() + 7 * 3600 * 1000
          );
          const nowThailand = new Date(Date.now() + 7 * 3600 * 1000);
          const diffMinutes = Math.floor(
            (nowThailand - timeInThailand) / 1000 / 60
          );

          if (diffMinutes > 5) {
            iot_broker = "lost";
            iot_modbus = "lost";
          } else {
            if (brokers.includes(1) || brokers.includes("1")) {
              iot_broker = "on";
            } else if (brokers.every((val) => val == 0)) {
              iot_broker = "off";
            }

            if (modbuses.includes(1) || modbuses.includes("1")) {
              iot_modbus = "on";
            } else if (modbuses.every((val) => val == 0)) {
              iot_modbus = "off";
            }
          }
        }
      }
      // time จาก sql mqtt_iot
      const time_mqtt = mqttArray[0]?.registered
        ? (mqttArray[0]?.registered)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19)
        : "-";
      // time จาก influx
      // const time_mqtt = cached.lastUpdate
      //         ? new Date(new Date(cached.lastUpdate).getTime() + 7 * 3600 * 1000)
      //           .toISOString()
      //           .replace('T', ' ')
      //           .substring(0, 19)
      //         : '-';
      // console.log("cached ", mc);

      results[mcBase][type] = {
        mc_no: mcNo,
        group: mcBase,
        line_no: mc.line,
        process: mc.process,
        prod: cached.data?.prod_total || 0,
        prod_ng: (cached.data?.ng_p ?? 0) + (cached.data?.ng_n ?? 0) + (cached.data?.tng ?? 0),
        alarm: cached.alarm?.status || "-", // ดึงสถานะจาก mqtt status
        // status: cached.status?.status || "-", // ดึงสถานะจาก mqtt status
        // cycletime: parseFloat(((mc.line === "H" ? cached.data?.cth2 : cached.data?.eachct || 0) / 100).toFixed(2)),
        ct: parseFloat(((cached.data?.eachct || 0) / 100).toFixed(2)),
        ctH2: parseFloat(((cached.data?.cth2 || 0) / 100).toFixed(2)),
        iot_broker,
        iot_modbus,
        time_mqtt,
        prod_target: 0,
        yield: parseFloat(((cached.data?.yield_ok || 0) / 10).toFixed(2)) || 0,
        part_no: mc.part_no,
        target_ct: mc.target_ct,
        target_utl: mc.target_utl,
        target_yield: mc.target_yield,
        target_specia: mc.target_special,
        ring_factor: mc.ring_factor,
      };
    }

    const mergedList = [];
    Object.values(results).forEach((group) => {
      Object.values(group).forEach((machine) => {
        mergedList.push(machine);
      });
    });

    return res.json({ data: mergedList, api_result: "ok", });
  } catch (error) {
    console.error("get_time_status_gd error:", error.message);
    return res
      .status(500)
      .json({ data: error.message, api_result: "nok" });
  }
});

module.exports = router;
