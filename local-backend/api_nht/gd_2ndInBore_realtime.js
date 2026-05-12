const express = require("express");
const router = express.Router();
const moment = require("moment");

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const store = require("./_store_gd");

const isInBoreMachine = (mc_no) => {
  const id = (mc_no || "").toUpperCase();
  return id.startsWith("IR") && id.endsWith("B");
};

const startTime = 7;

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

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
    const target_utl = item.target_utl || 0;

    const act_pd = item.prod_total || 0;
    const ng_pd = (item.ng_p || 0) + (item.ng_n || 0);
    const act_ct = item.eachct / 100 || 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_pd = act_pd - target_pd;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));

    const total_pd = act_pd + ng_pd;
    const curr_yield = total_pd > 0 ? Number(((act_pd / total_pd) * 100).toFixed(2)) : 0;

    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;
    const effective_time = total_time - plan_shutdown;

    const availability = effective_time > 0 ? Number(((sum_run / effective_time) * 100).toFixed(2)) : 0;
    const denom_perf = target_ct > 0 && effective_time > 0 ? effective_time / target_ct : 0;
    const performance = denom_perf > 0 ? Number(((total_pd / denom_perf) * 100).toFixed(2)) : 0;
    const oee = Number(((performance / 100) * (availability / 100) * (curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      subProcess: item.process.toUpperCase() + "-IB",
      status_alarm,
      target,
      target_pd,
      act_pd,
      diff_pd,
      act_ct,
      diff_ct,
      curr_yield,
      target_ct,
      target_utl,
      curr_utl,
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
    const [machines, runningTime] = await Promise.all([
      Promise.resolve(store.getSnapshot(isInBoreMachine)),
      store.getRunningTime(),
    ]);
    const dataArray = prepareRealtimeData(machines, runningTime, now);
    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.target_pd || 0;
        acc.total_ok += item.act_pd || 0;
        acc.total_cycle_t += item.act_ct || 0;
        acc.total_utl += item.curr_utl || 0;
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
