/**
 * ฟังก์ชันสำหรับคำนวณสถานะของเครื่องจักรตามลำดับความสำคัญ
 * @param {object} item - Object ข้อมูลหลักของเครื่องจักร
 * @param {string} alarmStatus - สถานะจาก SQL (item.alarm_front หรือ item.alarm_rear)
 * @param {string|null} occurredStatus - สถานะ occurred (item.occurred_front หรือ item.occurred_rear)
 * @returns {string} สถานะที่คำนวณแล้ว (เช่น "RUNNING", "STOP", "SIGNAL LOSE")
 */

const moment = require("moment");

function determineMachineStatus(item, alarmStatus, occurredStatus) {
  // 1. ตรวจสอบเงื่อนไขที่สำคัญที่สุด (Connectivity) ก่อนเสมอ
  if (item.broker === 0 || !item.updated_at || moment().diff(moment(item.updated_at), "minutes") > 10) {
    return "SIGNAL LOSE";
  }

  // 2. ให้ความสำคัญกับ MQTT (item.status) เป็นอันดับแรก
  if (item.status?.toUpperCase().includes("RUN")) {
    // ถ้า status มีคำว่า "RUN" ให้ตัดสินจากตรงนี้เลย
    return item.status.endsWith("_") ? "STOP" : "RUNNING";
  }

  // 3. ถ้า MQTT ไม่ใช่ "RUN" ให้ไปดูที่ SQL (alarmStatus ที่ส่งเข้ามา)
  if (alarmStatus?.toUpperCase().includes("RUN") && !alarmStatus.endsWith("_")) {
    return "RUNNING";
  }

  // 4. ถ้าทั้งคู่ไม่ใช่ "RUN" ให้แสดงสถานะอื่นๆ จาก MQTT (ถ้ามี)
  if (item.status && !item.status.endsWith("_")) {
    return item.status;
  }

  // 5. จัดการกรณีย่อยอื่นๆ เป็นลำดับท้ายๆ
  if (occurredStatus === null) {
    return "NO DATA RUN";
  }

  // 6. ถ้าไม่เข้าเงื่อนไขไหนเลย ให้ถือว่าเป็น "STOP"
  return "STOP";
}

module.exports = determineMachineStatus;