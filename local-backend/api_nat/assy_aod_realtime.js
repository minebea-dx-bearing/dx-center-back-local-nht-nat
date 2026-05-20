/**
 * CANONICAL EXAMPLE — Route Pattern R5: Manual handler (escape hatch)
 * See docs/realtime-developer-guide.md §5.5 before copying this file.
 *
 * Escapes makeMachinesHandler because the summary needs avg_opn (average across
 * machines), not the standard sum_target/sum_daily_ok/avg_cycle_t/avg_utl shape.
 *
 * Still uses: _store_assy (no duplicate MQTT/SQL), shiftWindow(), determineMachineStatus().
 * Do NOT copy the manual router.get pattern unless makeMachinesHandler truly cannot
 * produce your summary — adding a new summary type to SUMMARY_FIELDS is preferred.
 */
const express = require("express");
const router = express.Router();
const moment = require("moment");

const determineMachineStatus = require("../util/determineMachineStatus");
const shiftWindow = require("../util/shiftWindow");
const { getStore } = require("./_store_assy");

const startTime = 6;
const store = getStore("AOD");

const prepareRealtimeData = (currentMachineData, runningTimeData, now) => {
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);

  let curr_mc_no = Object.keys(currentMachineData); 
  for(let i=1; i<13; i++){
    const target = `aod${i.toString().padStart(2, '0')}`;
    if(!curr_mc_no.includes(target)){
        currentMachineData[target] = {
            process: "aod",
            mc_no: target,
            part_no: "no setup",
            daily_ok: 0,
            daily_ag: 0,
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

    const act_pd = item.daily_ok || 0;
    const ng_pd = item.daily_ag;
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

router.get("/machines", async (req, res) => {
  try {
    const now = moment();
    const [machines, runningTime] = await Promise.all([Promise.resolve(store.getRawMap()), store.getRunningTime()]);
    const dataArray = prepareRealtimeData(machines, runningTime, now);
    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.target_actual || 0;
        acc.total_ok += item.prod_ok || 0;
        acc.total_cycle_t += item.cycle_t || 0;
        acc.total_opn += item.opn || 0;
        acc.count += 1;
        return acc;
      },
      { total_target: 0, total_ok: 0, total_cycle_t: 0, total_opn: 0, count: 0 },
    );

    const resultSummary = {
      sum_target: summary.total_target,
      sum_daily_ok: summary.total_ok,
      avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
      avg_opn: summary.count > 0 ? Number((summary.total_opn / summary.count).toFixed(2)) : 0,
    };
    res.json({ success: true, data: dataArray, resultSummary });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
};
