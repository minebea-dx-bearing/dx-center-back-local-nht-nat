/**
 * CANONICAL EXAMPLE — Route Pattern R3: Filtered subset + Family E multi-loader store
 * See docs/realtime-developer-guide.md §5.3 before copying this file.
 *
 * Pattern: one store (_store_2gd) serves 5 routes. This route filters to InBore
 *          machines only (IR* ending in "B") via getSnapshot(isInBoreMachine).
 *          Uses getRunningTimeWithPlanStop — the sibling OutSuper uses getRunningTimeRunOnly.
 */
const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_2gd_ir");
// const store = require("./_store_2gd");

const isInBoreMachine = (mc_no) => {
  const id = (mc_no || "").toUpperCase();
  return id.startsWith("IR") && id.endsWith("B");
};

const startTime = 7;//* reset at 7 o'clock, same as other 2GD machines

const prepareRealtimeData = (machines, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(machines).map((item) => {
    // console.log(item.mc_no,item.alarm)
    const status_alarm = determineMachineStatus(item, item.status, item.occurred, "status");

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const target_ct = item.target_ct || 0;
    const target_utl = item.target_utl || 0;

    const total_pd = item.prod_total || 0;
    const ng_pd = (item.ng_p || 0) + (item.ng_n || 0) + (item.tng || 0) + (item.ng_plug || 0);
    const act_pd = total_pd - ng_pd;
    const act_ct = item.eachct / 100 || 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_ct = Number((act_ct - target_ct).toFixed(2));
    
    const diff_pd = total_pd - target_pd;
    const curr_yield = Number((item.yield_ok / 10).toFixed(2));

    const denom_utl = target_ct > 0 ? (elapsedSec * item.ring_factor) / target_ct : 0;
    const curr_utl = denom_utl > 0 ? Number(((total_pd / denom_utl) * 100).toFixed(2)) : 0;

    // ----- OEE -----
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    // console.log(runInfo)
    const act_opn_time = runInfo.sum_duration || 0;
    const total_work_time = runInfo.total_time || 0;
    const plan_stop = runInfo.sum_planstop_duration || 0;
    const production_count = act_pd + ng_pd || 0;
    // console.log(item.mc_no, act_opn_time)

    const availability = Number(((act_opn_time / (total_work_time - plan_stop)) * 100).toFixed(2)) || 0;
    // console.log(target_ct, production_count,act_opn_time , item.ring_factor)
    const performance = Number((((target_ct * production_count) / (act_opn_time * item.ring_factor)) * 100).toFixed(2)) || 0;
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
      total_pd,
      act_pd,
      diff_pd,
      act_ct,
      diff_ct,
      curr_yield,
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

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines: () => store.getSnapshot(isInBoreMachine),
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
