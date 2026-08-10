# MQTT Ingest Load Test — Phase A: One Machine (Windows cmd.exe)

Establishes the **chain of custody** for a single synthetic machine publishing
into the VM stack (Mosquitto → Redis / Kafka → ClickHouse), before any load is
applied.

This is deliberately manual. Phase A's job is not to measure throughput — it is
to answer *"where does a message actually go, and does it arrive intact?"* Every
later number is uninterpretable without that answer.

Read [load-test-runbook.md](load-test-runbook.md) first if you haven't; that one
covers the **local read-side** harness (1000 viewers against Redis). This one
covers the **VM write-side** ingest path. They share nothing but style.

> **Safety:** this runbook targets a real VM. Every command here is a read or a
> publish of a `test*` device. Nothing deletes, truncates, or touches a `tb*`
> device. Keep it that way.

## 0. Prerequisites

- **Docker Desktop running** on your PC. We use throwaway containers for
  `mosquitto_pub`/`mosquitto_sub` rather than installing an MQTT client —
  nothing to install, nothing left behind.
- **SSH access to the VM**, and your user in the `docker` group there (or
  `sudo`). Verify before starting:
  ```cmd
  ssh <VM_USER>@<VM_HOST> "docker ps --format \"table {{.Names}}\t{{.Image}}\""
  ```
  Expect to see the mosquitto, redis, kafka, and clickhouse containers. **Write
  their exact container names down** — every step below needs them, and they
  vary per deployment.
- **Prometheus reachable** from your browser (and ideally Grafana). You'll read
  baselines from it in step 3.

## 1. Create the VM env file

Create `loadtest/.env.vm`. It is gitignored (root `.gitignore`).

```
VM_HOST=x.x.x.x
AUTH_API=http://x.x.x.x:8001/auth/login
DEVICES_API=http://x.x.x.x:xxxx/api/v1/devices
API_USERNAME=xxxx
API_PASSWORD=xxxx
MQTT_HOST=x.x.x.x
MQTT_PORT=1883
DIV=nat
PROCESS=tn
```

**Do not put any of this in `local-backend/.env.loadtest`.** That file is loaded
into the local backend container by `docker-compose.loadtest.yml`, and
[mqttHub.js:48](../local-backend/util/mqttHub.js#L48) subscribes to `#` — a VM
broker URL in that file means your local backend silently ingests the VM's
entire firehose. Separate files, no exceptions.

## 2. Register one test device (optional — see note)

> **Measured 2026-08-10: registration is NOT required for ingest.** The first
> Phase A run hit `401 Authentication required` on this step, and `test001`
> still landed in Redis, Kafka, and ClickHouse purely by publishing. The MQTT
> ingest path does not consult the device registry. Registration is therefore a
> **read-side** concern (does the dashboard list the machine?), not an
> ingest-side one, and it is **not** on the critical path for load testing.
>
> Keep this step for dashboard-visibility testing; skip it when the goal is
> throughput.

The API requires a bearer token. Log in first:

```cmd
curl -s -X POST "http://x.x.x.x:8001/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"xxxx\",\"password\":\"xxxx\"}"
```

Copy the token out of the response, then:

```cmd
curl -i -X POST "http://x.x.x.x:xxxx/api/v1/devices" -H "Content-Type: application/json" -H "Authorization: Bearer <TOKEN>" -d "{\"process\":\"tn\",\"device\":\"test001\"}"
```

Expect `2xx`. A `401` here no longer blocks Phase A — proceed to step 3 either
way, and note which state you're in so the dashboard result is interpretable
later.

**Never put credentials on the command line in a committed file.** They live in
`loadtest/.env.vm`, which is gitignored. Phase B's generator reads them from
there and does the login itself.

**Why `test001` and not `tb9001`:** every synthetic machine stays greppable and
separable from real data forever. A later ClickHouse `WHERE device LIKE 'test%'`
can never touch a production row. Carry this convention to 1000
(`test0001`…`test1000`).

Confirm it registered — if the API has a `GET`:
```cmd
curl -s "http://x.x.x.x:xxxx/api/v1/devices" -H "Authorization: Bearer <TOKEN>"
```

## 3. Record the idle baseline

**Do this before publishing anything.** A metric without a baseline is a number,
not a measurement.

In Prometheus, record the current value of each:

| Stack | Query |
|---|---|
| Mosquitto | `mosquitto_messages_received_total`, `mosquitto_messages_sent_total`, `mosquitto_clients_connected` |
| Redis | `redis_commands_processed_total`, `redis_memory_used_bytes`, `redis_keyspace_hits_total` |
| Kafka | `kafka_server_brokertopicmetrics_messagesin_total`, consumer group lag |
| ClickHouse | `ClickHouseProfileEvents_InsertedRows`, `ClickHouseAsyncMetrics_MaxPartCountForPartition` |
| Host | CPU %, memory, disk I/O |

Also confirm the VM is genuinely idle — if the real plant is publishing into
this broker, your one message lands in a moving stream and the counters below
won't isolate cleanly. Note the ambient rate now.

## 4. Watch the broker while you publish

Open **two** cmd windows.

**Window 1 — subscribe** (this proves the broker accepted and redistributed the
message, independently of anything downstream):

```cmd
docker run --rm -it eclipse-mosquitto mosquitto_sub -h x.x.x.x -p 1883 -t "data/nat/tn/test001" -t "status/nat/tn/test001" -t "alarm/nat/tn/test001" -t "mqtt/nat/tn/test001" -v
```

Leave it running.

**Window 2 — publish.** The `id_num` field carries a unique marker *and* the
publish time in one string; it appears unused by the payload schema, which makes
it the natural carrier. Everything else mirrors the real `tb22` payload shape.

First register the device's identity topics (published once, like a real device
booting):

