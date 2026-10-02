const express = require("express");
const router = express.Router();

const dbms = require("../../instance/ms_instance_nat");
const determineMachineStatus = require("../../util/determineMachineStatus");
const shiftWindow = require("../../util/shiftWindow");
const { makeMachinesHandler } = require("../../util/realtimeMachinesRoute");
const { getStore } = require("../_store_assy_status");
const getData = require("../../util/analysis_assy")

const moment = require("moment");

const DATABASE_PROD = "[nat_mc_assy_alu].[dbo].[DATA_PRODUCTION_ALU]";
const DATABASE_MASTER = "[nat_mc_assy_alu].[dbo].[DATA_MASTER_ALU]";
const COLUMN_OK = "[prod_cnt]";
const COLUMN_NG = "0";
const COLUMN_TOTAL = `(${COLUMN_OK} + ${COLUMN_NG})`;

const startTime_daily = 6;
const startTime_shift = (moment().format("HH:mm") <= "06:05" || moment().format("HH:mm") >= "18:05") ? 18 : 6;
const startMin = 5;
const store = getStore("ALU");

const prepareRealtimeData = (currentMachineData, runningTimeData, now, current_date, dataHourly) => {
  let curr_mc_no = Object.keys(currentMachineData); 
  for(let i=1; i<13; i++){
      const target = `arp${i.toString().padStart(2, '0')}`;
      if(!curr_mc_no.includes(target)){
          currentMachineData[target] = {
              process: "arp",
              mc_no: target,
              part_no: "no setup",
              prod_ok_daily: 0,
              prod_diff_daily: 0,
              target_prod_shift: 0,
              prod_ok_shift: 0,
              prod_diff_shift: 0,
              act_ct: 0,
              diff_ct: 0,
              target_yield: 0,
              curr_yield: 0,
              yield_calc_total: 0,
              dataProdHourly: {
              data_ok: [],
              data_date: [],
              target: [],
              }
          }
      }
  }

  // calculate time diff from 06:05-now or 18:05-now
  const todaysStart_daily = moment(now).startOf("day").hour(startTime_daily).minute(startMin);
  const start_time_daily = now.isBefore(todaysStart_daily) ? moment(todaysStart_daily).subtract(1, "day") : todaysStart_daily;
  const elapsedMin_daily = Math.max(now.diff(start_time_daily, "minutes"), 0)
  
  const todaysStart_shift = moment(now).startOf("day").hour(startTime_shift).minute(startMin);
  const start_time_shift = now.isBefore(todaysStart_shift) ? moment(todaysStart_shift).subtract(1, "day") : todaysStart_shift;
  const elapsedMin_shift = Math.max(now.diff(start_time_shift, "minutes"), 0)

  return Object.values(currentMachineData).map((item) => {
    const year = String(item.date_shift_m_year);
    const month = String(item.date_shift_m_month).padStart(2, '0');
    const day = String(item.date_shift_m_day).padStart(2, '0');
    const shift_m_date = `${year}-${month}-${day}`; 

    const dataHourlyFilter = dataHourly?.[item.mc_no] || {
      data_ok: [],
      data_date: [],
      target: [],
      isBilnk: [],
      last_data: { daily_ok: 0 }
    };

    let target = 0;
    if (item.target_special > 0) {
      target = item.target_special;
    } else if (item.target_ct > 0) {
      target = Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    }
    
    // Cycle time
    const target_ct = item.target_ct || 0;
    const act_ct = item.cycle_t / 100 || 0;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));
    
    // Production
    const target_prod_daily = target === 0 ? 0 : Math.floor((target / (24 * 60)) * elapsedMin_daily); // 24 ชั่วโมง
    const prod_ok_daily = item.prod_cnt || 0; // data OK daily
    const prod_diff_daily = prod_ok_daily - target_prod_daily;
    
    const target_shift = Math.floor(target / 2);
    const target_prod_shift = target_shift === 0 ? 0 : Math.floor((target_shift / (12 * 60)) * elapsedMin_shift); // 12 ชั่วโมง
    const m_shift_prod_ok = (shift_m_date === current_date) ? item.shift_m_tt_prod_cnt_pcs : 0;
    const prod_ok_shift = prod_ok_daily - m_shift_prod_ok || 0; // data OK shift
    const prod_diff_shift = prod_ok_shift - target_prod_shift;

    // 2. ดักเช็ค indexOfCurHr ไม่ให้เป็น -1 หรือระเบิดเมื่อไม่มี data_date
    if (Array.isArray(dataHourlyFilter.data_date) && dataHourlyFilter.data_date.length > 0) {
      let indexOfCurHr = dataHourlyFilter.data_date.findIndex((hourStr) => hourStr > now.format('HH:mm'));
      if (indexOfCurHr === -1) {
        indexOfCurHr = dataHourlyFilter.data_date.length - 1; // ชี้ไปที่ช่องสุดท้ายถ้าเกินเวลา
      }
      
      const lastestData = dataHourlyFilter.last_data?.daily_ok || 0;
      if (!dataHourlyFilter.data_ok) dataHourlyFilter.data_ok = [];
      dataHourlyFilter.data_ok[indexOfCurHr] = prod_ok_daily - lastestData;
      dataHourlyFilter.isBilnk[indexOfCurHr] = 1;
    }

    const dataProdHourly = {
      data_ok: dataHourlyFilter.data_ok || [],
      data_date: dataHourlyFilter.data_date || [],
      target: dataHourlyFilter.target || [],
      isBilnk: dataHourlyFilter.isBilnk || [],
    };

    return {
      process: item.process.toUpperCase(),
      mc_no: item.mc_no.toUpperCase(),
      part_no: item.part_no,
      prod_ok_daily,
      prod_diff_daily,
      target_prod_shift,
      prod_ok_shift,
      prod_diff_shift,
      act_ct,
      diff_ct,
      dataProdHourly
    };
  });
};

const machinesData = async () => {
  try {
    const now = moment();
    const current_date = (now.format("HH:mm") <= "06:05") ? now.subtract(1, 'day').format("YYYY-MM-DD") : now.format("YYYY-MM-DD");
    const [machines, runningTime] = await Promise.all([Promise.resolve(store.getRawMap()), store.getRunningTime()]);
    const getDataHourly = await getData.productionByHourAllMc(dbms, DATABASE_MASTER, DATABASE_PROD, COLUMN_OK, COLUMN_NG, COLUMN_TOTAL, current_date)
    const dataHourly = (startTime_shift === 18) ? getDataHourly.data.N : getDataHourly.data.M
    const dataArray = await prepareRealtimeData(machines, runningTime, now, current_date, dataHourly);
    return({ data: dataArray, success: true });
  } catch (error) {
    return({ data: [], success: false, message: "Internal Server Error" });
  }
}

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime: store.getRunningTime,
  getMachineData: () => store.getRawMap(),
  machinesData
};
