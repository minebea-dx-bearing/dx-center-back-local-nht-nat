# Generator capacity ramp — 2026-08-10

Settings: default (`WORKERS=4`, `CONN_MODE=per-device`, `QOS=0`), `RATE_HZ=10`,
60s per step, against the real VM broker (10.128.17.253).

| COUNT | target/s | achieved/s (range) | rssMB |
|---|---|---|---|
| 10   | 100    | 100 (steady)        | 49    |
| 50   | 500    | 500–502              | 49    |
| 100  | 1,000  | 992–1,003            | 49–50 |
| 250  | 2,500  | 2,470–2,509          | 48    |
| 500  | 5,000  | 4,997–5,018          | 49–50 |
| 1000 | 10,000 | 9,899–10,063         | 49    |

## Verdict

**No knee found up to 1000 machines.** `achieved` tracks `target` within
noise (±1–2%) at every step, and RSS is flat across the entire range —
memory was never a factor. **1000 × 10/s (10,000 msg/s) is reachable from
this PC** at the plan's default settings; no `CONN_MODE=pooled` or
`WORKERS` tuning was needed.

Host CPU was not captured for this ramp (no monitoring wired up in this
session) — if a future run needs that number, `docker stats` on the `gen`
container during a run, or Windows perf counters on the host, would fill
the gap. Given `achieved` tracked `target` cleanly through 1000 machines and
RSS stayed flat, CPU headroom was very unlikely to be the constraint here,
but that's inference, not a measurement.

## Note: the COUNT=50 step required a generator fix mid-ramp

The first COUNT=50 attempt (before COUNT=10) failed completely —
achieved=0/s for the full 60s — while COUNT=10 had passed cleanly. Root
cause was a race in `generator.js`'s `connectStaggered`: it registered the
"wait until all clients connected" listener in a second loop that ran
*after* the staggered-connect loop finished. With enough devices per shard,
that loop takes long enough for early clients' `connect` events to fire and
be lost before the listener existed to catch them, permanently hanging the
readiness wait and preventing the publish loop from ever starting. Fixed by
registering the listener at client-creation time instead. Re-run after the
fix: 500–502/500 achieved, matching every other step. All results in the
table above are post-fix.
