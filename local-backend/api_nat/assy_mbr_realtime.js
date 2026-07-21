const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("MBR");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);
  // console.log(currentMachineData)
  let curr_mc_no = Object.keys(currentMachineData); 
  for(let i=1; i<13; i++){
    const target = `mbr${i.toString().padStart(2, '0')}`;
    if(!curr_mc_no.includes(target)){
        currentMachineData[target] = {
            process: "mbr",
            mc_no: target,
            part_no: "no setup",
            daily_ok: 0,
            daily_ng: 0,
            cycle_t: 0,
            alarm: 'SIGNAL LOSE',
            target_ct: 0,
            target_utl: 0,
            target_yield: 0,
            target_special: 0,
            ring_factor: 0
        }
    }
  }

  return Object.values(currentMachineData).map((item) => {
    const s_status_alarm = determineMachineStatus(item, item.alarm, item.occurred, "alarm");

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const s_target_ct = item.target_ct || 0;
    const s_target_yield = item.target_yield || 0;
    const s_target_utl = item.target_utl || 0;

    const s_act_pd = item.daily_ok || 0;
    const s_ng_pd = item.daily_ng || 0;
    const s_act_ct = item.cycle_t / 100 || 0;

    const s_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));
    
    const s_total_pd = s_act_pd + s_ng_pd;
    const s_diff_pd = s_total_pd - s_target_pd;
    const s_curr_yield = s_total_pd > 0 ? Number(((s_act_pd / s_total_pd) * 100).toFixed(2)) : 0;
    const yield_calc_total = s_total_pd > 0 ? Number(s_act_pd / s_total_pd) : 0;

    const s_denom_utl = s_target_ct > 0 ? (elapsedSec * item.ring_factor) / s_target_ct : 0;
    const s_curr_utl = s_denom_utl > 0 ? Number(((s_total_pd / s_denom_utl) * 100).toFixed(2)) : 0;

    // ----- OEE -----
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    // console.log(runInfo)
    const act_opn_time = runInfo.sum_duration || 0;
    const total_work_time = runInfo.total_time || 0;
    const plan_stop = runInfo.sum_planstop_duration || 0;
    const production_count = s_act_pd + s_ng_pd || 0;
    // console.log(item.mc_no, act_opn_time)

    const s_availability = Number(((act_opn_time / (total_work_time - plan_stop)) * 100).toFixed(2)) || 0;
    // console.log(target_ct, production_count,act_opn_time , item.ring_factor)
    const s_performance = Number((((s_target_ct * production_count) / (act_opn_time * item.ring_factor)) * 100).toFixed(2)) || 0;
    const s_oee = Number(((s_performance / 100) * (s_availability / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      s_status_alarm,
      s_target_yield,
      target,
      s_target_pd,
      s_total_pd,
      s_diff_pd,
      s_act_ct,
      s_target_ct,
      s_diff_ct,
      s_act_pd,
      s_curr_yield,
      s_curr_utl,
      s_target_utl,
      s_availability,
      s_performance,
      s_quality: s_curr_yield,
      s_oee,
      yield_calc_total: yield_calc_total,
      curr_mc_no
    };
  });
};

router.get(
  "/machines",
  makeMachinesHandler({
    getMachines: () => store.getRawMap(),
    getRunningTime: store.getRunningTime,
    prepareRealtimeData,
    summary: "sSpindle",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
