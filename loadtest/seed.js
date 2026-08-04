/**
 * Seeds the load-test stack with N machines: master rows in MSSQL and
 * rt_* entries in Redis.
 *
 * Runs INSIDE the backend container so it reuses that container's node_modules
 * and its .env.loadtest — which is also the safety property that matters. It
 * cannot reach production because the container cannot.
 *
 *   docker compose -f docker-compose.loadtest.yml exec backend node /app/../loadtest/seed.js
 *
 * (See Task 5 for the exact invocation; the loadtest dir is mounted separately.)
 */
require("dotenv").config({ path: "/app/.env.loadtest" });

const { Sequelize } = require("sequelize");
const { createClient } = require("redis");
const { PROCESS, COUNT, mulberry32, devices, entry: fixtureEntry } = require("./fixture");

const DIV = "nat";
const DB = process.env.MASTER_DB;

// Fixed seed: two runs must produce identical data, or two runs are not
// comparable. Math.random() here would make every sweep a different test.
const rnd = mulberry32(42);

// ---------------------------------------------------------------------------
// MSSQL: database, table, 1000 master rows
// ---------------------------------------------------------------------------

const seedMaster = async () => {
  // No `database` key: connects to the server default (master), which is what
  // lets us CREATE DATABASE. trustServerCertificate is required against the
  // container's self-signed cert — production connects to a trusted host and
  // therefore does not set it.
  const dbms = new Sequelize({
    dialect: "mssql",
    host: process.env.NAT_SERVER,
    username: process.env.NAT_SERVER_USERNAME,
    password: process.env.NAT_SERVER_PASSWORD,
    logging: false,
    dialectOptions: { options: { trustServerCertificate: true, encrypt: false, requestTimeout: 60000 } },
  });

  await dbms.authenticate();

  await dbms.query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE [${DB}];`);
  // Column set mirrors the SELECT in util/masterStorage.js exactly, including
  // created_at, which its ROW_NUMBER() window orders by.
  await dbms.query(`
    IF OBJECT_ID('[${DB}].[dbo].[master_mc_storage_tb]') IS NULL
    CREATE TABLE [${DB}].[dbo].[master_mc_storage_tb] (
      id INT IDENTITY(1,1) PRIMARY KEY,
      mc_no VARCHAR(50), process VARCHAR(50), part_no VARCHAR(50),
      target_ct FLOAT, target_utl FLOAT, target_yield FLOAT,
      target_special FLOAT, ring_factor FLOAT,
      created_at DATETIME DEFAULT GETDATE()
    );`);
  await dbms.query(`DELETE FROM [${DB}].[dbo].[master_mc_storage_tb] WHERE process = '${PROCESS}';`);

  // Batched: 1000 single INSERTs over a container round trip takes minutes.
  const CHUNK = 200;
  for (let i = 0; i < devices.length; i += CHUNK) {
    const values = devices.slice(i, i + CHUNK).map((d) => {
      const ct = (1.2 + rnd() * 2.5).toFixed(2);
      return `('${d}', '${PROCESS}', 'part${d.slice(2)}', ${ct}, 85, 98, 0, ${(0.8 + rnd() * 0.4).toFixed(3)})`;
    });
    await dbms.query(`
      INSERT INTO [${DB}].[dbo].[master_mc_storage_tb]
        (mc_no, process, part_no, target_ct, target_utl, target_yield, target_special, ring_factor)
      VALUES ${values.join(",")};`);
  }

  const [rows] = await dbms.query(`SELECT COUNT(*) AS n FROM [${DB}].[dbo].[master_mc_storage_tb] WHERE process = '${PROCESS}';`);
  await dbms.close();
  return rows[0].n;
};

// ---------------------------------------------------------------------------
// Redis: rt_data / rt_status / rt_alarm / rt_mqtt
// ---------------------------------------------------------------------------

const entry = fixtureEntry;

const seedRedis = async () => {
  const redis = createClient({ url: process.env.NAT_REDIS_URL });
  await redis.connect();

  const data = {}, status = {}, alarm = {}, mqtt = {};

  for (const d of devices) {
    const key = (t) => `${t}/${DIV}/${PROCESS}/${d}`;
    // Varied values matter more than they look: near-identical rows gzip at
    // ~36x and would make the payload appear 3x smaller than reality. Real
    // varied data measured ~10x. See docs/load-testing-and-performance.md §7.
    data[key("data")] = entry("data", d, {
      prod_pos4: Math.floor(rnd() * 5000),
      prod_pos6: Math.floor(rnd() * 5000),
      prod_drop_pos4: Math.floor(rnd() * 50),
      prod_drop_pos6: Math.floor(rnd() * 50),
      cycle_t: Number((1.0 + rnd() * 3).toFixed(3)),
      model: `MDL-${Math.floor(rnd() * 900 + 100)}`,
    });
    // ~90% running, matching a plant where most machines are up. An all-running
    // fixture would skip the SIGNAL LOSE / offline branches entirely.
    status[key("status")] = entry("status", d, { status: rnd() < 0.9 ? "RUN" : "STOP" });
    alarm[key("alarm")] = entry("alarm", d, { status: rnd() < 0.05 ? "ALARM" : "NORMAL" });
    mqtt[key("mqtt")] = entry("mqtt", d, { broker: "mosquitto" });
  }

  await redis.del(["rt_data", "rt_status", "rt_alarm", "rt_mqtt"]);
  await Promise.all([
    redis.hSet("rt_data", data),
    redis.hSet("rt_status", status),
    redis.hSet("rt_alarm", alarm),
    redis.hSet("rt_mqtt", mqtt),
  ]);

  const n = await redis.hLen("rt_data");
  await redis.quit();
  return n;
};

(async () => {
  const master = await seedMaster();
  const live = await seedRedis();
  console.log(`seeded: ${master} master rows, ${live} rt_data entries`);
  if (master !== COUNT || live !== COUNT) {
    console.error(`MISMATCH: expected ${COUNT} of each`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
