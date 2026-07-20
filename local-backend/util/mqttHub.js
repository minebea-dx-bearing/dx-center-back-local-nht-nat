/**
 * Shared MQTT client per broker URL. Replaces the per-file `mqtt.connect(...)` +
 * `subscribe("#")` pattern that was running 17+ separate clients against 2–3 brokers.
 *
 * Usage:
 *   const { getHub } = require("../util/mqttHub");
 *   const hub = getHub(`mqtt://${process.env.NAT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`);
 *   hub.register({
 *     accepts:    (mc_no) => mcNoBelongsToThisStore(mc_no),
 *     onMessage:  (mc_no, payload, topic) => { ... store live update ... },
 *   });
 *
 * One TCP connection per broker URL, one JSON.parse per message, fan-out to all
 * matching handlers in registration order.
 *
 * Payload sanitization: incoming messages are stripped of ASCII/Latin-1 control
 * characters (\x00–\x1F, \x7F–\x9F) before JSON.parse. Some device publishers
 * (e.g. NAT mbr_f03, NHT MBR machines) embed raw control bytes inside string
 * literals, which violates RFC 8259 and breaks JSON.parse. Stripping is the
 * minimal fix that preserves real data while recovering bad payloads.
 */

const mqtt = require("mqtt");

const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F-\x9F]/g; // * matches ASCII control characters (0x00–0x1F) and Latin-1 control characters (0x7F–0x9F)

const hubs = new Map(); 
/*
Creates a global broker-URL → hub cache.

It stores one MQTT hub per broker URL so multiple stores can share the same TCP connection instead of each creating its own.

Example:
getHub("mqtt://broker1:1883") → reuses same hub for all processes using broker1
getHub("mqtt://broker2:1883") → separate hub for broker2

So if 10 stores all connect to NAT_MQTT_MC_SHOP, they share one MQTT client instead of 10, reducing memory and TCP overhead.
*/

const createHub = (brokerUrl) => {
  const handlers = []; // * each handler is { accepts: (mc_no) => boolean, onMessage: (mc_no, payload, topic) => void }, and they are called in registration order when a message arrives for a matching mc_no
  const client = mqtt.connect(brokerUrl);
  const baseTopic = "data/#";
  const realtimeCache = {};

  client.on("connect", () => {
    console.info(`[mqttHub] connected to ${brokerUrl}`);

    client.subscribe("#", (err) => {
      if (err) console.error(`[mqttHub] subscribe error for ${brokerUrl}:`, err);
      else console.info(`[mqttHub] subscribed to # on ${brokerUrl}`);
    });
  });

  client.on("error", (err) => {
    console.error(`[mqttHub] client error on ${brokerUrl}:`, err.message);
  });

  client.on("message", (topic, message) => {
    // 1. ตัดเครื่องหมาย / ที่อาจจะหลงมาท้ายประวัติต่างๆ ออกก่อน
    const cleanTopic = topic.endsWith('/') ? topic.slice(0, -1) : topic;
    const parts = cleanTopic.split("/");
    
    // สมมติโครงสร้างเป็น [ "data", "MC01" ] หรือ [ "status", "MC01" ]
    // parts[0] จะเป็นชื่อหัวข้อ (data, status, alarm)
    // parts[1] จะเป็นชื่อเครื่องจักร (mc_no)
    const topicType = parts[0]; 
    const mc_no = parts.pop(); // หยิบตัวที่ 2 เสมอ เพื่อความแม่นยำ

    // เช็คเผื่อไว้ถ้าแกะ mc_no ไม่ได้ (เช่น topic ส่งมาสั้นเกินไป) ให้ข้ามไปเลย
    if (!mc_no) return;

    let payload;
    try {
      const cleaned = message.toString().replace(CONTROL_CHAR_REGEX, "");
      payload = JSON.parse(cleaned);
    } catch (err) {
      console.error(`[mqttHub] JSON parse error on topic ${topic}: ${err.message}`);
      return;
    }

    // สร้างพื้นที่เก็บข้อมูลของเครื่องนี้ถ้ายังไม่มี
    if (!realtimeCache[mc_no]) {
      realtimeCache[mc_no] = {};
    }
  
    // 2. ใช้ topicType ที่เราแยกไว้ด้านบนในการจัดหมวดหมู่ข้อมูล
    if (topicType === "data") {
      realtimeCache[mc_no].data = payload;
    } else if (topicType === "status") {
      realtimeCache[mc_no].status = payload;
    } else if (topicType === "alarm") {
      realtimeCache[mc_no].alarm = payload;
    }else if (topicType === "mqtt") {
      realtimeCache[mc_no].mqtt = payload;
    }
    // console.log(topic, realtimeCache)
      
    // 3. ส่งข้อมูลใน cache ตัวที่อัปเดตเต็มๆ ไปให้ handler ใช้งาน 
    // (เปลี่ยนจากส่งเฉพาะ payload ของ topic นั้นๆ เป็นส่ง realtimeCache[mc_no] ก้อนที่รวมร่างแล้วแทน)
    for (const h of handlers) { 
      if (h.accepts(mc_no)) { 
        try {
          // ส่ง realtimeCache[mc_no] ไปแทน payload เดี่ยวๆ 
          // เพื่อให้ฝั่งที่เอาไปใช้งาน ได้ข้อมูลครบทั้ง data, status, alarm ของเครื่องนั้นๆ
          h.onMessage(mc_no, realtimeCache[mc_no], topic); 
        } catch (err) {
          console.error(`[mqttHub] handler error for mc_no ${mc_no}:`, err.message);
        }
      }
    }
  });

  return {
    register: (handler) => {
      handlers.push(handler); // * new handlers are added to the end of the list, so they run after existing handlers for the same mc_no. This allows more specific handlers to run before more general ones if needed.
    },
    _client: client, // exposed for diagnostics/tests only
    _handlerCount: () => handlers.length,
  };
};


const getHub = (brokerUrl) => {
  if (!hubs.has(brokerUrl)) {
    hubs.set(brokerUrl, createHub(brokerUrl));
  }
  return hubs.get(brokerUrl);
};

module.exports = { getHub };
