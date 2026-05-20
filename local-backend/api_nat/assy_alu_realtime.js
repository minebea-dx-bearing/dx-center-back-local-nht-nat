/**
 * CANONICAL EXAMPLE — Route Pattern R1: Standard single spindle
 * See docs/realtime-developer-guide.md §5.1 before copying this file.
 *
 * Pattern: single spindle, standard OEE formulas, makeMachinesHandler({ summary: "standard" }).
 * Store:   _store_assy.js (Family A factory) — shared with AOD, ARP, AVS, FIM, GSSM, MBR, MBR_F.
 */
const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("ALU");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);
  // console.log(currentMachineData)

  let curr_mc_no = Object.keys(currentMachineData); 
  for(let i=1; i<13; i++){
    const target = `alu${i.toString().padStart(2, '0')}`;
    if(!curr_mc_no.includes(target)){
        currentMachineData[target] = {
            process: "alu",
            mc_no: target,
            part_no: "no setup",
            prod_cnt: 0,
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
    const status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const target_ct = item.target_ct || 0;
    const target_utl = item.target_utl || 0;

    const act_pd = item.prod_cnt || 0;
    const ng_pd = 0;
    const act_ct = item.cycle_t / 100 || 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_pd = act_pd - target_pd;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));

    const total_pd = act_pd + ng_pd;
    const curr_yield = total_pd > 0 ? Number(((act_pd / total_pd) * 100).toFixed(2)) : 0;

    const yield_calc_total = total_pd > 0 ? Number(act_pd / total_pd) : 0;

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
      status_alarm,
      target,
      target_pd,
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
    summary: "standard",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
