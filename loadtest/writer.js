/**
 * Keeps the load-test rt_* hashes moving, at the per-machine cadence measured
 * against live Redis on 2026-08-03: tb17 ~2s (min 1, max 3), tb22 ~11s
 * (min 1, max 18). Per-machine and cycle-driven, NOT a fixed publisher rate.
 *
 * Runs in its own container so its CPU never lands in backend-loadtest's
 * `docker stats` numbers.
 *
 *   docker compose -f docker-compose.loadtest.yml --profile writer up -d writer
 */
require("dotenv").config({ path: "/app/.env.loadtest" });

const { createClient } = require("redis");
const { devices, key, entry, mulberry32 } = require("./fixture");
const { decodeEntry } = require("/app/util/redisRealtimeReader");

// Distinct from seed.js's seed(42) so the writer's schedule is independent of
// the fixture values, and logged so a run can be reproduced exactly.
const SEED = Number(process.env.WRITER_SEED || 1337);
const rnd = mulberry32(SEED);

const TICK_MS = 100; // batching window, not a per-machine rate

/**
 * Skewed toward fast machines, spanning the measured 1-18s range. Squaring the
 * uniform draw puts the mass near the low end, matching a plant where most
 * machines cycle quickly and a few are slow. A uniform draw would make the mean
 * interval ~9s and halve the write rate.
 */
const drawInterval = () => 1000 + Math.round(rnd() ** 2 * 17000);

/** Resume from what seed.js wrote, so counters stay continuous across a restart. */
const loadState = async (redis) => {
  const raw = await redis.hmGet("rt_data", devices.map((d) => key("data", d)));
  const now = Date.now();
  return devices.map((device, i) => {
    const p = decodeEntry(raw[i])?.payload || {};
    const intervalMs = drawInterval();
    return {
      device,
      intervalMs,
      // Stagger the first tick across one full interval. Without this all 1000
      // machines fire on tick 0 and the write rate oscillates for minutes.
      nextAt: now + Math.floor(rnd() * intervalMs),
      prod_pos4: Number(p.prod_pos4) || 0,
      prod_pos6: Number(p.prod_pos6) || 0,
      prod_drop_pos4: Number(p.prod_drop_pos4) || 0,
      prod_drop_pos6: Number(p.prod_drop_pos6) || 0,
      model: p.model || `MDL-${Math.floor(rnd() * 900 + 100)}`,
      status: "RUN",
      alarm: "NORMAL",
    };
  });
};

const machines = [];
let written = 0;

const tick = async (redis) => {
  const now = Date.now();
  const data = {}, status = {}, alarm = {};

  for (const m of machines) {
    if (now < m.nextAt) continue;
    // Jitter the NEXT interval rather than re-drawing it: a machine's cadence is
    // a property of its cycle, so it should stay recognizably itself run to run.
    m.nextAt = now + Math.round(m.intervalMs * (0.8 + rnd() * 0.4));

    // MONOTONIC. These are cumulative-since-05:00 counters; a random walk that
    // decreases produces negative deltas downstream — silent garbage, no error.
    m.prod_pos4 += 1;
    m.prod_pos6 += 1;
    if (rnd() < 0.02) m.prod_drop_pos4 += 1;
    if (rnd() < 0.02) m.prod_drop_pos6 += 1;

    data[key("data", m.device)] = entry("data", m.device, {
      prod_pos4: m.prod_pos4,
      prod_pos6: m.prod_pos6,
      prod_drop_pos4: m.prod_drop_pos4,
      prod_drop_pos6: m.prod_drop_pos6,
      cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
      model: m.model,
    });

    // Edge-triggered: rt_status and rt_alarm can sit unchanged for minutes, so
    // they are written only on transition, not on every data tick. Writing them
    // every tick would triple the write rate against observed behavior.
    if (rnd() < 0.002) {
      m.status = m.status === "RUN" ? "STOP" : "RUN";
      status[key("status", m.device)] = entry("status", m.device, { status: m.status });
    }
    if (rnd() < 0.001) {
      m.alarm = m.alarm === "NORMAL" ? "ALARM" : "NORMAL";
      alarm[key("alarm", m.device)] = entry("alarm", m.device, { status: m.alarm });
    }
  }

  const writes = [];
  if (Object.keys(data).length) writes.push(redis.hSet("rt_data", data));
  if (Object.keys(status).length) writes.push(redis.hSet("rt_status", status));
  if (Object.keys(alarm).length) writes.push(redis.hSet("rt_alarm", alarm));
  if (writes.length) await Promise.all(writes);

  written += Object.keys(data).length;
};

(async () => {
  const redis = createClient({ url: process.env.NAT_REDIS_URL });
  await redis.connect();
  machines.push(...(await loadState(redis)));

  const mean = machines.reduce((s, m) => s + m.intervalMs, 0) / machines.length;
  console.log(`[writer] seed=${SEED} machines=${machines.length} meanInterval=${Math.round(mean)}ms expected=${(machines.length / (mean / 1000)).toFixed(0)} writes/s`);

  let busy = false;
  setInterval(async () => {
    // Never overlap ticks: a slow Redis would otherwise queue writers behind
    // each other and the reported rate would stop meaning anything.
    if (busy) return;
    busy = true;
    try { await tick(redis); } catch (e) { console.error("[writer]", e.message); }
    busy = false;
  }, TICK_MS);

  setInterval(() => {
    console.log(`[writer] ${(written / 10).toFixed(1)} writes/s`);
    written = 0;
  }, 10_000);
})().catch((e) => { console.error(e); process.exit(1); });
