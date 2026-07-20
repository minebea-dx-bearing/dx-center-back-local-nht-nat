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

const startTime = 5;

const prepareRealtimeData = (machines, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime, 30);

  return Object.values(machines).map((item) => {
    const status_alarm = determineMachineStatus(item, item.alarm, item.occurred, item.mqtt_alarm);

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

    const diff_ct = Number((act_ct - target_ct).toFixed(2));
    
    const total_pd = act_pd + ng_pd;
    const diff_pd = total_pd - target_pd;
    const curr_yield = total_pd > 0 ? Number(((act_pd / total_pd) * 100).toFixed(2)) : 0;

    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) : 0;

    // ----- OEE -----
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const act_opn_time = runInfo.sum_duration || 0;
    const total_work_time = runInfo.total_time || 0;
    const plan_stop = runInfo.sum_planstop_duration || 0;
    const production_count = act_pd + ng_pd || 0;

    const availability = Number(((act_opn_time / (total_work_time - plan_stop)) * 100).toFixed(2)) || 0;
    const performance = Number((((target_ct * production_count) / (act_opn_time * item.ring_factor)) * 100).toFixed(2)) || 0;
    const oee = Number(((performance / 100) * (availability / 100) * (curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      status_alarm,
      target,
      target_pd,
      total_pd,
      act_pd,
      diff_pd,
      drop,
      act_ct,
      diff_ct,
      target_ct,
      target_utl,
      curr_utl,
      availability,
      performance,
      quality: curr_yield,
      oee,
    };
  });
};

router.get( "/machines",
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
