/**
 * MQTT ingest load generator. Targets the VM broker (`loadtest/.env.vm`) and
 * publishes bare, single-encoded JSON on `{data|status|alarm|mqtt}/nat/tn/<device>`
 * — see the Context section of the plan this implements
 * (docs/plans/2026-08-10-mqtt-ingest-generator.md) for why that shape differs
 * from the double-encoded envelope stored downstream in Redis.
 *
 * Runs as a Node `cluster` primary + N workers, one worker owning a
 * contiguous device shard driven by a single 10ms scheduler loop, mirroring
 * ../writer.js retargeted from Redis to MQTT.
 */
require("dotenv").config({ path: "/loadtest/.env.vm" });

const cluster = require("node:cluster");
const fs = require("node:fs");
const path = require("node:path");
const mqtt = require("mqtt");
const { allocate, PROCESSES, topic, macFor } = require("./devices");
const { schemaFor } = require("./schemas");
const { newMachineState, buildDataPayload } = require("./payload");
const { STATUS_VALUES, ALARM_VALUES } = require("./values");

const COUNT = Number(process.env.COUNT || 1000);
const WORKERS = Number(process.env.WORKERS || 4);
const SCHEMA_COLUMNS = Number(process.env.SCHEMA_COLUMNS || 40);
const CONN_MODE = process.env.CONN_MODE || "per-device"; // "per-device" | "pooled"
const POOL_SIZE = Number(process.env.POOL_SIZE || 20);
const QOS = Number(process.env.QOS || 0);
const DURATION_S = Number(process.env.DURATION_S || 60); // 0 = until killed
const RUN_ID = process.env.RUN_ID || String(Date.now());
const TICK_MS = 10;
// Per-machine, per-topic cadence — each fires on its own schedule instead of
// a shared RATE_HZ or a dice roll, so data/status/alarm/mqtt can be tuned
// independently to match observed device behavior.
const DATA_INTERVAL_S = Number(process.env.DATA_INTERVAL_S || 1);
const STATUS_INTERVAL_S = Number(process.env.STATUS_INTERVAL_S || 300);
const ALARM_INTERVAL_S = Number(process.env.ALARM_INTERVAL_S || 300);
const MQTT_INTERVAL_S = Number(process.env.MQTT_INTERVAL_S || 300);

const MQTT_URL = `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`;

