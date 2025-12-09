const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
// const moment = require("moment");
const moment = require("moment-timezone");

router.post("/table_production_mbr_unmatch", async (req, res) => {
  try {
    const today = moment().tz("Asia/Bangkok").format("YYYY-MM-DD");
    console.log(
      "table_production MBR NG...",
      moment().format("YYYY-MM-DD"),
      parseInt(moment().format("HH"), 10),
      "parseInt...",
      parseInt(moment().tz("Asia/Bangkok").format("HH"), 10),
      req.body
    );
    console.log("today: ", today, " moment: ", moment().format("YYYY-MM-DD"));

    if (req.body.date === today) {
      // shift all
      result = await dbms.query(` 
    WITH datang AS (
        SELECT
            convert(varchar,[registered], 120) AS at_date,
            UPPER([mc_no]) AS mcno,
            model,
    [a_meas],
    [b_meas],
            match,
    [a_ng],
    [a_ng_pos],
    [a_ng_neg],
    [b_ng],
    [b_ng_pos],
    [b_ng_neg],
    [a_unm],
    [b_unm],
    [c1],
    [c2],
    [c3],
    [c4],
    [c5],
    [cycle_time] / 100 AS ct,
    [a_ok_lo_limit],
    [a_ok_hi_limit],
    [b_ok_lo_limit],
    [b_ok_hi_limit],
    [rp_target],
    [spec],
            ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY registered DESC) AS RowNum
        FROM
    [nat_mc_assy_mbr_f].[dbo].[DATA_PRODUCTION_MBR_F]
        WHERE
            format(iif (DATEPART (HOUR,[registered]) < 7, dateadd (day, -1,[registered]),[registered]), 'yyyy-MM-dd') = '${req.body.date}'
    )
    SELECT
        *
    FROM
        datang
    WHERE
        RowNum = 1
    ORDER BY
        mcno ASC

    `);
      res.json({ success: true, data: result[0] });
    } else {
      let date = "";
      if (parseInt(moment().tz("Asia/Bangkok").format("HH"), 10) < 7) {
        date = moment().subtract(1, "day").format("YYYY-MM-DD");
      } else {
        date = req.body.date;
      }
      let seriesOutput = [];
      let result = [];

      if (req.body.shift === "N") {
        console.log(" NN NN NN ...", date);

        result = await dbms.query(` 
    WITH datang AS (
        SELECT
            convert(varchar,[registered], 120) AS at_date,
            UPPER([mc_no]) AS mcno,
            model,
    [a_meas],
    [b_meas],
            MATCH,
    [a_ng],
    [a_ng_pos],
    [a_ng_neg],
    [b_ng],
    [b_ng_pos],
    [b_ng_neg],
    [a_unm],
    [b_unm],
    [c1],
    [c2],
    [c3],
    [c4],
    [c5],
    [cycle_time] / 100 AS ct,
    [a_ok_lo_limit],
    [a_ok_hi_limit],
    [b_ok_lo_limit],
    [b_ok_hi_limit],
    [rp_target],
    [spec],
            ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY registered DESC) AS RowNum
        FROM
    [nat_mc_assy_mbr_f].[dbo].[DATA_PRODUCTION_MBR_F]
        WHERE
            format(iif (DATEPART (HOUR,[registered]) < 7, dateadd (day, -1,[registered]),[registered]), 'yyyy-MM-dd') = '${req.body.date}'
            AND DATEPART (HOUR, registered) IN (18, 6))
    SELECT
        *
    FROM
        datang
    WHERE
        RowNum IN (1, 2)
    ORDER BY
        mcno ASC,
        at_date ASC

    `);
        // console.log(result);

        const data1 = result[0];
        for (let i = 0; i < data1.length - 1; i++) {
          const current = data1[i];
          const next = data1[i + 1];

          if (current.mcno === next.mcno) {
            const a_gaugeDiff = Math.max(0, next.a_gauge - current.a_gauge);
            const b_gaugeDiff = Math.max(0, next.b_gauge - current.b_gauge);
            const matchDiff = Math.max(0, next.match - current.match);
            const daily_okDiff = Math.max(0, next.daily_ok - current.daily_ok);
            const daily_ngDiff = Math.max(0, next.daily_ng - current.daily_ng);
            // const daily_ttDiff = Math.max(0, next.daily_tt - current.daily_tt);
            const or_ng_pDiff = Math.max(0, next.or_ng_p - current.or_ng_p);
            const or_ng_nDiff = Math.max(0, next.or_ng_n - current.or_ng_n);
            const ir_ng_pDiff = Math.max(0, next.ir_ng_p - current.ir_ng_p);
            const ir_ng_nDiff = Math.max(0, next.ir_ng_n - current.ir_ng_n);
            const or_unmDiff = Math.max(0, next.or_unm - current.or_unm);
            const ir_unmDiff = Math.max(0, next.ir_unm - current.ir_unm);
            const ball_qDiff = Math.max(0, next.ball_q - current.ball_q);
            const ball_angDiff = Math.max(0, next.ball_ang - current.ball_ang);
            const sep_ng_1Diff = Math.max(0, next.sep_ng_1 - current.sep_ng_1);
            const sep_ng_2Diff = Math.max(0, next.sep_ng_2 - current.sep_ng_2);
            const mn_ngDiff = Math.max(0, next.mn_ng - current.mn_ng);
            const d1_ngDiff = Math.max(0, next.d1_ng - current.d1_ng);
            const d2_ngDiff = Math.max(0, next.d2_ng - current.d2_ng);
            const pre_p_ngDiff = Math.max(0, next.pre_p_ng - current.pre_p_ng);
            const nail_ngDiff = Math.max(0, next.nail_ng - current.nail_ng);
            // const cycle_tDiff = (next.cycle_t + current.cycle_t)/2;
            // const target_uDiff = Math.max(0, next.target_u - current.target_u);
            const error_tDiff = Math.max(0, next.error_t - current.error_t);
            const alarm_tDiff = Math.max(0, next.alarm_t - current.alarm_t);
            const run_tDiff = Math.max(0, next.run_t - current.run_t);
            const stop_tDiff = Math.max(0, next.stop_t - current.stop_t);
            const w_ball_tDiff = Math.max(0, next.w_ball_t - current.w_ball_t);
            const w_ir_tDiff = Math.max(0, next.w_ir_t - current.w_ir_t);
            const w_or_tDiff = Math.max(0, next.w_or_t - current.w_or_t);
            const w_rtnr_tDiff = Math.max(0, next.w_rtnr_t - current.w_rtnr_t);
            const full_p_tDiff = Math.max(0, next.full_p_t - current.full_p_t);
            const adjust_tDiff = Math.max(0, next.adjust_t - current.adjust_t);
            const plan_s_tDiff = Math.max(0, next.plan_s_t - current.plan_s_t);
            const m_p_ngDiff = Math.max(0, next.m_p_ng - current.m_p_ng);
            const set_up_tDiff = Math.max(0, next.set_up_t - current.set_up_t);
            const yieldDiff = (next.yield + current.yield) / 2;

            // const UTLtargetDiff = next.UTL && next.UTL !== 0 ? (prodTotalDiff / next.UTL) * 100 : 0;
            // const avgCt = (next.ct + current.ct) / 2;

            seriesOutput.push({
              mcno: current.mcno,
              model: current.model,
              a_gauge: a_gaugeDiff,
              b_gauge: b_gaugeDiff,
              match: matchDiff,
              daily_ok: daily_okDiff,
              daily_ng: daily_ngDiff,
              or_ng_p: or_ng_pDiff,
              or_ng_n: or_ng_nDiff,
              ir_ng_p: ir_ng_pDiff,
              ir_ng_n: ir_ng_nDiff,
              or_unm: or_unmDiff,
              ir_unm: ir_unmDiff,
              error_t: error_tDiff,
              alarm_t: alarm_tDiff,
              run_t: run_tDiff,
              stop_t: stop_tDiff,
              w_or_t: w_or_tDiff,
              w_ir_t: w_ir_tDiff,
              w_ball_t: w_ball_tDiff,
              w_rtnr_t: w_rtnr_tDiff,
              full_p_t: full_p_tDiff,
              adjust_t: adjust_tDiff,
              set_up_t: set_up_tDiff,
              plan_s_t: plan_s_tDiff,
              ball_q: ball_qDiff,
              ball_ang: ball_angDiff,
              sep_ng_1: sep_ng_1Diff,
              sep_ng_2: sep_ng_2Diff,
              mn_ng: mn_ngDiff,
              d1_ng: d1_ngDiff,
              d2_ng: d2_ngDiff,
              pre_p_ng: pre_p_ngDiff,
              m_p_ng: m_p_ngDiff,
              nail_ng: nail_ngDiff,
              yield: yieldDiff,

              // , production_total: prodTotalDiff,
              // production_ok: prodOkDiff,
              // production_ng: prodNgDiff,
              // wait_ir: wait_irDiff,
              // wait_or: wait_orDiff,
              // wait_ball: wait_ballDiff,
              // wait_rtnr: wait_rtnrDiff,
              // DT: downTimeDiff,
              // UTL: UTLtargetDiff.toFixed(2),

              // ct: avgCt.toFixed(2),
              // yield: avgYield.toFixed(2),
              // bg_utl: UTLtargetDiff < 80 ? "red" : UTLtargetDiff > 80 ? "green" : "",
              // bg_yield: avgYield < 97 ? "red" : "",
              // bg_ct: avgCt > 3.5 ? "red" : "",
              // // at_time: "06:00",
              // // bg_utl: bg_utl,
              // // bg_yield: bg_yield,
              // // bg_ct: bg_ct,
              at_date: moment(next.at_date).format("YYYY-MM-DD HH:mm"),
            });
          }
        }
        // console.log("seriesOutput NNN...", seriesOutput);
      } else if (req.body.shift === "M") {
        console.log(" MM MM MM ...");
        result = await dbms.query(` 
            WITH datang AS (
                SELECT
                    convert(varchar,[registered], 120) AS at_date,
                    UPPER([mc_no]) AS mcno,
                    model,
            [a_meas],
            [b_meas],
                    MATCH,
            [a_ng],
            [a_ng_pos],
            [a_ng_neg],
            [b_ng],
            [b_ng_pos],
            [b_ng_neg],
            [a_unm],
            [b_unm],
            [c1],
            [c2],
            [c3],
            [c4],
            [c5],
            [cycle_time] / 100 AS ct,
            [a_ok_lo_limit],
            [a_ok_hi_limit],
            [b_ok_lo_limit],
            [b_ok_hi_limit],
            [rp_target],
            [spec],
                    ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY registered DESC) AS RowNum
                FROM
            [nat_mc_assy_mbr_f].[dbo].[DATA_PRODUCTION_MBR_F]
                WHERE
                    format(iif (DATEPART (HOUR,[registered]) < 7, dateadd (day, -1,[registered]),[registered]), 'yyyy-MM-dd') = '${req.body.date}'
                    AND DATEPART (HOUR, registered) IN (18))
            SELECT
                *
            FROM
                datang
            WHERE
                RowNum IN (1)
            ORDER BY
                mcno ASC

    `);
        seriesOutput = result[0];
      } else {
        console.log(" ALL ");
        result = await dbms.query(` 
        WITH datang AS (
            SELECT
                convert(varchar,[registered], 120) AS at_date,
                UPPER([mc_no]) AS mcno,
                model,
        [a_meas],
        [b_meas],
                MATCH,
        [a_ng],
        [a_ng_pos],
        [a_ng_neg],
        [b_ng],
        [b_ng_pos],
        [b_ng_neg],
        [a_unm],
        [b_unm],
        [c1],
        [c2],
        [c3],
        [c4],
        [c5],
        [cycle_time] / 100 AS ct,
        [a_ok_lo_limit],
        [a_ok_hi_limit],
        [b_ok_lo_limit],
        [b_ok_hi_limit],
        [rp_target],
        [spec],
                ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY registered DESC) AS RowNum
            FROM
        [nat_mc_assy_mbr_f].[dbo].[DATA_PRODUCTION_MBR_F]
            WHERE
                format(iif (DATEPART (HOUR,[registered]) < 7, dateadd (day, -1,[registered]),[registered]), 'yyyy-MM-dd') = '${req.body.date}'
                AND DATEPART (HOUR, registered) IN (6))
        SELECT
            *
        FROM
            datang
        WHERE
            RowNum IN (1)
        ORDER BY
            mcno ASC

    `);
        seriesOutput = result[0];
      }

      res.json({ success: true, data: seriesOutput });
    }
    // console.log("lllll", resultOutput);
  } catch (error) {
    console.log("qc error", error);
    res.json({
      data: error,
      success: false,
    });
  }
});

module.exports = router;
