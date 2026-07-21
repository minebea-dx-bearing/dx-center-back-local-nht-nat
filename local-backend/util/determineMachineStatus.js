/**
 * ฟังก์ชันสำหรับคำนวณสถานะของเครื่องจักรตามลำดับความสำคัญ
 * @param {object} item - Object ข้อมูลหลักของเครื่องจักร
 * @param {string} alarmStatus - สถานะจาก SQL (item.alarm_front หรือ item.alarm_rear)
 * @param {string|null} occurredStatus - สถานะ occurred (item.occurred_front หรือ item.occurred_rear)
 * @param {string} type - ส่งมาว่าจะใช้ข้อมูล alarm หรือ status
 * @returns {string} สถานะที่คำนวณแล้ว (เช่น "RUNNING", "STOP", "SIGNAL LOST")
 */

const moment = require("moment");

function determineMachineStatus(item, alarmStatus, occurredStatus, type) {
  // 1. ตรวจสอบเงื่อนไขที่สำคัญที่สุด (Connectivity) ก่อนเสมอ
  if (item.broker === 0 || !item.updated_at || moment().diff(moment(item.updated_at), "minutes") > 10) {
    return "SIGNAL LOST";
  }

  if(type === "status"){
    // console.log("status", item.mc_no, item.mqtt_status, alarmStatus)
    // 2. ให้ความสำคัญกับ MQTT (item.status) เป็นอันดับแรก
    if (item.mqtt_status?.toUpperCase().includes("RUN")) {
      return "RUNNING";
    }

    // 3. ถ้า mqtt ไม่ได้ส่งข้อมูลมาแล้วให้เป็น status สุดท้ายที่ส่งจาก SQL
    if (!item.mqtt_status && alarmStatus) {
      return alarmStatus.includes("RUN") ? "RUNNING" : alarmStatus.toUpperCase().replace("_", " ");
    }
    
    // 4. ถ้าทั้งคู่ไม่ใช่ "RUN" ให้แสดงสถานะอื่นๆ จาก MQTT (ถ้ามี)
    if (item.mqtt_status) {
      return item.mqtt_status.toUpperCase().replace("_", " ");
    }
  } else {
    // console.log("alarm", item.mc_no, item.mqtt_alarm, alarmStatus)
    if (item.mqtt_alarm?.toUpperCase().includes("RUN")) {
      // ถ้า status มีคำว่า "RUN" ให้ตัดสินจากตรงนี้เลย
      return item.mqtt_alarm.endsWith("_") ? "STOP" : "RUNNING";
    }

    // 3. ถ้า alarm จาก SQL เป็น RUN ให้เป็น RUNNING
    if (alarmStatus?.toUpperCase().includes("RUN") && !alarmStatus.endsWith("_")) {
      return "RUNNING";
    }

    // 4. ถ้าทั้งคู่ไม่ใช่ "RUN" ให้แสดงสถานะอื่นๆ (ถ้ามี)
    if (item.mqtt_alarm && !item.mqtt_alarm.endsWith("_")) {
      return item.mqtt_alarm.toUpperCase();
    }
  }

  // 5. จัดการกรณีย่อยอื่นๆ เป็นลำดับท้ายๆ
  if (occurredStatus === null) {
    return "NO DATA RUN";
  }

  // 6. ถ้าไม่เข้าเงื่อนไขไหนเลย ให้ถือว่าเป็น "STOP"
  return "STOP";
}

module.exports = determineMachineStatus;