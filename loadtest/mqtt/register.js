/**
 * One-time device registration against the VM API, so the `test*` machines
 * appear on the dashboard. Not required for ingest — see §2 of
 * ../../docs/mqtt-ingest-load-test.md.
 *
 *   docker compose -f ../../docker-compose.mqttgen.yml run --rm -e COUNT=1000 gen node /loadtest/mqtt/register.js
 */
require("dotenv").config({ path: "/loadtest/.env.vm" });

const axios = require("axios");
const { deviceIds, PROCESS } = require("./devices");

const COUNT = Number(process.env.COUNT || 1000);
const CONCURRENCY = 10;

const login = async () => {
  const res = await axios.post(process.env.AUTH_API, {
    username: process.env.API_USERNAME,
    password: process.env.API_PASSWORD,
  });
  // Field name is unverified against the real API — log the shape on failure
  // below rather than guessing silently.
  const token = res.data?.token || res.data?.access_token || res.data?.accessToken;
  if (!token) {
    console.error("[register] login response shape:", JSON.stringify(res.data));
    throw new Error("could not find a token field in the login response");
  }
  return token;
};

const registerOne = async (device, token) => {
  try {
    await axios.post(
      process.env.DEVICES_API,
      { process: PROCESS, device },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return "ok";
  } catch (e) {
    const status = e.response?.status;
    const body = JSON.stringify(e.response?.data || "");
    // Measured 2026-08-10 against the real API: a re-registration is a 400,
    // not a 409, with "already registered" in the detail — not "already exists".
    if (status === 409 || /already (registered|exists)/i.test(body)) return "exists";
    console.error(`[register] ${device} failed: ${status} ${body}`);
    return "failed";
  }
};

// Simple concurrency-capped pool: CONCURRENCY workers pull from a shared
// index. A real API, not a target for the generator's own throughput.
const runPool = async (items, limit, fn) => {
  let i = 0;
  const results = [];
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
};

(async () => {
  const token = await login();
  const devices = deviceIds(COUNT);
  const results = await runPool(devices, CONCURRENCY, (d) => registerOne(d, token));

  const ok = results.filter((r) => r === "ok").length;
  const exists = results.filter((r) => r === "exists").length;
  const failed = results.filter((r) => r === "failed").length;

  console.log(`registered: ${ok} ok, ${exists} already-existed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("[register]", e.message);
  process.exit(1);
});
