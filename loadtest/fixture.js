/** Shared fixture vocabulary for seed.js and writer.js. */
const DIV = "nat";
const PROCESS = "tn";
const COUNT = Number(process.env.MACHINE_COUNT || 1000);

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const devices = Array.from({ length: COUNT }, (_, i) => `tb${String(i + 1).padStart(4, "0")}`);

const key = (type, device) => `${type}/${DIV}/${PROCESS}/${device}`;

/** Double-encoded on purpose. redisRealtimeReader.decodeEntry parses twice. */
const entry = (type, device, payload) =>
  JSON.stringify({
    device,
    div: DIV,
    process: PROCESS,
    topic: key(type, device),
    timestamp: new Date().toISOString(),
    payload: JSON.stringify(payload),
  });

module.exports = { DIV, PROCESS, COUNT, mulberry32, devices, key, entry };
