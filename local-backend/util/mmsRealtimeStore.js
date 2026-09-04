/**
 * In-process shadow of the four MMS realtime SSE streams (data, machine-status,
 * alarm-status, status), replacing the Redis rt_* hashes for a single process
 * (e.g. "tn").
 *
 * Why in-process, not shared: this is a prototype for one route. Redis was a
 * shared, durable shadow; this Map is neither — a restart starts blank, and two
 * backend instances each hold their own 4 connections and their own shadow.
 * Fine here; not the shape to scale to all 17 realtime routes without
 * revisiting this. See docs/plans/2026-09-04-nat-tn-realtime-sse.md §1.
 *
 * Two silent-failure traps carried over from the wire format (verified against
 * saved Bruno responses, §2 of the plan):
 *   - Each SSE frame's `data:` line is a JSON ARRAY. One connection can deliver
 *     several devices per event — iterate it, never take [0].
 *   - `payload` is a real object here, NOT a double-encoded JSON string the way
 *     Redis stored it. Do not JSON.parse it a second time.
 *   - For machine-status and alarm-status the useful value is the top-level
 *     `status` field, not `payload.status`.
 *
 * Backoff on reconnect (1s -> 30s cap, jittered) exists so a dead upstream
 * cannot turn into a reconnect storm across four simultaneous streams. A
 * stream ending cleanly (server closed it) reconnects the same way — an SSE
 * stream ending is a normal event here, not an error.
 */

const moment = require("moment");

const STREAMS = [
  {
    name: "data",
    path: "/api/v1/device/realtime/data",
    map: (entry) => {
      const p = entry.payload || {};
      return {
        prod_pos4: p.prod_pos4,
        prod_pos6: p.prod_pos6,
        prod_drop_pos4: p.prod_drop_pos4,
        prod_drop_pos6: p.prod_drop_pos6,
        cycle_time: p.cycle_t,
        model: p.model,
      };
    },
  },
  {
    name: "machine-status",
    path: "/api/v1/device/realtime/machine-status",
    map: (entry) => ({ mqtt_status: entry.status }),
  },
  {
    name: "alarm-status",
    path: "/api/v1/device/realtime/alarm-status",
    map: (entry) => ({ mqtt_alarm: entry.status }),
  },
  {
    name: "status",
    path: "/api/v1/device/realtime/status",
    map: (entry) => ({ broker: (entry.payload || {}).broker }),
  },
];

const ROSTER_INTERVAL_MS = 10 * 60 * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const jitter = (ms) => ms / 2 + Math.random() * (ms / 2);

/**
 * Applies one decoded frame (the array from one `data:` line) for one stream
 * into the shadow map. Exported for the offline test harness — this is the
 * part that touches the wire format, so it is what recorded frames verify.
 *
 * @param {Map<string, object>} shadow
 * @param {Map<string, number>} lastTsMs  newest timestamp seen per device, kept
 *   OUT of the shadow objects themselves: the route spreads shadow entries
 *   straight into response rows, and this bookkeeping value must never appear
 *   there.
 * @param {object} stream  one entry of STREAMS
 * @param {object[]} frame  the parsed array from a single SSE event
 */
const applyFrame = (shadow, lastTsMs, stream, frame) => {
  for (const entry of frame) {
    if (!entry || !entry.device) continue;
    const device = String(entry.device).toLowerCase();
    const fields = stream.map(entry);
    const merged = { ...(shadow.get(device) || {}), ...fields, source: "MMS-SSE" };

    const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ms) && ms > (lastTsMs.get(device) ?? -Infinity)) {
      lastTsMs.set(device, ms);
      // .format() renders LOCAL time. updated_at has always been local
      // (redisRealtimeReader.js did the same); determineMachineStatus diffs it
      // against a local moment(). Do not swap this for toISOString().
      merged.updated_at = moment(ms).format("YYYY-MM-DD HH:mm:ss");
    }

    shadow.set(device, merged);
  }
};

/**
 * Splits a growing text buffer on blank-line-terminated SSE events and yields
 * the JSON-parsed payload of each `data: ...` line found. Returns the leftover
 * (possibly-partial) buffer tail.
 */
const drainEvents = (buffer, onFrame) => {
  let idx;
  // eslint-disable-next-line no-cond-assign
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const rawEvent = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);

    for (const line of rawEvent.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const jsonText = line.slice(5).trim();
      if (!jsonText) continue;
      try {
        const frame = JSON.parse(jsonText);
        if (Array.isArray(frame)) onFrame(frame);
      } catch {
        // One malformed event must not kill the connection.
      }
    }
  }
  return buffer;
};

const createMmsRealtimeStore = ({ baseUrl, apiKey, process: processName }) => {
  const shadow = new Map();
  const lastTsMs = new Map();
  let devices = [];
  let controllers = [];
  let rosterTimer = null;
  let stopped = true;

  const ready = Boolean(baseUrl && apiKey);
  if (!ready) {
    console.warn(
      `mmsRealtimeStore[${processName}]: MMS_REALTIME_URL / MMS_REALTIME_APIKEY not set — store stays idle, all machines will read SIGNAL LOST`,
    );
  }

  const headers = { apikey: apiKey };

  const fetchDevices = async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices`, { headers });
    if (!res.ok) throw new Error(`fetchDevices: ${res.status} ${res.statusText}`);
    const list = await res.json();
    return [...new Set(list.filter((d) => d.process === processName).map((d) => String(d.device).toLowerCase()))].sort();
  };

  const subscribe = (stream, controller) => {
    let attempt = 0;

    const run = async () => {
      if (stopped) return;
      try {
        const url = `${baseUrl}${stream.path}?process=${processName}&devices=${devices.join(",")}`;
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`${stream.name}: ${res.status} ${res.statusText}`);

        attempt = 0; // connected — reset backoff
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          buffer = drainEvents(buffer, (frame) => applyFrame(shadow, lastTsMs, stream, frame));
        }
        // Stream ended cleanly — fall through to reconnect below, same as an error.
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn(`mmsRealtimeStore[${processName}] ${stream.name} stream error: ${err.message}`);
      }

      if (stopped || controller.signal.aborted) return;
      attempt += 1;
      const delay = jitter(Math.min(BACKOFF_MIN_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS));
      setTimeout(run, delay);
    };

    run();
  };

  const openStreams = () => {
    controllers.forEach((c) => c.abort());
    controllers = STREAMS.map((stream) => {
      const controller = new AbortController();
      subscribe(stream, controller);
      return controller;
    });
  };

  const refreshRoster = async () => {
    try {
      const next = await fetchDevices();
      const changed = next.join(",") !== devices.join(",");
      devices = next;
      if (changed) openStreams();
    } catch (err) {
      console.warn(`mmsRealtimeStore[${processName}] roster refresh failed: ${err.message}`);
    }
  };

  const start = async () => {
    if (!ready) return;
    stopped = false;
    await refreshRoster();
    if (devices.length) openStreams();
    rosterTimer = setInterval(refreshRoster, ROSTER_INTERVAL_MS);
  };

  const stop = () => {
    stopped = true;
    if (rosterTimer) clearInterval(rosterTimer);
    controllers.forEach((c) => c.abort());
    controllers = [];
  };

  return {
    start,
    stop,
    getSnapshot: () => shadow,
    getDevices: () => devices,
  };
};

module.exports = { createMmsRealtimeStore, applyFrame, drainEvents, STREAMS };
