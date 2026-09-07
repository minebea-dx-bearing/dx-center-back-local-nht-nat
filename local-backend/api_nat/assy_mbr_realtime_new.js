const express = require("express");
const router = express.Router();

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { makeMachinesHandler } = require("../util/realtimeMachinesRoute");
const { getStore } = require("./_store_assy_status");

const startTime = 6;
const store = getStore("MBR");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);


  return Object.values(currentMachineData).map((item) => {
    const year = String(item.date_shift_m_year);
    const month = String(item.date_shift_m_month).padStart(2, '0');
    const day = String(item.date_shift_m_day).padStart(2, '0');
    const shift_m_date = `${year}-${month}-${day}`; 
    const current_date = (now.format("HH:mm") <= "06:05") ? now.subtract(1, 'day').format("YYYY-MM-DD") : now.format("YYYY-MM-DD");

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    const target_ct = item.target_ct || 0;
    const target_yield = item.target_yield || 0;
    const target_utl = item.target_utl || 0;

    const act_pd = item.daily_ok || 0; // data OK
    const ng_pd = item.daily_ng || 0; // data NG
    const act_ct = item.cycle_t / 100 || 0;

    const m_shift_prod_ok = (shift_m_date === current_date) ? item.shift_m_prod_ok : 0;

    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin);

    const diff_ct = Number((act_ct - target_ct).toFixed(2));
    
    const total_pd = act_pd + ng_pd;
    const diff_pd = total_pd - target_pd;
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
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      target_yield,
      target,
      target_pd,
      total_pd,
      diff_pd,
      act_ct,
      target_ct,
      diff_ct,
      act_pd,
      curr_yield,
      curr_utl,
      target_utl,
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
    summary: "sSpindle",
  }),
);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
