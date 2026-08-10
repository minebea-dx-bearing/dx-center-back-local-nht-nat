/**
 * Device identity for the MQTT ingest generator.
 *
 * Device IDs are `test000`-`test999`. The `test` prefix is load-bearing: it is
 * what makes synthetic rows separable from real `tb*` devices in ClickHouse
 * forever, so a cleanup query can never touch production data.
 */
const DIV = process.env.DIV || "nat";
const PROCESS = process.env.PROCESS || "tn";

const deviceIds = (count) =>
  Array.from({ length: count }, (_, i) => `test${String(i).padStart(3, "0")}`);

const topic = (type, device) => `${type}/${DIV}/${PROCESS}/${device}`;

/** Deterministic locally-administered MAC, derived from the device index. */
const macFor = (device) => {
  const n = Number(device.slice(4));
  const hex = (v) => v.toString(16).toUpperCase().padStart(2, "0");
  return ["02", "00", "5E", hex((n >> 16) & 0xff), hex((n >> 8) & 0xff), hex(n & 0xff)].join(":");
};

module.exports = { DIV, PROCESS, deviceIds, topic, macFor };
