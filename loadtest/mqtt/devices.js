/**
 * Device identity for the MQTT ingest generator.
 *
 * Device IDs are `test000`-`test999`. The `test` prefix is load-bearing: it is
 * what makes synthetic rows separable from real `tb*` devices in ClickHouse
 * forever, so a cleanup query can never touch production data.
 *
 * A machine is identified by a `(process, device)` pair, not a device alone —
 * the same device id under two processes is two different topics. Device ids
 * are nevertheless allocated in **disjoint** ranges per process rather than
 * restarting at `test000` for each: if anything downstream keys on device
 * alone, overlapping ids would silently merge two machines' rows into one
 * series, and no rate or count metric in verify.md would ever surface it.
 */
const DIV = process.env.DIV || "nat";

/**
 * Processes to publish under. `tn` alone is the single-process baseline that
 * results/capacity.md was measured with; adding names here splits the same
 * COUNT machines across more processes (and therefore more schemas).
 */
const PROCESSES = (process.env.PROCESSES || process.env.PROCESS || "tn")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const deviceId = (n) => `test${String(n).padStart(3, "0")}`;

const deviceIds = (count) => Array.from({ length: count }, (_, i) => deviceId(i));

/**
 * Splits `count` machines across `processes`, evenly, with the remainder going
 * to the earliest processes. Returns `(process, device)` pairs in a stable
 * order — the generator shards this list by index, so the same COUNT/PROCESSES
 * always produces the same worker-to-machine assignment across runs.
 */
const allocate = (count, processes = PROCESSES) => {
  const per = Math.floor(count / processes.length);
  const remainder = count % processes.length;
  const machines = [];
  let next = 0;
  for (let p = 0; p < processes.length; p++) {
    const size = per + (p < remainder ? 1 : 0);
    for (let i = 0; i < size; i++) machines.push({ process: processes[p], device: deviceId(next++) });
  }
  return machines;
};

const topic = (type, process, device) => `${type}/${DIV}/${process}/${device}`;

/** Deterministic locally-administered MAC, derived from the device index. */
const macFor = (device) => {
  const n = Number(device.slice(4));
  const hex = (v) => v.toString(16).toUpperCase().padStart(2, "0");
  return ["02", "00", "5E", hex((n >> 16) & 0xff), hex((n >> 8) & 0xff), hex(n & 0xff)].join(":");
};

module.exports = { DIV, PROCESSES, deviceId, deviceIds, allocate, topic, macFor };
