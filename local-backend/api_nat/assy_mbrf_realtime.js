const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("MBR_F");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);
  // console.log(currentMachineData)
  let curr_mc_no = Object.keys(currentMachineData); 
  for(let i=1; i<13; i++){
    const target = `mbr_f${i.toString().padStart(2, '0')}`;
    if(!curr_mc_no.includes(target)){
        currentMachineData[target] = {
            process: "mbr_f",
            mc_no: target,
            part_no: "no setup",
            a_ng: 0,
            a_ng_pos: 0,
            a_ng_neg: 0,
            a_unm: 0,
            b_ng: 0,
            b_ng_pos: 0,
            b_ng_neg: 0,
            b_unm: 0,
            match: 0,
            cycle_time: 0,
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
    const f_status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const f_target_ct = item.target_ct || 0;
    const f_target_utl = item.target_utl || 0;

    const f_act_pd = item.match || 0;
    const f_ng_pd = item.a_ng + item.a_ng_pos + item.a_ng_neg + item.a_unm + item.b_ng_pos + item.b_ng_neg + item.b_unm || 0;
    const f_act_ct = item.cycle_time / 100 || 0;

    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const f_diff_ct = Number((f_act_ct - f_target_ct).toFixed(2));
    
    const f_total_pd = f_act_pd + f_ng_pd;
    const f_diff_pd = f_total_pd - f_target_pd;
    const f_curr_yield = f_total_pd > 0 ? Number(((f_act_pd / f_total_pd) * 100).toFixed(2)) : 0;

    const f_denom_utl = f_target_ct > 0 ? (elapsedSec * item.ring_factor) / f_target_ct : 0;
    const f_curr_utl = f_denom_utl > 0 ? Number(((f_total_pd / f_denom_utl) * 100).toFixed(2)) : 0;

    // ----- OEE -----
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    // console.log(runInfo)
    const act_opn_time = runInfo.sum_duration || 0;
    const total_work_time = runInfo.total_time || 0;
    const plan_stop = runInfo.sum_planstop_duration || 0;
    const production_count = f_act_pd + f_ng_pd || 0;
    // console.log(item.mc_no, act_opn_time)

    const f_availability = Number(((act_opn_time / (total_work_time - plan_stop)) * 100).toFixed(2)) || 0;
    // console.log(target_ct, production_count,act_opn_time , item.ring_factor)
    const f_performance = Number((((f_target_ct * production_count) / (act_opn_time * item.ring_factor)) * 100).toFixed(2)) || 0;
    const f_oee = Number(((f_performance / 100) * (f_availability / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      part_no: item.part_no,
      mc_no: item.mc_no.replace("_f", "").toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      f_target_yield: item.target_yield || 0,
      target,
      f_target_pd,
      f_diff_pd,
      f_total_pd,
      f_act_pd,
      f_act_ct,
      f_target_ct,
      f_diff_ct,
      f_availability,
      f_performance,
      f_quality: f_curr_yield,
      f_oee,
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
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
