/**
 * `data/<div>/<process>/<device>` payload builders.
 *
 * Two builders, dispatched on process, deliberately not one:
 *
 *   tn        — the real, measured device payload. Field list verified
 *               2026-08-10 against `DESCRIBE TABLE` on the real ClickHouse
 *               sink (ground truth), not the §4 sample in
 *               ../../docs/mqtt-ingest-load-test.md, which turned out to both
 *               mis-split one field (its `forming_bit_1r` is actually two real
 *               columns, `forming_1r` and `facing_bit_1r`) and omit two real
 *               columns (`production_total`, `qa_reject`). `spec` and `id_num`
 *               are still sent — real devices send them (§4) — but they map to
 *               no ClickHouse column, so the ingest consumer silently drops
 *               them; that is expected, not a loss.
 *
 *   synthetic — parametric, driven by a schema from schemas.js, used by the
 *               `lt*` processes of the multi-process test.
 *
 * A single type-driven builder cannot reproduce tn: `rssi`, `time_hr` and
 * `time_min` are Int32 but are not counters, `cycle_t` has a specific band,
 * and the *order* of PRNG calls during seeding determines every value that
 * follows. Routing tn through the generic path would quietly change the
 * control run and invalidate results/capacity.md — the one thing
 * docs/plans/2026-08-13-multi-process-multi-schema-load-test.md forbids.
 */

const { TN_COUNTER_FIELDS, roleFor } = require("./schemas");

// Duplicated from ../fixture.js rather than shared: a 6-line PRNG is cheaper
// than a shared package between two independent harnesses.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const COUNTER_FIELDS = TN_COUNTER_FIELDS;

const FIELD_COUNT = COUNTER_FIELDS.length + 7; // + rssi, cycle_t, time_hr, time_min, model, spec, id_num

// ---------------------------------------------------------------------------
// tn — do not refactor. Every line below is the 2026-08-10 implementation, and
// its output is pinned field-for-field by payload.test.js.
// ---------------------------------------------------------------------------

const newTnState = (device, seed) => {
  const rnd = mulberry32(seed);
  const counters = {};
  for (const f of COUNTER_FIELDS) counters[f] = Math.floor(rnd() * 5000);
  // model is a ClickHouse String column, not numeric — set once per machine
  // like ../writer.js does for its Redis equivalent.
  return { device, rnd, counters, rssi: -30 - Math.floor(rnd() * 40), model: `MDL-${Math.floor(rnd() * 900 + 100)}` };
};

const buildTnPayload = (state, marker) => {
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

// ---------------------------------------------------------------------------
// synthetic — parametric, one value per registered column
// ---------------------------------------------------------------------------

/** ClickHouse DateTime literal. ISO-8601's `T`/`Z` are not accepted by it. */
const clickhouseDateTime = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

const newSyntheticState = (device, seed, columns) => {
  const rnd = mulberry32(seed);
  const counters = {};
  const consts = {};
  // Seeded in column order, so a wider schema's first N columns seed
  // identically to a narrower one's — the width axis of the sweep varies the
  // number of columns and nothing else.
  for (const { name, type } of columns) {
    const role = roleFor(type);
    if (role === "counter") counters[name] = Math.floor(rnd() * 5000);
    else if (role === "const") consts[name] = `${name}-${Math.floor(rnd() * 900 + 100)}`;
  }
  return { device, rnd, columns, counters, consts };
};

const buildSyntheticPayload = (state, marker) => {
  const { rnd, columns, counters, consts } = state;
  const payload = {};
  for (const { name, type } of columns) {
    switch (roleFor(type)) {
      case "counter":
        // Same 50% advance rate as tn's counters, so a synthetic process's
        // values change at the same cadence the control run's do.
        if (rnd() < 0.5) counters[name] += 1;
        payload[name] = counters[name];
        break;
      case "jitter":
        payload[name] = Number((1.0 + rnd() * 3).toFixed(3));
        break;
      case "const":
        payload[name] = consts[name];
        break;
      case "bool":
        payload[name] = rnd() < 0.5;
        break;
      case "now":
        payload[name] = clickhouseDateTime(new Date());
        break;
    }
  }
  // Carried on synthetic payloads too: verify.md traces a run by `id_num`, and
  // it is dropped by the consumer here for the same reason it is on tn (no
  // matching column), so it costs a registered column nothing. `spec` is a
  // tn-device quirk with no synthetic analogue and is not emitted.
  payload.id_num = marker;
  return payload;
};

// ---------------------------------------------------------------------------

const newMachineState = (process, device, seed, columns) =>
  process === "tn"
    ? { kind: "tn", ...newTnState(device, seed) }
    : { kind: "synthetic", ...newSyntheticState(device, seed, columns) };

const buildDataPayload = (state, marker) =>
  state.kind === "tn" ? buildTnPayload(state, marker) : buildSyntheticPayload(state, marker);

module.exports = {
  newMachineState,
  buildDataPayload,
  newTnState,
  buildTnPayload,
  FIELD_COUNT,
  COUNTER_FIELDS,
};
