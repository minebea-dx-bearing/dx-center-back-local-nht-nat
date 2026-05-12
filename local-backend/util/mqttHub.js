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

const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F-\x9F]/g;

const hubs = new Map(); // brokerUrl -> Hub

const createHub = (brokerUrl) => {
  const handlers = [];
  const client = mqtt.connect(brokerUrl);

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
    const mc_no = topic.split("/").pop();
    let payload;
    try {
      const cleaned = message.toString().replace(CONTROL_CHAR_REGEX, "");
      payload = JSON.parse(cleaned);
    } catch (err) {
      console.error(`[mqttHub] JSON parse error on topic ${topic}: ${err.message}`);
      return;
    }
    for (const h of handlers) {
      if (h.accepts(mc_no)) {
        try {
          h.onMessage(mc_no, payload, topic);
        } catch (err) {
          console.error(`[mqttHub] handler error for mc_no ${mc_no}:`, err.message);
        }
      }
    }
  });

  return {
    register: (handler) => {
      handlers.push(handler);
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