```cmd
docker run --rm eclipse-mosquitto mosquitto_pub -h x.x.x.x -p 1883 -t "mqtt/nat/tn/test001" -m "{\"mac_id\":\"10:20:BA:5F:76:38\",\"broker\":1,\"modbus\":1,\"version\":\"2.1.0\"}"

docker run --rm eclipse-mosquitto mosquitto_pub -h x.x.x.x -p 1883 -t "status/nat/tn/test001" -m "{\"status\":\"RUN\"}"

docker run --rm eclipse-mosquitto mosquitto_pub -h x.x.x.x -p 1883 -t "alarm/nat/tn/test001" -m "{\"status\":\"NORMAL\"}"
```

Then the marked data message. **Note the exact wall-clock time you run this.**

```cmd
docker run --rm eclipse-mosquitto mosquitto_pub -h x.x.x.x -p 1883 -t "data/nat/tn/test001" -m "{\"rssi\":-72,\"prod_pos4\":0,\"prod_pos6\":6246,\"prod_drop_pos4\":0,\"prod_drop_pos6\":154,\"utilization\":36502,\"prod_utl\":0,\"wait_qa_check\":0,\"prod_ok\":0,\"total_reject\":0,\"line_reject\":0,\"total_adjust\":0,\"prod_total_1r\":0,\"forming_bit_1r\":7344,\"recess3_1r\":7344,\"cutoff_1_1r\":7344,\"recess5_1r\":7344,\"cutoff_2_1r\":7344,\"drill_1r\":0,\"partcheck_1r\":1344,\"prod_bar_1r\":22196,\"od_bit_1r\":1021,\"prod_total_2r\":6246,\"forming_2r\":20609,\"drill_2r\":20608,\"center_drill_2r\":29544,\"facing_2r\":41213,\"reamer_2r\":6822,\"recess_2r\":13299,\"cutoff_2r\":20606,\"partcheck_2r\":605,\"prod_bar_2r\":5027,\"cycle_t\":153,\"time_hr\":9,\"time_min\":34,\"model\":0,\"spec\":0,\"id_num\":\"PHASE-A-0001\"}"
```

Window 1 must echo the message back. **If it doesn't, stop here** — nothing
downstream matters until the broker itself works. See the gotchas table.

## 5. Walk the chain, hop by hop

The marker is `PHASE-A-0001`. Find it — or find where it dies.

### 5a. Redis

```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli HGET rt_data data/nat/tn/test001"
```

If that returns nil, the key naming on the VM may differ from the local harness.
Discover it:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli --scan --pattern '*test001*'"
ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli KEYS 'rt_*'"
```

Note whether the stored value is **single- or double-encoded JSON**. Locally,
[fixture.js:18](../loadtest/fixture.js#L18) double-encodes and
[redisRealtimeReader.js](../local-backend/util/redisRealtimeReader.js) parses
twice. If the VM stores it differently, that is a finding worth writing down —
it silently produces zeros rather than errors.

> **Measured 2026-08-10:** the VM stores the same double-encoded envelope —
> `{device, div, process, topic, timestamp, payload:"<stringified JSON>"}` —
> so [fixture.js](../loadtest/fixture.js) `entry()` matches the wire format and
> the generator can reuse it. `timestamp` is nanosecond-precision RFC3339
> (`2026-08-10T03:41:14.732326126Z`), i.e. produced by a Go service, distinct
> from the Python/uvicorn service that serves `/auth/login`.

### 5b. Kafka

List topics first — you don't know the naming:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <KAFKA_CONTAINER> kafka-topics.sh --bootstrap-server localhost:9092 --list"
```

