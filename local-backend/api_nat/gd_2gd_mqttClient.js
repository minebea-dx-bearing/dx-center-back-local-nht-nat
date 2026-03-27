const mqtt = require("mqtt");

// กำหนด URL broker ของคุณ
const MQTT_BROKER_URL = `mqtt://${process.env.NAT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`;

// สร้าง client
const client = mqtt.connect(MQTT_BROKER_URL);

// ตัวแปรเก็บข้อมูล realtime ของแต่ละ mc_no
// โครงสร้าง: { [mc_no]: { data: ..., status: ..., mqtt: ..., lastUpdate: Date } }
const realtimeCache = {};

// เรียก subscribe topic ทุก mc_no (หรือใช้ wildcard หากเหมาะสม)
const baseTopic = "data/nat/2gd/"; // ปรับให้ตรงกับ topic ของคุณ

client.on("connect", () => {
  console.log("MQTT = NAT = connected");

  // สมมติ subscribe ทั้งหมด ด้วย wildcard (จะได้ข้อมูลทุก mc_no)
  client.subscribe("mqtt/nat/2gd/+", (err) => {
    if (err) console.error("Subscribe mqtt error", err);
  });

  client.subscribe("data/nat/2gd/+", (err) => {
    if (err) console.error("Subscribe data error", err);
  });

  client.subscribe("status/nat/2gd/+", (err) => {
    if (err) console.error("Subscribe status error", err);
  });

  client.subscribe("alarm/nat/2gd/+", (err) => {
    if (err) console.error("Subscribe Alarm error", err);
  });
});

// เมื่อได้รับข้อความจาก topic ที่ subscribe

client.on("message", (topic, messageBuffer) => {
  try {
    if (messageBuffer.length < 2) return; // ถ้าส่งมาแค่ตัวเดียวหรือว่างๆ ไม่ต้องทำต่อ
    // 1. จัดการเรื่อง Topic ก่อน
    const parts = topic.split("/");
    const mcNo = parts[3];
    if (!mcNo) return;

    // 2. แปลงและล้างข้อมูลขยะ (Sanitize)
    let rawMessage = messageBuffer.toString("utf8");

    // ลบตัวอักษรที่ไม่ใช่ ASCII (ช่วงที่พิมพ์ไม่ได้) ออกทั้งหมด
    // [^\x20-\x7E] คือการเก็บไว้แค่ตัวอักษร, ตัวเลข และสัญลักษณ์บนคีย์บอร์ด
    const cleanMessage = rawMessage.replace(/[^\x20-\x7E]/g, "");

    // 3. หาขอบเขตของ JSON { ... }
    const firstBrace = cleanMessage.indexOf("{");
    const lastBrace = cleanMessage.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) return;

    const finalJsonStr = cleanMessage.substring(firstBrace, lastBrace + 1);

    // 4. Parse ข้อมูลเพียงครั้งเดียว
    let parsedData;
    try {
      parsedData = JSON.parse(finalJsonStr);
    } catch (e) {
      // ถ้าล้างแล้วยัง Parse ไม่ได้ แสดงว่าโครงสร้าง JSON พังจริง ให้ข้าม Message นี้ไป
      console.error(`[${mcNo}] JSON parse failed after cleaning:`, e.message);
      return;
    }

    // 5. บันทึกลง Cache
    if (!realtimeCache[mcNo]) {
      realtimeCache[mcNo] = { mqtt: [] };
    }

    if (topic.startsWith("mqtt/nat/2gd/")) {
      if (!Array.isArray(realtimeCache[mcNo].mqtt)) {
        realtimeCache[mcNo].mqtt = [];
      }
      realtimeCache[mcNo].mqtt.unshift(parsedData);
      realtimeCache[mcNo].mqtt = realtimeCache[mcNo].mqtt.slice(0, 6);
    } else if (topic.startsWith("data/nat/2gd/")) {
      realtimeCache[mcNo].data = parsedData;
    } else if (topic.startsWith("status/nat/2gd/")) {
      realtimeCache[mcNo].status = parsedData;
    } else if (topic.startsWith("alarm/nat/2gd/")) {
      realtimeCache[mcNo].alarm = parsedData;
    }

    realtimeCache[mcNo].lastUpdate = new Date();
  } catch (err) {
    // ถ้าพังที่ JSON.parse แสดงว่า Data ขยะมันเข้าไปทำลายโครงสร้าง JSON
    console.error("Fatal MQTT Error:", err);
  }
});

function getFullRealtime(mcNo) {
  const cache = realtimeCache[mcNo.toLowerCase()] || {};
  console.log("getFullRealtime cache: ", cache);

  return {
    mc_no: mcNo,
    data: cache.data || null,
    status: cache.status || null,
    alarm: cache.alarm || null,
    mqtt: Array.isArray(cache.mqtt) ? cache.mqtt : [],
    lastUpdate: cache.lastUpdate || null,
  };
}

// ตั้งเวลาตรวจสอบ Cache ทุกๆ 1 นาที
setInterval(() => {
  const now = new Date();
  const timeoutMs = 5 * 60 * 1000; // 5 นาที (ตั้งค่าตามความเหมาะสม)

  Object.keys(realtimeCache).forEach((mcNo) => {
    const lastUpdate = realtimeCache[mcNo].lastUpdate;

    // ถ้าไม่มีการอัปเดตนานเกิน 5 นาที ให้ลบออก
    if (lastUpdate && now - lastUpdate > timeoutMs) {
      console.log(`Cleaning up stale cache for: ${mcNo}`);
      delete realtimeCache[mcNo];
    }
  });

  // แสดงสถานะ Memory (Optional)
  const used = process.memoryUsage().heapUsed / 1024 / 1024;

  if (Math.round(used * 100) / 100 > 1000) {
    console.log(`Current Memory Usage: ${Math.round(used * 100) / 100} MB`);
  }
}, 60000); // รันทุก 60 วินาที

module.exports = {
  realtimeCache,
  getFullRealtime,
};
// Export cache object ให้ route ใช้งาน
// module.exports = { realtimeCache };
