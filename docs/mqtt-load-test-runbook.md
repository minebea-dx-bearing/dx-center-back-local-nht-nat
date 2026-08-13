# MQTT Ingest Load-Test Runbook (Windows)

Step-by-step for running the MQTT ingest generator ([loadtest/mqtt/](../loadtest/mqtt/))
yourself. This is the **write-side** harness — it targets the real VM's
Mosquitto broker, not the local Docker stack. If you want the local
**read-side** harness instead (1000 simulated viewers against Redis), see
[load-test-runbook.md](load-test-runbook.md) — different tool, different doc,
they share nothing but style.

For *why* this tool is shaped the way it is (topic format, valid status/alarm
values, why the payload has the fields it has), see
[mqtt-ingest-load-test.md](mqtt-ingest-load-test.md) first. This doc is the
"how do I run it and read the output" companion — it assumes you've already
read that once.

Commands below use Git Bash syntax (`MSYS_NO_PATHCONV=1` prefix) since that's
what this repo's sessions have used so far; if you're in `cmd.exe` instead,
drop that prefix — cmd doesn't rewrite container paths the way Git Bash does
(see [load-test-runbook.md](load-test-runbook.md)'s gotcha table for that
distinction if you hit `Cannot find module '/app/C:/Program Files/...'`).

## 0. Prerequisites

- **Docker Desktop running.** If `docker compose` fails with
  `open //./pipe/dockerDesktopLinuxEngine: ... cannot find`, start it and retry.
