/**
 * `data/nat/tn/<device>` payload builder.
 *
 * Field list verified 2026-08-10 against `DESCRIBE TABLE` on the real
 * ClickHouse sink (ground truth), not the §4 sample in
 * ../../docs/mqtt-ingest-load-test.md, which turned out to both mis-split one
 * field (its `forming_bit_1r` is actually two real columns, `forming_1r` and
 * `facing_bit_1r`) and omit two real columns (`production_total`,
 * `qa_reject`). `spec` and `id_num` are still sent — real devices send them
 * (§4) — but they map to no ClickHouse column, so the ingest consumer
 * silently drops them; that is expected, not a loss.
 */

// Duplicated from ../fixture.js rather than shared: a 6-line PRNG is cheaper
// than a shared package between two independent harnesses.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const COUNTER_FIELDS = [
  "production_total", "prod_pos4", "prod_pos6", "prod_drop_pos4", "prod_drop_pos6",
  "utilization", "prod_utl", "wait_qa_check", "prod_ok", "total_reject",
  "line_reject", "qa_reject", "total_adjust", "prod_total_1r", "forming_1r",
  "facing_bit_1r", "recess3_1r", "cutoff_1_1r", "recess5_1r", "cutoff_2_1r",
  "drill_1r", "partcheck_1r", "prod_bar_1r", "od_bit_1r", "prod_total_2r",
  "forming_2r", "drill_2r", "center_drill_2r", "facing_2r", "reamer_2r",
  "recess_2r", "cutoff_2r", "partcheck_2r", "prod_bar_2r",
];

const FIELD_COUNT = COUNTER_FIELDS.length + 7; // + rssi, cycle_t, time_hr, time_min, model, spec, id_num

const newMachineState = (device, seed) => {
  const rnd = mulberry32(seed);
  const counters = {};
  for (const f of COUNTER_FIELDS) counters[f] = Math.floor(rnd() * 5000);
  // model is a ClickHouse String column, not numeric — set once per machine
  // like ../writer.js does for its Redis equivalent.
  return { device, rnd, counters, rssi: -30 - Math.floor(rnd() * 40), model: `MDL-${Math.floor(rnd() * 900 + 100)}` };
};

const buildDataPayload = (state, marker) => {
  const { rnd } = state;
  for (const f of COUNTER_FIELDS) {
    // Monotonic: these are cumulative-since-shift counters on the real
    // device. A decrease produces negative deltas downstream, silently.
    if (rnd() < 0.5) state.counters[f] += 1;
  }
  // Jitter within a plausible dBm band, clamped so it never drifts out.
  state.rssi = Math.max(-95, Math.min(-30, state.rssi + Math.round((rnd() - 0.5) * 4)));

  const now = new Date();
  return {
    rssi: state.rssi,
    ...state.counters,
    cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
    time_hr: now.getHours(),
    time_min: now.getMinutes(),
    model: state.model,
    spec: 0,
    id_num: marker,
  };
};

module.exports = { newMachineState, buildDataPayload, FIELD_COUNT, COUNTER_FIELDS };