if (cluster.isPrimary) {
  // Every report line is echoed to a per-run file, not just stdout — stdout
  // scrolls out of a terminal's buffer, and nothing else in this tool
  // persists a run's results (unlike ../run-sweep.sh's per-scenario files).
  const RESULTS_DIR = "/loadtest/mqtt/results";
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const logPath = path.join(RESULTS_DIR, `${RUN_ID}.log`);
  const log = (line) => {
    console.log(line);
    fs.appendFileSync(logPath, line + "\n");
  };

  const counts = new Array(WORKERS).fill(0);
  // status/alarm/mqtt are low-frequency by design and left out of the
  // target/s figure — data dominates volume and is what achieved/s tracks.
  const targetPerSecond = COUNT / DATA_INTERVAL_S;

  log(
    `[gen] run=${RUN_ID} startedAt=${new Date().toISOString()} count=${COUNT} data_interval_s=${DATA_INTERVAL_S} status_interval_s=${STATUS_INTERVAL_S} alarm_interval_s=${ALARM_INTERVAL_S} mqtt_interval_s=${MQTT_INTERVAL_S} workers=${WORKERS} conn_mode=${CONN_MODE} qos=${QOS} duration_s=${DURATION_S} target=${targetPerSecond}/s processes=${PROCESSES.join(",")} schema_columns=${SCHEMA_COLUMNS}`
  );

  for (let id = 0; id < WORKERS; id++) {
    const worker = cluster.fork({ WORKER_ID: String(id) });
    worker.on("message", (msg) => {
      if (msg?.type === "published") counts[id] = msg.total;
    });
  }

  let lastTotal = 0;
  const REPORT_MS = 10_000;
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const total = counts.reduce((a, b) => a + b, 0);
    const achieved = Math.round((total - lastTotal) / (REPORT_MS / 1000));
    lastTotal = total;
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const t = Math.round((Date.now() - startedAt) / 1000);

    log(`[gen] t=${t}s target=${targetPerSecond}/s achieved=${achieved}/s clients=${COUNT} rssMB=${rssMB}`);
    if (achieved < targetPerSecond * 0.95) {
      log(
        `[gen] WARNING: achieved (${achieved}/s) is below 95% of target (${targetPerSecond}/s) — the generator, not the VM, may be the bottleneck`
      );
    }

    if (DURATION_S > 0 && t >= DURATION_S) {
      clearInterval(interval);
      log(`[gen] run=${RUN_ID} finished totalPublished=${total}`);
      for (const w of Object.values(cluster.workers)) w.send({ type: "stop" });
      setTimeout(() => process.exit(0), 2000);
    }
  }, REPORT_MS);
} else {
  const workerId = Number(process.env.WORKER_ID);
  // (process, device) pairs in stable allocation order, sliced the same way
  // ../shard.js splits a flat device list — contiguous, gap-free, overlap-free.
  const allMachines = allocate(COUNT);
  const base = Math.floor(allMachines.length / WORKERS);
  const extra = allMachines.length % WORKERS;
  const shardStart = workerId * base + Math.min(workerId, extra);
  const shardSize = base + (workerId < extra ? 1 : 0);
  const shard = allMachines.slice(shardStart, shardStart + shardSize);
  // One schema lookup per process, not per machine — schemaFor("tn") builds
  // (and re-validates) the same 39-column list on every call otherwise.
  const schemaCache = new Map();
  const schemaForProcess = (p) => {
    if (!schemaCache.has(p)) schemaCache.set(p, schemaFor(p, SCHEMA_COLUMNS));
    return schemaCache.get(p);
  };

  let published = 0;
  let stopping = false;
  process.on("message", (msg) => {
    if (msg?.type === "stop") stopping = true;
  });

  const clients = new Map(); // device -> mqtt client (per-device mode)
  const pool = []; // shared clients (pooled mode)

  const publish = (client, t, payload, qos) => {
    client.publish(t, JSON.stringify(payload), { qos });
    published++;
  };

  const connectStaggered = async (pairs) => {
    // 1000 simultaneous CONNECTs is a thundering herd that tests connection
    // handling, not steady-state throughput — spread them across a few seconds.
    const spreadMs = Math.min(5000, pairs.length * 5);
    const ready = [];
    for (let i = 0; i < pairs.length; i++) {
      const { device } = pairs[i];
      await new Promise((r) => setTimeout(r, spreadMs / pairs.length));

      const client = mqtt.connect(MQTT_URL, { clientId: device });
      clients.set(device, client);
      // An unhandled 'error' event is a Node uncaught exception — without
      // this listener, one failed connect silently kills the whole worker
      // (and every device in its shard) with no visible cause.
      client.on("error", (e) => console.error(`[gen] worker=${workerId} device=${device} mqtt error: ${e.message}`));
      // Registered here, at creation time — not in a separate loop after this
      // one finishes. With enough devices, the stagger loop itself can take
      // longer than a connect round-trip, so an early client's `connect`
      // event can fire and be lost before a later-registered listener exists,
      // permanently hanging the caller's readiness wait.
      // No longer publishes here — the `mqtt` topic now fires on its own
      // recurring schedule in the tick loop below, same as status/alarm.
      ready.push(new Promise((resolve) => client.once("connect", resolve)));
    }
    await Promise.all(ready);
  };

  const dataIntervalMs = DATA_INTERVAL_S * 1000;
  const statusIntervalMs = STATUS_INTERVAL_S * 1000;
  const alarmIntervalMs = ALARM_INTERVAL_S * 1000;
  const mqttIntervalMs = MQTT_INTERVAL_S * 1000;
  // TICK_MS is the scheduler's own poll granularity — at an interval short
  // enough that intervalMs < TICK_MS, a single poll must fire more than once
  // per machine to keep up (e.g. a 1ms interval needs 10 fires per 10ms
  // poll). Capped at 3x the nominal expectation so a genuinely overloaded
  // run degrades (a lower `achieved`, visibly) instead of a growing
  // unbounded backlog spiraling the process further behind every tick.
  const maxCatchup = (intervalMs) => Math.max(1, Math.ceil((TICK_MS / intervalMs) * 3));
  const maxCatchupData = maxCatchup(dataIntervalMs);
  const maxCatchupStatus = maxCatchup(statusIntervalMs);
  const maxCatchupAlarm = maxCatchup(alarmIntervalMs);
  const maxCatchupMqtt = maxCatchup(mqttIntervalMs);

  // Phase offset spreads each topic's publishes evenly across its own
  // interval instead of every machine in the shard bursting together —
  // scaled by position within the shard so it works for both a 1s data
  // interval and a 300s status/alarm/mqtt interval.
  const phase = (i, intervalMs) => Math.round((i / Math.max(1, shard.length)) * intervalMs);

  const machines = shard.map(({ process: proc, device }, i) => {
    const now = Date.now();
    return {
      process: proc,
      device,
      state: newMachineState(proc, device, Number(process.env.RUN_ID_SEED || 1) + i, schemaForProcess(proc)),
      seq: 0,
      status: "run",
      nextDataAt: now + phase(i, dataIntervalMs),
      nextStatusAt: now + phase(i, statusIntervalMs),
      nextAlarmAt: now + phase(i, alarmIntervalMs),
      nextMqttAt: now + phase(i, mqttIntervalMs),
    };
  });

  (async () => {
    if (CONN_MODE === "pooled") {
      const ready = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const client = mqtt.connect(MQTT_URL, { clientId: `${RUN_ID}-w${workerId}-p${i}` });
        client.on("error", (e) => console.error(`[gen] worker=${workerId} pool=${i} mqtt error: ${e.message}`));
        pool.push(client);
        // Listener registered at creation time, same reasoning as connectStaggered.
        ready.push(new Promise((resolve) => client.once("connect", resolve)));
      }
      await Promise.all(ready);
    } else {
      await connectStaggered(shard);
    }

    const clientFor = (device, idx) => (CONN_MODE === "pooled" ? pool[idx % POOL_SIZE] : clients.get(device));

    let busy = false;

    setInterval(() => {
      // Guard against overlapping ticks: a slow broker would otherwise queue
      // ticks behind each other and the reported rate stops meaning anything.
      if (busy || stopping) return;
      busy = true;
      const now = Date.now();

      for (let i = 0; i < machines.length; i++) {
        const m = machines[i];
        const client = clientFor(m.device, i);
        if (!client) continue;

        // Catch-up loop, not a single `if`: at an interval short enough that
        // intervalMs < TICK_MS, one poll must fire multiple times per
        // machine to hit target — a single `if` here would silently cap
        // every machine at 1000/TICK_MS regardless of the configured
        // interval (measured 2026-08-10 with the old RATE_HZ scheme:
        // RATE_HZ=1000 only achieved ~95-98/s before this fix).
        for (let fired = 0; now >= m.nextDataAt && fired < maxCatchupData; fired++) {
          m.nextDataAt += dataIntervalMs;
          m.seq++;
          const marker = `${RUN_ID}-${m.device}-${m.seq}`;
          publish(client, topic("data", m.process, m.device), buildDataPayload(m.state, marker), QOS);
        }
        if (now >= m.nextDataAt) m.nextDataAt = now + dataIntervalMs;

        for (let fired = 0; now >= m.nextStatusAt && fired < maxCatchupStatus; fired++) {
          m.nextStatusAt += statusIntervalMs;
          m.status = STATUS_VALUES[Math.floor(m.state.rnd() * STATUS_VALUES.length)];
          publish(client, topic("status", m.process, m.device), { status: m.status }, QOS);
        }
        if (now >= m.nextStatusAt) m.nextStatusAt = now + statusIntervalMs;

        for (let fired = 0; now >= m.nextAlarmAt && fired < maxCatchupAlarm; fired++) {
          m.nextAlarmAt += alarmIntervalMs;
          const alarm = ALARM_VALUES[Math.floor(m.state.rnd() * ALARM_VALUES.length)];
          publish(client, topic("alarm", m.process, m.device), { status: alarm }, QOS);
        }
        if (now >= m.nextAlarmAt) m.nextAlarmAt = now + alarmIntervalMs;

        for (let fired = 0; now >= m.nextMqttAt && fired < maxCatchupMqtt; fired++) {
          m.nextMqttAt += mqttIntervalMs;
          publish(
            client,
            topic("mqtt", m.process, m.device),
            { mac_id: macFor(m.device), broker: 1, modbus: 1, version: "2.1.0" },
            QOS
          );
        }
        if (now >= m.nextMqttAt) m.nextMqttAt = now + mqttIntervalMs;
      }

      busy = false;

      if (process.send) process.send({ type: "published", total: published });
    }, TICK_MS);
  })().catch((e) => {
    // Without this, a rejected promise anywhere in setup (e.g. a connect
    // that never resolves for a reason other than the race above) leaves the
    // worker silently reporting 0 forever instead of explaining why.
    console.error(`[gen] worker=${workerId} setup failed:`, e);
    process.exit(1);
  });
}
