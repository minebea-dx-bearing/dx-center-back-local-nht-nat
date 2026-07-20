const express = require("express");
const router = express.Router();
const moment = require("moment");

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("AOD");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const status_alarm = determineMachineStatus(item, item.status, item.occurred, item.mqtt_status);

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
    const target_ct = item.target_ct || 0;

    const act_pd = item.daily_ok || 0;
    const ng_pd = item.daily_ag || 0;
    const cycle_t = item.cycle_t / 100 || 0;

    const target_actual = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const total_pd = act_pd + ng_pd;
    const diff_prod = act_pd - target_actual;
    const diff_ct = Number((cycle_t - target_ct).toFixed(2));

    const yield_rate = Number(((act_pd / (act_pd + ng_pd)) * 100 || 0).toFixed(2));

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const denom_perf = target_ct > 0 && total_time - plan_shutdown > 0 ? (total_time - plan_shutdown) / target_ct : 0;
    const performance = denom_perf > 0 ? Number((((act_pd + ng_pd) / denom_perf) * 100).toFixed(2)) || 0 : 0;
    const oee = Number(((performance / 100) * (availability / 100) * (yield_rate / 100) * 100).toFixed(2)) || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      status_alarm,
      target,
      target_actual,
      total_pd,
      diff_prod,
      act_pd,
      ng_pd,
      yield_rate,
      target_ct,
      diff_ct,
      cycle_t,
      sum_run,
      total_time,
      opn,
      downtime_seconds,
      plan_shutdown,
      availability,
      performance,
      oee,
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
        acc.total_target += item.target_actual || 0;
        acc.total_ok += item.act_pd || 0;
        acc.total_cycle_t += item.cycle_t || 0;
        acc.total_opn += item.opn || 0;
        acc.count += 1;
        return acc;
      },
      { total_target: 0, total_ok: 0, total_cycle_t: 0, total_opn: 0, count: 0 },
    );

    const resultSummary = {
      sum_target: summary.total_target,
      sum_daily: summary.total_ok,
      avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
      avg_opn: summary.count > 0 ? Number((summary.total_opn / summary.count).toFixed(2)) : 0,
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
