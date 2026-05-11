const express = require("express");
const router = express.Router();
const moment = require("moment");

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("MBR");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const s_status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const s_target_ct = item.target_ct || 0;
    const s_target_yield = item.target_yield || 0;
    const s_target_utl = item.target_utl || 0;

    const s_act_pd = item.daily_ok || 0;
    const s_ng_pd = item.daily_ng || 0;
    const s_act_ct = item.cycle_t / 100 || 0;

    const s_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const s_diff_pd = s_act_pd - s_target_pd;
    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));

    const s_total_pd = s_act_pd + s_ng_pd;
    const s_curr_yield = s_total_pd > 0 ? Number(((s_act_pd / s_total_pd) * 100).toFixed(2)) : 0;
    const yield_calc_total = s_total_pd > 0 ? Number(s_act_pd / s_total_pd) : 0;

    const s_denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = s_denom_utl > 0 ? Number(((s_total_pd / s_denom_utl) * 100).toFixed(2)) : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const s_downtime_seconds = total_time - sum_run - plan_shutdown;
    const effective_time = total_time - plan_shutdown;

    const availability = effective_time > 0 ? Number(((sum_run / effective_time) * 100).toFixed(2)) : 0;
    const s_denom_perf = s_target_ct > 0 && effective_time > 0 ? effective_time / s_target_ct : 0;
    const performance = s_denom_perf > 0 ? Number(((s_total_pd / s_denom_perf) * 100).toFixed(2)) : 0;
    const s_oee = Number(((performance / 100) * (availability / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      s_status_alarm,
      s_target_yield,
      target,
      s_target_pd,
      s_diff_pd,
      s_act_ct,
      s_target_ct,
      s_diff_ct,
      s_act_pd,
      s_curr_yield,
      s_curr_utl,
      s_target_utl,
      s_downtime_seconds,
      s_oee,
      f_yield_calc_total: yield_calc_total,
      s_yield_calc_total: yield_calc_total,
    };
  });
};

router.get("/machines", async (req, res) => {
  try {
    const now = moment();
    const [machines, runningTime] = await Promise.all([Promise.resolve(store.getRawMap()), store.getRunningTime()]);
    const dataArray = prepareRealtimeData(machines, runningTime, now);
    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.s_target_pd || 0;
        acc.total_ok += item.s_act_pd || 0;
        acc.total_cycle_t += item.s_act_ct || 0;
        acc.total_utl += item.s_curr_utl || 0;
        acc.count += 1;
        return acc;
      },
      { total_target: 0, total_ok: 0, total_cycle_t: 0, total_utl: 0, count: 0 },
    );

    const resultSummary = {
      sum_target: summary.total_target,
      sum_daily_ok: summary.total_ok,
      avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
      avg_utl: summary.count > 0 ? Number((summary.total_utl / summary.count).toFixed(2)) : 0,
    };
    res.json({ success: true, data: dataArray, resultSummary });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
