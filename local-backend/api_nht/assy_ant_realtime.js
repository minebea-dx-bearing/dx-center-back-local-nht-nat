const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const store = require("./_store_ant");

const startTime = 6;

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  // f_ -> Rear, s_ -> Front
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

    const prod_ok = item.ok1 + item.ok2 || 0;
    const prod_ng = item.ag + item.ng + item.mix || 0;
    const cycle_t = item.cycle / 100 || 0;

    const f_act_pd = item.ok_rear;
    const s_act_pd = item.ok_front;

    const s_act_ct = item.cycle_time_front / 100 || 0;
    const f_act_ct = item.cycle_time_rear / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_ct = Number((act_ct - s_target_ct).toFixed(2));

    const yield_rate = Number(((prod_ok / (prod_ok + prod_ng)) * 100 || 0).toFixed(2));

    const s_ng_pd = item.ag_front + item.ng_front + item.mixball_front;
    const f_ng_pd = item.ag_rear + item.ng_rear + item.mixball_rear;

    const f_total_pd = f_act_pd + f_ng_pd;
    const s_total_pd = s_act_pd + s_ng_pd;

    const s_diff_pd = f_total_pd - f_target_pd;
    const f_diff_pd = s_total_pd - f_target_pd;

    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));
    const f_diff_ct = Number((f_act_ct - s_target_ct).toFixed(2));

    const s_curr_yield = Number(((s_act_pd / s_total_pd) * 100 || 0).toFixed(2));
    const f_curr_yield = Number(((f_act_pd / f_total_pd) * 100 || 0).toFixed(2));

    const denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = denom_utl > 0 ? Number(((s_total_pd / denom_utl) * 100).toFixed(2)) || 0 : 0;
    const f_curr_utl = denom_utl > 0 ? Number(((f_total_pd / denom_utl) * 100).toFixed(2)) || 0 : 0;

    const plan_shutdown_front = runInfoFront.sum_planshutdown_duration || 0;
    const downtime_seconds_front = total_time_front - sum_run_front - plan_shutdown_front;

    const availability_front = Number(((sum_run_front / (total_time_front - plan_shutdown_front)) * 100).toFixed(2)) || 0;
    const denom_perf_front = s_target_ct > 0 && total_time_front - plan_shutdown_front > 0 ? (total_time_front - plan_shutdown_front) / s_target_ct : 0;
    const performance_front = denom_perf_front > 0 ? Number((((item.ok_front + item.ag_front) / denom_perf_front) * 100).toFixed(2)) || 0 : 0;
    const oee_front = Number(((performance_front / 100) * (availability_front / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    const plan_shutdown_rear = runInfoRear.sum_planshutdown_duration || 0;
    const downtime_seconds_rear = total_time_rear - sum_run_rear - plan_shutdown_rear;

    const availability_rear = Number(((sum_run_rear / (total_time_rear - plan_shutdown_rear)) * 100).toFixed(2)) || 0;
    const denom_perf_rear = s_target_ct > 0 && total_time_rear - plan_shutdown_rear > 0 ? (total_time_rear - plan_shutdown_rear) / s_target_ct : 0;
    const performance_rear = denom_perf_rear > 0 ? Number((((item.ok_rear + item.ag_rear) / denom_perf_rear) * 100).toFixed(2)) || 0 : 0;
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
      f_total_pd,
      f_diff_pd,
      f_act_ct,
      f_diff_ct,
      f_curr_yield,
      f_target_yield: s_target_yield,
      f_curr_utl,
      f_target_utl: s_target_utl,
      f_status_alarm,
      s_target_pd: f_target_pd,
      s_total_pd,
      s_act_pd,
      s_diff_pd,
      s_target_ct,
      s_act_ct: act_ct,
      s_diff_ct: diff_ct,
      s_curr_yield: curr_yield,
      s_target_yield,
      s_curr_utl,
      s_target_utl,
      s_status_alarm,
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