Then read the tail of the likely topic:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <KAFKA_CONTAINER> kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic <TOPIC> --from-beginning --max-messages 200 --timeout-ms 10000"
```

Look for `PHASE-A-0001`. Record which topic carried it, and whether the payload
was transformed on the way (field renames, envelope added, type coercion).

Also capture the consumer groups — you'll need them for lag in Phase C:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <KAFKA_CONTAINER> kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list"
```

### 5c. ClickHouse

Discover the schema:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <CH_CONTAINER> clickhouse-client -q 'SHOW DATABASES'"
ssh <VM_USER>@<VM_HOST> "docker exec <CH_CONTAINER> clickhouse-client -q 'SHOW TABLES FROM <DB>'"
ssh <VM_USER>@<VM_HOST> "docker exec <CH_CONTAINER> clickhouse-client -q 'DESCRIBE TABLE <DB>.<TABLE>'"
```

Then find the marker:
```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <CH_CONTAINER> clickhouse-client -q \"SELECT * FROM <DB>.<TABLE> WHERE id_num = 'PHASE-A-0001' FORMAT Vertical\""
```

**This is the pass/fail of Phase A.** One row, all 37 fields matching what you
published, is the proof the whole pipeline works. Compare the row's ingest
timestamp against the wall-clock time you noted in step 4 — that difference is
your first end-to-end latency figure.

If the row is there but fields are wrong (zeros, nulls, truncated strings),
**that is the most valuable possible finding** and the entire reason Phase A
exists. Rates would have looked perfect.

> **Corrected 2026-08-10, during Phase B:** `id_num` is **not** a ClickHouse
> column on the real ingest table — `DESCRIBE TABLE` confirms it, along with
> `spec`. Both are sent over MQTT (real devices send them, per §4) but the
> ingest consumer silently drops them before the ClickHouse insert; that is
> expected, not a bug. The query above cannot work as written. Marker-based
> lookup is dead for this table; verify by `device` + a `created_at` time
> window instead (`created_at` is also bucketed to 10s, not per-message — see
> [../loadtest/mqtt/verify.md](../loadtest/mqtt/verify.md) for the corrected
> approach and the real column list).

### 5d. Resolve any topic type that didn't arrive

> **Measured 2026-08-10:** `data`, `status`, and `mqtt` arrived at all three
> hops. **`alarm` arrived at none of them** — including Redis, the first hop.
> That rules out a ClickHouse insert failure: an insert failure shows the record
> present in Kafka and absent in ClickHouse. Absent at hop 1 means the event was
> never produced, so the cause is at or before the MQTT ingest consumer.

When one topic type is missing everywhere, isolate it before scaling — a
generator that publishes a silently-discarded topic wastes broker capacity on
messages that were never going to count.

Three candidates, cheapest first:

1. **The publish never happened.** Confirm your `mosquitto_sub` window echoed
   *four* lines, not three.
2. **Key naming differs** for that type on the VM.
3. **The consumer filters by value** — e.g. persists only non-`NORMAL` alarms.

Test 3 directly, since it also covers 1:

```cmd
docker run --rm eclipse-mosquitto mosquitto_pub -h <MQTT_HOST> -p 1883 -t "alarm/nat/tn/test001" -m "{\"status\":\"COVER OPEN\"}"
```

Then compare your device against a **real** one — the control tells you the
exact key format and value shape that is known to work:

```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli HGET rt_alarm alarm/nat/tn/test001"
ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli HGET rt_alarm alarm/nat/tn/tb22"
```

> **Resolved 2026-08-10:** republishing `{"status":"COVER OPEN"}` for `test001`
> landed at all three hops. The consumer **validates the alarm value against a
> known set** and silently discards unrecognized ones — `NORMAL` is not an alarm
> code, so it never becomes an event. Not a bug; behavior to model.
>
> Consequence for the generator: **alarm values must be drawn from values known
> to be accepted**, or the run measures a discard path while looking like data
> loss. Sample the real ones rather than guessing an enum:
>
> ```cmd
> ssh <VM_USER>@<VM_HOST> "docker exec <REDIS_CONTAINER> redis-cli HGETALL rt_alarm"
> ```
>
> Exact string match matters — copy values byte for byte, including any trailing
> characters.

With that resolved, all four topic types (`data`, `status`, `mqtt`, `alarm`) are
confirmed to traverse Mosquitto → Redis → Kafka → ClickHouse intact.

## 5e. Reference values the generator must use

Collected from the VM's status/alarm master table on 2026-08-10. The generator
draws from these sets; inventing values produces messages that are silently
discarded (see 5d).

### `status/nat/tn/<device>` — 5 values, lowercase

```text
run    stop    wait    alarm    other
```

**`offline` is NOT publishable.** Real devices show `"status":"offline"`, but it
is absent from the master set — it is *derived downstream* from staleness, the
same way [determineMachineStatus.js](../local-backend/util/determineMachineStatus.js)
does it locally. The generator must never publish `offline`; a soak test that
stops publishing should *expect* machines to transition to it on their own, and
that transition is a useful soak assertion.

Note the master table keys `process` as the number `10`, while
`POST /api/v1/devices` takes `"process":"tn"`. Two identifiers for one concept —
don't mix them up.

Case: `RUN` (uppercase) was accepted in step 4 despite the master set being
lowercase, so status is either case-insensitive or not validated at all. Emit
lowercase — correct under every interpretation.

### `alarm/nat/tn/<device>` — 60 values

```text
RPM NEG LIMIT OVER          RPM POS LIMIT OVER          DROP PARTS 5PCS 2ND CUT
FOOT WORK COUNTER OVER      MAIN MOTOR STOP             END BAR RECEIVER NOT HOME
WIDTH SMALL COUNTER         DRILL CONTROL OVER LIMIT    COVER OPEN
BATTERY SCREEN LOW          SPINDLE RPM NG              AIR PRESSURE DROP
SAFETY HANDLE               LUBE SPINDLE                OVER LOAD
AUTO FIRE                   WIDTH SMALL 3PCS            DATA FEED OVER
SAFETY CHACKING             GEAR OIL LOW                DRILL OUT
EMG STOP                    DROP PARTS 5PCS 1ST CUT     AUTO BAR FEEDER ERROR
FULL CHIP CONVEYOR          PART DROP POS 4             OVER LOAD MOTOR GE
INPUT VALUES R.P.M D        GEAR R.P.M NO SETTIN        THE MACHINE DOES NC
COMPRESSED AIR PRESS        R.P.M SPINDLE LOW           PART DROP NO SETTING
BAR CUT NO SETTING          CNT 8 NO SETTING            HIGH VALUE NOT MORE
REAR DOOR OPEN              EMERGENCE PUSHTBUT          OVER LOAD MOTOR HI
OVER LOAD MOTOR CO          INVERTER CONVEYOR M         INVERTER MAIN MOTO
OVER LOAD MOTOR HG          OVER LOAD MOTOR AW          FRONT DOOR OPEN
R.P.M SPINDLE HIGH          CAM POSITION ALARM          SERVO ALARM
HG 68 LOW LEVEL             AW 10 LOW LEVEL             DRILL OUT ALARM
PART DROP POS 6             HI PRESSHER LOW             BAR END
FIRE EXTINGUISHER           OIL TEMP HIGH               ANALOG UNIT ALARM
BOBBIN OF POSITION          COOLANT LOW                 HANDLE ENGAGED
```

> **Verified 2026-08-10 against the master table.** Values that look truncated —
> `GEAR R.P.M NO SETTIN`, `THE MACHINE DOES NC`, `INVERTER MAIN MOTO`,
> `EMERGENCE PUSHTBUT` — are the **literal stored values**, not a display
> artifact. The set contains `END BAR RECEIVER NOT HOME` (25 chars),
> `DRILL CONTROL OVER LIMIT` (24) and `DROP PARTS 5PCS 1ST CUT` (23), so no
> ~20-char cap is being applied by the source; the short ones were truncated
> upstream at the device. **Publish them verbatim** — matching is exact (5d), so
> "correcting" a value to `INVERTER MAIN MOTOR` would silently discard it.
>
> `COVER OPEN` is the one value proven end to end — fall back to it when in doubt.

### Emission frequency

Alarms are rare relative to `data`. Before modelling them, measure how rare:

```cmd
ssh <VM_USER>@<VM_HOST> "docker exec <CH_CONTAINER> clickhouse-client -q \"SELECT status, count() AS n FROM <DB>.<ALARM_TABLE> GROUP BY status ORDER BY n DESC FORMAT TSV\""
```

If the real rate is on the order of one alarm per machine per hour, alarms are
noise inside a 30-minute run and contribute nothing to load. The 0.2%/0.1%
per-tick chances in [writer.js:88](../loadtest/writer.js#L88) were a guess;
replace them with measured rates.

## 6. Sustain one machine at 10/s

Only after step 5 passes end to end.

Loop 600 publishes over 60s with incrementing counters. A shell loop spawning
a container per message is far too slow — use the Phase B generator instead:

```cmd
docker compose -f docker-compose.mqttgen.yml run --rm -e COUNT=1 -e WORKERS=1 -e RATE_HZ=10 -e DURATION_S=60 -e RUN_ID=PHASE-A-S gen
```

Verify (note the wall-clock start/end you observed the run run between —
`RUN_ID` is not queryable, see the 2026-08-10 correction above):
```sql
SELECT count() FROM <DB>.<TABLE> WHERE device = 'test001' AND created_at BETWEEN '<start>' AND '<end>'
```

Expect close to **600** — a 2026-08-10 run of this exact shape delivered
598/600 (99.7%) at the default QOS 0, which is not itself a finding. Meaningfully
fewer means investigate; see
[../loadtest/mqtt/verify.md](../loadtest/mqtt/verify.md) for the full
delivery/completeness/ordering checks. Also re-read every Prometheus metric
from step 3 and record the delta: this is your per-machine cost, and
multiplying it by 1000 gives the first honest estimate of whether the VM can
take the target load at all.

## Interpretation — where it stopped

| Marker last seen at | Means |
|---|---|
| Nowhere (window 1 silent) | Broker unreachable, wrong port, or auth required. Not an ingest problem. |
| Window 1 only | Broker fine; nothing is consuming that topic. Check device registration took effect, and that the consumer filters on a topic pattern matching `nat/tn`. |
| Redis, not Kafka | Redis and Kafka are fed by separate consumers, and the Kafka one isn't picking up this device. Topology finding — redraw the diagram. |
| Kafka, not ClickHouse | ClickHouse sink is down, lagging, or rejecting the schema. Check `system.errors` and the sink's own logs. |
| ClickHouse, fields wrong | Schema/encoding mismatch. Highest-value bug class — silent, and invisible to every rate metric. |

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Error: Connection refused` from `mosquitto_pub` | Broker port not exposed to your PC, or firewall | Confirm from the VM itself: `docker exec <MOSQ> mosquitto_sub -h localhost -t '#' -v`. If that works, it's network, not broker. |
| `Connection Refused: not authorised` | Broker requires credentials | Add `-u <user> -P <pass>`; put them in `.env.vm`, never inline in a committed file. |
| cmd mangles the JSON payload | cmd needs `\"` escaping inside `-m "..."`, and `%` is special | Escape as shown above. Any literal `%` must be doubled. This is why Phase B moves to a Node script fast. |
| `mosquitto_sub` shows the message but nothing downstream | Device not registered, or registered under a different process/div | Re-run step 2 and confirm the response. |
| ClickHouse row present but all numerics are 0 | Double-vs-single JSON encoding mismatch | Compare against what 5a showed in Redis. This never raises an error. |