- **`loadtest/.env.vm` filled in** with real VM credentials (gitignored —
  never commit it). See [mqtt-ingest-load-test.md §1](mqtt-ingest-load-test.md#1-create-the-vm-env-file).
- **The image built.** The generator reuses `backend-dx_center`'s
  `node_modules` purely for the `mqtt` package — it doesn't have its own
  Dockerfile:
  ```bash
  docker compose -f docker-compose.loadtest.yml build backend
  ```
  Confirm it worked and `mqtt` resolves:
  ```bash
  MSYS_NO_PATHCONV=1 docker compose -f docker-compose.mqttgen.yml run --rm gen node -e "console.log(require('mqtt/package.json').version)"
  ```
  Expect a `5.x` version string.

**Before you publish anything real:** this targets a live VM shared with
whatever else is running against it. Nothing here is "safe by default" the
way a local Docker Compose stack is — a bad `COUNT` or a forgotten
`DURATION_S=0` (runs forever) sends real traffic to a real broker. Start
small (`COUNT=1`, `DURATION_S=60`) and work up.

## 1. Register devices (one-time, optional)

Not required for ingest to work (see
[mqtt-ingest-load-test.md §2](mqtt-ingest-load-test.md#2-register-one-test-device-optional--see-note)) —
only needed so `test*` machines show up on the dashboard.

```bash
MSYS_NO_PATHCONV=1 docker compose -f docker-compose.mqttgen.yml run --rm -e COUNT=3 gen node /loadtest/mqtt/register.js
```

- `COUNT` — how many of `test000`…`test999` to register. Try `3` first.

Expected output: `registered: N ok, M already-existed, K failed`. `K` should
always be `0` — anything else means the VM API rejected a registration for a
real reason (check the printed error body). Once the small run looks right,
scale to the full `COUNT=1000`.

## 2. Run the generator

```bash
MSYS_NO_PATHCONV=1 docker compose -f docker-compose.mqttgen.yml run --rm \
  -e COUNT=1 -e WORKERS=1 -e DATA_INTERVAL_S=1 -e DURATION_S=60 -e RUN_ID=my-first-run gen
```

### What each `-e` means and why it matters

| Var | Meaning | Start with | Why |
|---|---|---|---|
| `COUNT` | How many simulated machines (`test000`…`test999`) | `1` | Each one opens its own MQTT connection and publishes independently. This is the main throughput dial — `COUNT / DATA_INTERVAL_S` is your target message rate. |
| `DATA_INTERVAL_S` | Seconds between `data` messages, per machine | `1` | Real devices cycle every 1–18s (§ [mqtt-ingest-load-test.md](mqtt-ingest-load-test.md)); `1` is a deliberate stress target, not a realistic simulation. Raise it if you want a realistic-cadence comparison run. |
| `STATUS_INTERVAL_S` | Seconds between `status` messages, per machine | `300` (default) | Status changes are infrequent by design — fires on its own per-machine schedule independent of `data`. |
| `ALARM_INTERVAL_S` | Seconds between `alarm` messages, per machine | `300` (default) | Same cadence model as `STATUS_INTERVAL_S`, independent schedule. |
| `MQTT_INTERVAL_S` | Seconds between `mqtt` (device-info) messages, per machine | `300` (default) | Previously sent once at connect only; now recurs on this interval like the other topics. |
| `WORKERS` | Node `cluster` worker processes, each owning a slice of `COUNT` | `1` for small runs, `4` (default) for `COUNT` ≥ 100 | One worker running 1000 machines on a single event-loop thread is the generator's own bottleneck, not the broker's. More workers spread the scheduling load across CPU cores. |
| `DURATION_S` | Run length in seconds | `60` | `0` means **run until killed** — don't use that by accident, it'll quietly keep publishing to the VM indefinitely. |
| `RUN_ID` | A label baked into each message's `id_num` marker (`<RUN_ID>-<device>-<seq>`) | anything memorable, e.g. `smoke-01` | `id_num` does **not** reach ClickHouse (see §3.1 below) — but it's still useful in Mosquitto/Kafka-side inspection, and it's how you tell your own runs apart in logs. |
| `CONN_MODE` | `per-device` (default, one TCP connection per machine) or `pooled` (shared connections) | leave at default unless throughput-limited | `per-device` is what a real plant looks like — it's what makes `mosquitto_clients_connected` meaningful. Only switch to `pooled` if Task 8's ramp shows the generator itself capping out (see [results/capacity.md](../loadtest/mqtt/results/capacity.md) — as of 2026-08-10 this hasn't happened up to 1000 machines). |
| `QOS` | MQTT QoS level, `0` or `1` | `0` | QoS 0 is fire-and-forget — some message loss is normal and not itself a bug (a 2026-08-10 run delivered 598/600, 99.7%, at QoS 0). `1` guarantees delivery but changes what you're measuring — mixing QoS levels between runs makes them incomparable. |
| `POOL_SIZE` | Clients per worker, `pooled` mode only | `20` (default) | Irrelevant unless `CONN_MODE=pooled`. |

## 3. Read the output

Every 10 seconds you'll see one line like:

```
[gen] t=30s target=10/s achieved=10/s clients=1 rssMB=49
```

- **`t`** — seconds since the run started.
- **`target`** — `COUNT / DATA_INTERVAL_S`, the `data`-topic rate you asked
  for (status/alarm/mqtt are low-frequency and excluded from this figure).
- **`achieved`** — the rate the generator actually managed to publish, measured
  from its own publish count, **not** from anything the broker or ClickHouse
  confirms received. This tells you whether *the generator* kept up — it says
  nothing about whether the VM did.
- **`clients`** — echoes `COUNT` back, so you can tell runs apart at a glance
  in a scrollback full of similar lines.
- **`rssMB`** — the worker process's memory. Flat across a run is healthy;
  climbing steadily with QoS 0 usually means the generator is publishing
  faster than the OS socket buffer can drain — i.e. the generator, not the
  broker, is falling behind.

**If you see a `WARNING: achieved (...) is below 95% of target` line**, stop
and think before drawing any conclusion about the VM — that warning means
*this PC*, not the broker, is the likely bottleneck for this run. Check
[results/capacity.md](../loadtest/mqtt/results/capacity.md) first: if this
`COUNT` is at or above the highest one tested there, you're in genuinely
untested territory for this hardware and should re-run the Task 8 ramp
before trusting anything past that point.

### 3.1. Where the run's output goes

**Automatically saved** (fixed 2026-08-10) to
`loadtest/mqtt/results/<RUN_ID>.log` — every line the generator prints to
stdout is also appended there, plus a header line (the run's config) and a
footer line (`totalPublished`) that never appear on stdout. This means
`RUN_ID` doubles as your filename — pick something you can find again later,
not the default timestamp, if you want to keep a run.

This mirrors what the k6 harness's `run-sweep.sh` already does
([load-test-runbook.md §5](load-test-runbook.md)), just simpler — one `.log`
per run instead of `.log`/`.json`/`.stats`, since the generator doesn't have
k6's structured summary export to draw from.

`loadtest/mqtt/results/` is gitignored except `capacity.md` — run logs stay
local to your machine, which is appropriate for raw run output.

## 4. Verify what actually landed in ClickHouse

The generator's `achieved` number only proves the generator tried to publish
that many messages — not that they arrived. To check actual delivery, see
[../loadtest/mqtt/verify.md](../loadtest/mqtt/verify.md), which has the
ready-to-fill-in queries. Short version of what's available and what isn't,
**measured against the real table on 2026-08-10**:

| You want to check | Can you? | How |
|---|---|---|
| How many messages actually arrived | Yes | `count()` by `device` + a `created_at` time window (verify.md §1) |
| Whether loss is spread evenly or concentrated in a few machines | Yes | Same, `GROUP BY device` (verify.md §3) |
| Whether counters ever went backwards (reordering) | Yes, across buckets only | `created_at` only has **10-second** resolution — same-bucket reordering is invisible (verify.md §5) |
| Per-message marker lookup (`id_num`) | **No** | Confirmed absent from the real schema — `id_num` and `spec` are sent over MQTT but silently dropped before the ClickHouse insert |
| Per-message end-to-end latency (p50/p95) | **No**, not with this schema | `created_at`'s 10s bucketing means every message in a bucket reads the same timestamp regardless of when it actually published (verify.md §4) |

If precise latency ever becomes a real requirement, it needs either a real
per-row timestamp column upstream (ask whoever owns the ClickHouse schema) or
a Kafka-side measurement (consumer offset time vs. produce time) instead —
not something fixable from this side.

## 5. Establishing capacity before trusting a big run

Before running anything above a few hundred machines and drawing conclusions
from it, check [../loadtest/mqtt/results/capacity.md](../loadtest/mqtt/results/capacity.md).
It records the highest `COUNT` this generator has been proven to sustain
(`achieved` tracking `target` within ~1–2%) — as of 2026-08-10, that's the
full 1000 machines / 10,000 msg/s, with flat memory throughout. If you're
running on different hardware or the number needs re-checking, redo the ramp
yourself:

```bash
# DATA_INTERVAL_S=0.1 reproduces the old RATE_HZ=10 stress cadence (10 data msg/s/machine)
for n in 10 50 100 250 500 1000; do
  MSYS_NO_PATHCONV=1 docker compose -f docker-compose.mqttgen.yml run --rm \
    -e COUNT=$n -e DATA_INTERVAL_S=0.1 -e DURATION_S=60 -e RUN_ID=ramp-$n gen
done
```

Watch for a `COUNT` where `achieved` drops below 95% of `target` — that's
the ceiling. Below that ceiling, a bad result is telling you something real
about the VM. At or above it, a bad result might just be this PC.

## Known gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `pull access denied for backend-dx_center` | Image never built locally | `docker compose -f docker-compose.loadtest.yml build backend` |
| `Cannot find module '/loadtest/C:/Program Files/Git/loadtest/...'` | Git Bash rewrote the container path | Prefix the command with `MSYS_NO_PATHCONV=1` (Git Bash only — not needed in `cmd.exe`) |
| Registration reports a device as `failed` when it's actually already registered | The real API returns `400` with `"already registered"` in the body, not `409` — a bug in `register.js` fixed 2026-08-10 | Should not recur; if it does, the API's error shape has changed again and `register.js`'s match needs updating |
| `achieved` reads far higher than `target` and stays that way | A scheduling bug where each machine's next-publish time was recomputed from a shared, constantly-reset clock instead of its own — fixed 2026-08-10 | Should not recur on current code |
| `achieved=0/s` for an entire run, only at higher `COUNT` | A race where the "wait for all clients connected" listener was registered *after* some clients had already connected and fired the event — fixed 2026-08-10 | Should not recur on current code; see [results/capacity.md](../loadtest/mqtt/results/capacity.md) for the full story |
| A ClickHouse query using `id_num` returns nothing / errors on unknown column | That column doesn't exist on the real table | Use `device` + `created_at` range instead — see §4 above and [verify.md](../loadtest/mqtt/verify.md) |
| ClickHouse client returns `Only RowBinaryWithNameAndTypes and JSONEachRow are supported` | You're on a JDBC-based client, not raw `clickhouse-client` CLI | Drop any `FORMAT` clause from the query entirely |
