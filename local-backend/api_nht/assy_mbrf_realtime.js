const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("ASSYF", { alarmTableSuffix: "DATA_ALARMLIST" });

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  return Object.values(currentMachineData).map((item) => {
    const f_status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

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
    const f_target_ct = item.target_ct || 0;
    const f_target_utl = item.target_utl || 0;

    const f_act_pd = item.match || 0;
    const f_ng_pd = item.a_ng + item.a_ng_p + item.a_ng_n + item.a_unm + item.b_ng_p + item.b_ng_n + item.b_unm || 0;
    const f_act_ct = (item.cycle_t || 0) / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const f_total_pd = f_act_pd + f_ng_pd;
    const f_diff_pd = f_total_pd - f_target_pd;
    const f_diff_ct = Number((f_act_ct - f_target_ct).toFixed(2));

    const f_curr_yield = Number(((f_act_pd / (f_act_pd + f_ng_pd)) * 100 || 0).toFixed(2));

    const denom_utl = f_target_ct > 0 ? (elapsedSec * item.ring_factor) / f_target_ct : 0;
    const f_curr_utl = denom_utl > 0 ? Number((((f_act_pd + f_ng_pd) / denom_utl) * 100).toFixed(2)) || 0 : 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const f_downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const denom_perf = f_target_ct > 0 && total_time - plan_shutdown > 0 ? (total_time - plan_shutdown) / f_target_ct : 0;
    const performance = denom_perf > 0 ? Number((((f_act_pd + f_ng_pd) / denom_perf) * 100).toFixed(2)) || 0 : 0;
    const f_oee = Number(((performance / 100) * (availability / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no === "" ? item.model : item.part_no,
      mc_no: item.mc_no.replace("_f", "").toUpperCase(),
      model: item.model || "NO DATA",
      process: "MBR_F",
      f_status_alarm,
      f_target_yield: item.target_yield || 0,
      target,
      f_target_pd,
      f_total_pd,
      f_diff_pd,
      f_act_pd,
      f_act_ct,
      f_target_ct,
      f_diff_ct,
      f_curr_yield,
      f_curr_utl,
      f_target_utl,
      f_downtime_seconds,
      f_oee,
    };
  });
};

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines: () => store.getRawMap(),
    getRunningTime: store.getRunningTime,
    prepareRealtimeData,
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
