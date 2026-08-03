/**
 * Shared node-redis client, one per URL. Mirrors the connection-sharing intent
 * of util/mqttHub.js: routes that read the same Redis must not each open their
 * own socket.
 *
 * Reconnect is handled by node-redis itself. We never throw on connection loss
 * at module load — a dead Redis must degrade the affected route, not prevent
 * the whole server from booting.
 */

const { createClient } = require("redis");

const clients = new Map();

const getRedis = (url = process.env.NAT_REDIS_URL) => {
  if (clients.has(url)) return clients.get(url);

  const client = createClient({
    url,
    password: process.env.NAT_REDIS_PASSWORD || undefined,
    database: Number(process.env.NAT_REDIS_DB || 0),
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5_000) },
  });

  client.on("error", (err) => console.error(`[redis] ${url}:`, err.message));
  client.on("ready", () => console.info(`[redis] connected ${url}`));
  client.connect().catch((err) => console.error(`[redis] initial connect failed:`, err.message));

  clients.set(url, client);
  return client;
};

module.exports = { getRedis };