## Phase B — the generator

Implementation: [../loadtest/mqtt/](../loadtest/mqtt/) ([README](../loadtest/mqtt/README.md)),
built against [docs/plans/2026-08-10-mqtt-ingest-generator.md](plans/2026-08-10-mqtt-ingest-generator.md).

**To actually run it, use [mqtt-load-test-runbook.md](mqtt-load-test-runbook.md)**
— step-by-step commands, what every env var means and why, and how to read
the output. This section is just a pointer.

Key env vars (full table in the runbook): `COUNT`, `RATE_HZ`, `WORKERS`,
`CONN_MODE`, `QOS`, `DURATION_S`, `RUN_ID`.

**`achieved` vs `target` is the single most important number the generator
prints.** If `achieved` falls below ~95% of `target`, the generator itself is
the bottleneck — every downstream metric from that run is measuring your PC,
not the VM. Establish the generator's ceiling (Task 8 of the plan) before
trusting any VM-side conclusion drawn from a run.

Once a run completes, walk delivery, per-device completeness, latency, and
ordering with [../loadtest/mqtt/verify.md](../loadtest/mqtt/verify.md).

## Output of Phase A

Write these down before moving on — Phase B is designed against them:

1. **Topology diagram** — which hop feeds which, in parallel or serial.
2. **Kafka topic + consumer group names.**
3. **ClickHouse database, table, and column types.**
4. **Encoding convention** at each hop.
5. **Single-message end-to-end latency**, idle system.
6. **Per-machine metric delta** at 10 msg/s.
