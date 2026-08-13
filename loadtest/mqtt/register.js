/**
 * Registers the schemas and devices a multi-process run needs, then exits.
 *
 * Run this once before generator.js, never from it: a load test must not
 * mutate server-side schema as a side effect of measuring throughput.
 *
 * The two halves have deliberately different failure policies:
 *
 *   columns — FATAL. An unregistered column is dropped silently by the
 *     consumer (same failure mode as the exact-string matching in values.js),
 *     so a run against an unregistered process would insert near-empty rows,
 *     look fast, and mean nothing.
 *
 *   devices — WARN ONLY. Measured 2026-08-10: the MQTT ingest path does not
 *     consult the device registry, and an unregistered device still reaches
 *     Redis, Kafka and ClickHouse. Registration is a read-side concern (does
 *     the dashboard list the machine?) and must not block a throughput run.
 *     See §2 of ../../docs/mqtt-ingest-load-test.md.
 *
 * Idempotent: schemas are deterministic for a given PROCESSES/SCHEMA_COLUMNS,
 * so re-running registers the identical set. An already-registered column is
 * reported, not treated as a new failure.
 */
require("dotenv").config({ path: "/loadtest/.env.vm" });

const { PROCESSES, allocate } = require("./devices");
const { schemaFor, toRegistrationBody } = require("./schemas");

const COUNT = Number(process.env.COUNT || 1000);
const SCHEMA_COLUMNS = Number(process.env.SCHEMA_COLUMNS || 40);
const REGISTER_DEVICES = process.env.REGISTER_DEVICES !== "false";
// Prints exactly what would be sent without sending it. This POSTs to a shared
// server that other people's dashboards read from — being able to check the
// body first is worth the one flag.
const DRY_RUN = process.env.DRY_RUN === "true";
// Registering 1000 devices one request at a time is slow enough to look hung;
// wide enough to matter, narrow enough not to be its own load test.
const DEVICE_CONCURRENCY = 8;

const AUTH_API = process.env.AUTH_API;
const COLUMNS_API = process.env.COLUMNS_API;
const DEVICES_API = process.env.DEVICES_API;

const login = async () => {
  const res = await fetch(AUTH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.API_USERNAME, password: process.env.API_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  // The response envelope is not documented; accept the shapes it might use
  // rather than guessing one and failing with an unhelpful "undefined token".
  const token = body.access_token || body.token || body.data?.token || body.data?.access_token;
  if (!token) throw new Error(`login succeeded but no token found in response: ${JSON.stringify(body)}`);
  return token;
};

const registerColumns = async (token, process_, columns) => {
  const body = toRegistrationBody(process_, columns);
  if (DRY_RUN) {
    console.log(`[reg] DRY_RUN columns process=${process_} n=${columns.length}`);
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const res = await fetch(COLUMNS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`columns/batch failed for process=${process_}: ${res.status} ${text}`);
  console.log(`[reg] columns process=${process_} n=${columns.length} -> ${res.status}`);
};

const registerDevices = async (token, machines) => {
  if (DRY_RUN) {
    console.log(`[reg] DRY_RUN devices n=${machines.length} (first: ${JSON.stringify(machines[0])})`);
    return;
  }
  let ok = 0;
  const failures = new Map(); // status -> count, so 1000 identical 401s print once
  const queue = [...machines];
  const worker = async () => {
    for (let m = queue.pop(); m; m = queue.pop()) {
      try {
        const res = await fetch(DEVICES_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ process: m.process, device: m.device }),
        });
        if (res.ok) ok++;
        else failures.set(res.status, (failures.get(res.status) || 0) + 1);
      } catch (e) {
        failures.set(e.message, (failures.get(e.message) || 0) + 1);
      }
    }
  };
  await Promise.all(Array.from({ length: DEVICE_CONCURRENCY }, worker));

  console.log(`[reg] devices registered=${ok}/${machines.length}`);
  for (const [reason, n] of failures) {
    console.warn(`[reg] WARNING: ${n} device registrations failed with ${reason} — ingest is unaffected, dashboard visibility is not`);
  }
};

(async () => {
  for (const name of ["AUTH_API", "COLUMNS_API", "DEVICES_API"]) {
    if (!process.env[name]) throw new Error(`${name} is not set in /loadtest/.env.vm`);
  }

  const machines = allocate(COUNT);
  console.log(
    `[reg] processes=${PROCESSES.join(",")} count=${COUNT} schema_columns=${SCHEMA_COLUMNS} dry_run=${DRY_RUN}`
  );

  // Built before the first request so an over-wide or malformed schema throws
  // before anything has been written to a shared server.
  const schemas = PROCESSES.map((p) => ({ process: p, columns: schemaFor(p, SCHEMA_COLUMNS) }));

  const token = DRY_RUN ? "dry-run" : await login();

  for (const { process: p, columns } of schemas) await registerColumns(token, p, columns);

  if (REGISTER_DEVICES) await registerDevices(token, machines);
  else console.log("[reg] devices skipped (REGISTER_DEVICES=false)");

  console.log("[reg] done");
})().catch((e) => {
  console.error(`[reg] FAILED: ${e.message}`);
  process.exit(1);
});
