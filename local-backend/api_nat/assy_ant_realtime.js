/**
 * CANONICAL EXAMPLE — Route Pattern R2: Dual spindle
 * See docs/realtime-developer-guide.md §5.2 before copying this file.
 *
 * Pattern: two independent spindles (front/rear), each with its own OEE calc.
 * Store:   _store_ant.js (Family B singleton) — uses master_mc_no_front_rear and
 *          withPlanStopAnt mode, which adds alarm_base to running-time rows.
 *
 * Naming quirk: f_ prefix = Rear spindle, s_ prefix = Front spindle.
 * This is inherited from the original hardware naming; do not "fix" it.
 */
const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_ant");

const startTime = 6;

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  // f_ -> Rear spindle, s_ -> Front spindle (hardware naming — intentional)
  return Object.values(currentMachineData).map((item) => {
    const s_status_alarm = determineMachineStatus(item, item.alarm_front, item.occurred_front);
    const f_status_alarm = determineMachineStatus(item, item.alarm_rear, item.occurred_rear);

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    const runInfoFront = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN FRONT") || {};
    const sum_run_front = runInfoFront.sum_duration || 0;
    const total_time_front = runInfoFront.total_time || 0;
    const opn_front = total_time_front > 0 ? Number(((sum_run_front / total_time_front) * 100).toFixed(2)) : 0;

    const runInfoRear = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN REAR") || {};
    const sum_run_rear = runInfoRear.sum_duration || 0;
    const total_time_rear = runInfoRear.total_time || 0;
    const opn_rear = total_time_rear > 0 ? Number(((sum_run_rear / total_time_rear) * 100).toFixed(2)) : 0;

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const s_target_ct = item.target_ct || 0;
    const s_target_yield = item.target_yield || 0;
    const s_target_utl = item.target_utl || 0;

    const prod_ok = item.ok_front + item.ok_rear || 0;
    const prod_ng = item.ag_front + item.ng_front + item.mixball_front + item.ag_rear + item.ng_rear + item.mixball_rear || 0;
    const cycle_t = (item.cycle_time_front + item.cycle_time_rear) / 2 / 100 || 0;

    const f_act_pd = item.ok_rear;
    const s_act_pd = item.ok_front;

    const s_act_ct = item.cycle_time_front / 100 || 0;
    const f_act_ct = item.cycle_time_rear / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_prod = prod_ok - f_target_pd;
    const diff_ct = Number((cycle_t - s_target_ct).toFixed(2));

    const yield_rate = Number(((prod_ok / (prod_ok + prod_ng)) * 100 || 0).toFixed(2));

    const s_diff_pd = item.ok_front - f_target_pd;
    const f_diff_pd = item.ok_rear - f_target_pd;

    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));
    const f_diff_ct = Number((f_act_ct - s_target_ct).toFixed(2));

    const s_ng_pd = item.ag_front + item.ng_front + item.mixball_front;
    const f_ng_pd = item.ag_rear + item.ng_rear + item.mixball_rear;

    const front_total = item.ok_front + item.ag_front + item.ng_front + item.mixball_front;
    const rear_total = item.ok_rear + item.ag_rear + item.ng_rear + item.mixball_rear;
    const s_curr_yield = front_total > 0 ? Number(((item.ok_front / front_total) * 100).toFixed(2)) : 0;
    const f_curr_yield = rear_total > 0 ? Number(((item.ok_rear / rear_total) * 100).toFixed(2)) : 0;

    const s_yield_calc_total = front_total > 0 ? Number(item.ok_front / front_total) : 0;
    const f_yield_calc_total = rear_total > 0 ? Number(item.ok_rear / rear_total) : 0;

    const denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = denom_utl > 0 ? Number((((s_act_pd + s_ng_pd) / denom_utl) * 100).toFixed(2)) : 0;
    const f_curr_utl = denom_utl > 0 ? Number((((f_act_pd + f_ng_pd) / denom_utl) * 100).toFixed(2)) : 0;

    const plan_shutdown_front = runInfoFront.sum_planshutdown_duration || 0;
    const downtime_seconds_front = total_time_front - sum_run_front - plan_shutdown_front;
    const effective_time_front = total_time_front - plan_shutdown_front;

    const availability_front = effective_time_front > 0 ? Number(((sum_run_front / effective_time_front) * 100).toFixed(2)) : 0;
    const denom_perf_front = s_target_ct > 0 && effective_time_front > 0 ? effective_time_front / s_target_ct : 0;
    const performance_front = denom_perf_front > 0 ? Number((((item.ok_front + item.ag_front) / denom_perf_front) * 100).toFixed(2)) : 0;
    const oee_front = Number(((performance_front / 100) * (availability_front / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    const plan_shutdown_rear = runInfoRear.sum_planshutdown_duration || 0;
    const downtime_seconds_rear = total_time_rear - sum_run_rear - plan_shutdown_rear;
    const effective_time_rear = total_time_rear - plan_shutdown_rear;

    const availability_rear = effective_time_rear > 0 ? Number(((sum_run_rear / effective_time_rear) * 100).toFixed(2)) : 0;
    const denom_perf_rear = s_target_ct > 0 && effective_time_rear > 0 ? effective_time_rear / s_target_ct : 0;
    const performance_rear = denom_perf_rear > 0 ? Number((((item.ok_rear + item.ag_rear) / denom_perf_rear) * 100).toFixed(2)) : 0;
    const oee_rear = Number(((performance_rear / 100) * (availability_rear / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      target,
      cycle_t,
      prod_ok,
      f_target_pd,
      f_act_pd,
      f_diff_pd,
      f_act_ct,
      f_diff_ct,
      f_curr_yield,
      f_target_yield: s_target_yield,
      f_curr_utl,
      f_target_utl: s_target_utl,
      f_status_alarm,
      f_yield_calc_total,
      s_target_pd: f_target_pd,
      s_act_pd,
      s_diff_pd,
      s_target_ct,
      s_act_ct,
      s_diff_ct,
      s_curr_yield,
      s_target_yield,
      s_curr_utl,
      s_target_utl,
      s_status_alarm,
      s_yield_calc_total,
    };
  });
};

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines: () => store.getRawMap(),
    getRunningTime: store.getRunningTime,
    prepareRealtimeData,
    summary: "fSpindle",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
