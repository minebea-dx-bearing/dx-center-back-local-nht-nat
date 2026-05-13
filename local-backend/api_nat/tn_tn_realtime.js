/**
 * CANONICAL EXAMPLE — Route Pattern R4: Off-hour shift (05:30) + runOnly mode
 * See docs/realtime-developer-guide.md §5.4 before copying this file.
 *
 * Pattern: shift starts at 05:30 — pass startMinute=30 as the third arg to shiftWindow().
 *          Running-time uses mode:"runOnly" so sum_planshutdown_duration is absent;
 *          default plan_shutdown to 0 when computing effective_time.
 */
const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_tn");

// Turning start time at 05:30
const startTimeHour = 5;
const startTimeMinute = 30;

const prepareRealtimeData = (machines, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTimeHour, startTimeMinute);

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

    const act_pd = item.prod_pos4 + item.prod_pos6 || 0;
    const drop = item.prod_drop_pos4 + item.prod_drop_pos6 || 0;
    const ng_pd = 0;
    const act_ct = item.cycle_time / 100 || 0;

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
      drop,
      act_ct,
      diff_ct,
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
    getMachines: () => store.getSnapshot(),
    getRunningTime: store.getRunningTime,
    prepareRealtimeData,
    summary: "standard",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
