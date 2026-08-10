# Verifying a generator run

**Measured 2026-08-10 against the real ClickHouse table:** there is no
per-message marker column. `id_num` and `spec` are sent over MQTT (real
devices send them too — see §4 of
[../../docs/mqtt-ingest-load-test.md](../../docs/mqtt-ingest-load-test.md))
but map to no ClickHouse column, so the ingest consumer silently drops them.
`created_at` is a `DateTime('Asia/Bangkok')`, but observed values are bucketed
to **10-second granularity**, not per-message — likely a batched-insert
artifact of the ingest consumer, not the true publish time. Both change how
verification has to work: **by device + time window and bucket-count, not by
marker.**

Substitute `<DB>.<TABLE>` below (see
[../../docs/mqtt-ingest-load-test.md](../../docs/mqtt-ingest-load-test.md) for
how those were discovered). Queries here assume a JDBC-based client — omit
`FORMAT` clauses; a `clickhouse-client` CLI session can add
`FORMAT JSONEachRow` back if preferred.

## 1. Delivery rate

Note the wall-clock start/end of the run (the generator prints its own
`t=Ns` progress, and `DURATION_S` gives the expected end), then:

```sql
SELECT count() FROM <DB>.<TABLE>
WHERE device = '<device>' AND created_at BETWEEN '<start>' AND '<end>'
```

Compare against `COUNT * RATE_HZ * DURATION_S` (the generator's target, not
its self-reported `achieved`, which is itself derived from the same publish
count and so cannot catch broker-side loss). At QOS 0, some loss is expected
and not itself a bug — a 2026-08-10 smoke run (1 machine, 10 msg/s, 60s) delivered
598/600 (99.7%). Investigate if delivery drops meaningfully below that.

## 2. Per-10-second-bucket rate

Because `created_at` only has 10s resolution, this doubles as both the
completeness and the "did the generator actually sustain RATE_HZ" check:

```sql
SELECT created_at, count() AS n FROM <DB>.<TABLE>
WHERE device = '<device>' AND created_at BETWEEN '<start>' AND '<end>'
GROUP BY created_at ORDER BY created_at
```

Each full bucket should read `RATE_HZ * 10`. The first and last buckets will
be partial (the run doesn't start/end on a 10s boundary) — expect those two,
not the interior ones, to be short.

## 3. Per-device completeness

At scale (COUNT > 1), run query 1 with `GROUP BY device` instead of a fixed
device, `HAVING count() < <EXPECTED_PER_DEVICE>` (= `RATE_HZ * DURATION_S`).
Loss uniform across devices points at the broker or a shared consumer stage;
loss concentrated in a handful of devices points at per-connection issues
instead (e.g. a client that reconnected mid-run, or a shard a worker never
finished staggered-connecting in time).

## 4. End-to-end latency

**Not currently measurable this way.** `created_at`'s 10s bucketing means it
cannot be diffed against a per-message publish time to produce a meaningful
p50/p95 — every message in a bucket reads the same timestamp regardless of
when in that window it actually published. If per-message latency becomes
necessary, it needs either a real per-row ingest timestamp column (ask
upstream whether one exists under a different name) or a Kafka-side read
(consumer offset time vs. produce time), not a ClickHouse-side one.

## 5. Ordering / monotonicity

`prod_pos4` (and the other counter fields — see `COUNTER_FIELDS` in
[payload.js](payload.js)) must be non-decreasing per device across the run.
Query 2's shape works here too, selecting `prod_pos4` instead of `count()`,
ordered by `created_at`; a violation means reordering somewhere in the
pipeline, which no rate metric above would ever surface. Note that with
several messages sharing one `created_at` bucket, only cross-bucket ordering
is checkable this way — same-bucket reordering is invisible to this schema.
