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
    const s_status_alarm = determineMachineStatus(item, item.status, item.occurred, item.mqtt_status);

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

    const s_act_pd = item.ok || 0;
    const ng_pd = item.ng_ro1 + item.ng_ro2_grs + item.ng_a_shield + item.ng_a_snap + item.ng_b_shield + item.ng_b_snap + item.ng_grs || 0;
    const s_act_ct = item.cycletime / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));

    const f_ng_pd = item.ng_ro1 + item.ng_ro2_grs + item.ng_grs;
    const s_ng_pd = item.ng_a_shield + item.ng_a_snap + item.ng_b_shield + item.ng_b_snap;
    
    const f_total_pd = item.ok_grs + f_ng_pd;
    const s_total_pd = item.ok + s_ng_pd;
    
    const f_diff_pd = item.ok_grs - f_target_pd;
    const s_diff_pd = item.ok - f_target_pd;

    const f_curr_yield = Number(((item.ok_grs / f_total_pd) * 100 || 0).toFixed(2));
    const s_curr_yield = Number(((item.ok / s_total_pd) * 100 || 0).toFixed(2));

    const denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = denom_utl > 0 ? Number((((s_act_pd + s_ng_pd) / denom_utl) * 100).toFixed(2)) || 0 : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const denom_perf = s_target_ct > 0 && total_time - plan_shutdown > 0 ? (total_time - plan_shutdown) / s_target_ct : 0;
    const performance_grease = denom_perf > 0 ? Number(((f_total_pd / denom_perf) * 100).toFixed(2)) || 0 : 0;
    const performance_shield = denom_perf > 0 ? Number(((s_total_pd / denom_perf) * 100).toFixed(2)) || 0 : 0;

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
      f_act_pd: item.ok_grs || 0,
      f_total_pd,
      s_target_yield,
      f_diff_pd,
      s_total_pd,
      s_diff_pd,
      s_act_pd,
      s_curr_yield,
      s_target_ct,
      s_act_ct,
      s_diff_ct,
      s_target_utl,
      s_curr_utl,
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
