const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_2gd");

const isOutSuperMachine = (mc_no) => {
  const id = (mc_no || "").toUpperCase();
  return id.startsWith("OR") && id.endsWith("H");
};

const startTime = 7;

const prepareRealtimeData = (machines, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(machines).map((item) => {
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
    const ng_pd = 0;
    const act_ct = item.cth2 / 100 || 0;

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

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines: () => store.getSnapshot(isOutSuperMachine),
    getRunningTime: store.getRunningTimeRunOnly,
    prepareRealtimeData,
    summary: "standard",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTimeRunOnly,
  getMachineData: () => store.getRawMap(),
};
