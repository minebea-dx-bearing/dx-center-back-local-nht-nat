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

const prepareRealtimeData = async (currentMachineData, runningTimeData, now) => {
  // console.log(currentMachineData)
  const { elapsedMin, elapsedSec } = shiftWindow(now, startTime);
  const new_currentMachineData = {}
  
  Object.values(currentMachineData).map((item) => {
    // set mc_no into 2 no. -> mc_no for rear = odd no.
    //                      -> mc_no for front = even no.
    // for example: ANT01 includes front side and rear side -> split into ANT01 for rear side and ANT02 for front side
    const mc = Number(item.mc_no.slice(-2))
    const calc_mc_no = mc+(mc-1)
    const mc_no_front = item.mc_no.slice(0,3) + String(mc*2).padStart(2, '0')
    const mc_no_rear = item.mc_no.slice(0,3) + String(calc_mc_no).padStart(2, '0')
    const alarm_front = (item.mqtt_alarm?.includes("(FRONT)")) ? item.mqtt_alarm : null
    const alarm_rear = (item.mqtt_alarm?.includes("(REAR)")) ? item.mqtt_alarm : null
    
    const data_front = {...item, mc_no: mc_no_front, alarm: item.alarm_front, occurred: item.occurred_front, mqtt_alarm: alarm_front}
    const data_rear = {...item, mc_no: mc_no_rear, alarm: item.alarm_rear, occurred: item.occurred_rear, mqtt_alarm: alarm_rear}
    
    new_currentMachineData[mc_no_rear] = data_rear
    new_currentMachineData[mc_no_front] = data_front
  })
  
  let curr_mc_no = Object.keys(new_currentMachineData); 
  for(let i=1; i<13; i++){
    const target = `ant${i.toString().padStart(2, '0')}`;
    if(!curr_mc_no.includes(target)){
        new_currentMachineData[target] = {
          process: "ant",
            mc_no: target,
            part_no: "no setup",
            ok_front: 0,
            cycle_time_front: 0,
            ag_front: 0,
            ng_front: 0,
            mixball_front: 0,
            ok_rear: 0,
            cycle_time_rear: 0,
            ag_rear: 0,
            ng_rear: 0,
            mixball_rear: 0,
            alarm: 'SIGNAL LOSE',
            target_ct: 0,
            target_utl: 0,
            target_yield: 0,
            target_special: 0,
            ring_factor: 0
          }
    }
  }

  const antMaster = await store.master(); 
  // console.log(antMaster)
  Object.keys(new_currentMachineData).forEach((key) => {
    const item = new_currentMachineData[key];

    // 1. ค้นหาข้อมูลจาก antMaster ที่ mc_no ตรงกัน
    const masterArray = antMaster.filter((i) => i.mc_no === item.mc_no.toUpperCase());
    const targetMaster = masterArray[0];

    // 2. ถ้าเจอข้อมูลใน antMaster ให้ทำการรวมร่าง (Merge) ข้อมูลเข้าไป
    if (targetMaster) {
      new_currentMachineData[key] = {
        ...item,
        ...targetMaster,
        mc_no: item.mc_no
      };
    }
    else {
      new_currentMachineData[key] = {
        ...item,
        part_no: "no setup",
        target_ct: 0,
        target_utl: 0,
        target_yield: 0,
        target_special: 0,
        ring_factor: 0,
        mc_no: item.mc_no
      };
    }
  });
  // console.log(new_currentMachineData);
  
  return Object.values(new_currentMachineData).map((item) => {
    const status_alarm = determineMachineStatus(item, item.alarm, item.occurred, "alarm");
    let act_pd = 0;
    let act_ct = 0;
    let ng_pd = 0;

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }

    if(Number(item.mc_no.slice(-2)) % 2 === 0){
      // even mc_no
      act_pd = item.ok_front;
      act_ct = item.cycle_time_front / 100 || 0;
      ng_pd = item.ag_front + item.ng_front + item.mixball_front;
    } else {
      // odd mc_no
      act_pd = item.ok_rear;
      act_ct = item.cycle_time_rear / 100 || 0;
      ng_pd = item.ag_rear + item.ng_rear + item.mixball_rear;
    }

    const target_ct = item.target_ct || 0;
    const target_yield = item.target_yield || 0;
    const target_utl = item.target_utl || 0;

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
      status_alarm,
      target,
      target_pd,
      total_pd,
      act_pd,
      diff_pd,
      act_ct,
      diff_ct,
      curr_yield,
      target_yield,
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
