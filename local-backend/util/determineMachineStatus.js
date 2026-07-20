/**
 * ฟังก์ชันสำหรับคำนวณสถานะของเครื่องจักรตามลำดับความสำคัญ
 * @param {object} item - Object ข้อมูลหลักของเครื่องจักร
 * @param {string} alarmStatus - สถานะจาก SQL (item.alarm_front หรือ item.alarm_rear)
 * @param {string|null} occurredStatus - สถานะ occurred (item.occurred_front หรือ item.occurred_rear)
 * @param {} mqtt_status - alarm/status ที่ส่งมาจาก mqtt ถ้า process ไหนที่มี status แล้วจะใช้ data status แล้วในอนาคตถ้าส่ง status มาหมดแล้วจะเปลี่ยนไปใช้ status หมด
 * @returns {string} สถานะที่คำนวณแล้ว (เช่น "RUNNING", "STOP", "SIGNAL LOST")
 */

const moment = require("moment");

function determineMachineStatus(item, alarmStatus, occurredStatus, mqtt_status) {
  // console.log(item.mc_no, mqtt_status, item.mqtt_status, item.mqtt_alarm,alarmStatus, item.broker, item.updated_at, !item.updated_at, moment().diff(moment(item.updated_at), "minutes") > 10)
  // console.log(item.broker === 0 || !item.updated_at || moment().diff(moment(item.updated_at), "minutes") > 10)
  // console.log(item.mc_no, alarmStatus, mqtt_status?.toUpperCase().includes("RUN"), mqtt_status)
  // 1. ตรวจสอบเงื่อนไขที่สำคัญที่สุด (Connectivity) ก่อนเสมอ
  if (item.broker === 0 || !item.updated_at || moment().diff(moment(item.updated_at), "minutes") > 10) {
    return "SIGNAL LOST";
  }

  // 2. ให้ความสำคัญกับ MQTT (item.status) เป็นอันดับแรก
  if (mqtt_status?.toUpperCase().includes("RUN")) {
    // ถ้า status มีคำว่า "RUN" ให้ตัดสินจากตรงนี้เลย
    return mqtt_status.endsWith("_") ? "STOP" : "RUNNING";
  }

  // 4. ถ้าทั้งคู่ไม่ใช่ "RUN" ให้แสดงสถานะอื่นๆ จาก MQTT (ถ้ามี)
  if (mqtt_status && !mqtt_status.endsWith("_")) {
    return mqtt_status.toUpperCase();
  }

  // 3. ถ้า MQTT ไม่ใช่ "RUN" ให้ไปดูที่ SQL (alarmStatus ที่ส่งเข้ามา)
  if (alarmStatus?.toUpperCase().includes("RUN") && !alarmStatus.endsWith("_")) {
    return "RUNNING";
  }

  // 5. จัดการกรณีย่อยอื่นๆ เป็นลำดับท้ายๆ
  if (occurredStatus === null) {
    return "NO DATA RUN";
  }

  // 6. ถ้าไม่เข้าเงื่อนไขไหนเลย ให้ถือว่าเป็น "STOP"
  return "STOP";
}

module.exports = determineMachineStatus;