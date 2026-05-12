const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("GSSM");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  // f_ -> Grease, s_ -> Shield
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

    const s_act_pd = item.shield_ok || 0;
    const ng_pd = item.shield_a_ng + item.shield_b_ng + item.snap_a_ng + item.snap_b_ng + item.ro1_ng + item.ro2_ng + item.grease_ng || 0;
    const s_act_ct = item.cycle_t / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_prod = s_act_pd - f_target_pd;
    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));

    const yield_rate = Number(((s_act_pd / (s_act_pd + ng_pd)) * 100 || 0).toFixed(2));

    const f_diff_pd = item.grease_ok - f_target_pd;
    const s_diff_pd = item.shield_ok - f_target_pd;

    const f_ng_pd = item.ro1_ng + item.ro2_ng + item.grease_ng;
    const s_ng_pd = item.shield_a_ng + item.shield_b_ng + item.snap_a_ng + item.snap_b_ng;

    const grease_total = item.grease_ok + f_ng_pd;
    const shield_total = item.shield_ok + s_ng_pd;
    const f_curr_yield = grease_total > 0 ? Number(((item.grease_ok / grease_total) * 100).toFixed(2)) : 0;
    const s_curr_yield = shield_total > 0 ? Number(((item.shield_ok / shield_total) * 100).toFixed(2)) : 0;

    const yield_calc_total = shield_total > 0 ? Number(item.shield_ok / shield_total) : 0;

    const s_total_pd = s_act_pd + s_ng_pd;
    const s_denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = s_denom_utl > 0 ? Number(((s_total_pd / s_denom_utl) * 100).toFixed(2)) : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;
    const effective_time = total_time - plan_shutdown;

    const availability = effective_time > 0 ? Number(((sum_run / effective_time) * 100).toFixed(2)) : 0;
    const denom_perf = s_target_ct > 0 && effective_time > 0 ? effective_time / s_target_ct : 0;
    const performance_grease = denom_perf > 0 ? Number(((grease_total / denom_perf) * 100).toFixed(2)) : 0;
    const performance_shield = denom_perf > 0 ? Number(((shield_total / denom_perf) * 100).toFixed(2)) : 0;

    const oee_grease = Number(((performance_grease / 100) * (availability / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;
    const oee_shield = Number(((performance_shield / 100) * (availability / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      target,
      f_target_pd,
      s_target_pd: f_target_pd,
      f_act_pd: item.grease_ok,
      S_act_pd: item.shield_ok, //? why 'S' Charecter is UpperCASE? --- IGNORE ---
      s_target_yield,
      f_diff_pd,
      s_diff_pd,
      s_act_pd,
      s_curr_yield,
      s_target_ct,
      s_act_ct,
      s_diff_ct,
      s_target_utl,
      s_curr_utl,
      s_status_alarm,
      f_yield_calc_total: yield_calc_total,
      s_yield_calc_total: yield_calc_total,
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
