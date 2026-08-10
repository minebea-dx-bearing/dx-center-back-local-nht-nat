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

## Fixed: RATE_HZ was silently capped at ~100/s per machine

Found 2026-08-10, after the COUNT ramp above (which all ran at `RATE_HZ=10`
and never exercised this). `generator.js`'s scheduler polled once every
`TICK_MS=10ms` and fired **at most one** publish per machine per poll
(`if`, not a loop) — so no matter how far a machine's schedule fell behind,
it could only ever catch up by one message per poll. That hard-caps the
achievable per-machine rate at `1000 / TICK_MS` = **100/s**, regardless of
`RATE_HZ`. Measured before the fix: `RATE_HZ=1000`, 1 machine, only achieved
~95–98/s.

Fixed by turning the single `if` into a bounded catch-up loop — a machine
that's fallen behind fires repeatedly within one poll until caught up (capped
at 3x the nominal expected fires per poll, so a genuinely overloaded run
degrades visibly in `achieved` instead of the backlog growing unbounded).
Re-verified after the fix:

| Scenario | target/s | achieved/s |
|---|---|---|
| `RATE_HZ=10`, `COUNT=10` (regression check) | 100 | 97–100 |
| `RATE_HZ=1000`, `COUNT=1` | 1,000 | 986–1,004 |
| `RATE_HZ=1000`, `COUNT=10` | 10,000 | 9,255–10,017 (first 10s low, connect ramp-up) |

`RATE_HZ` above ~100/s per machine was never exercised before this fix — the
COUNT ramp table above only used `RATE_HZ=10` throughout, so it says nothing
about this ceiling one way or the other.

## Ceiling found: COUNT=2000 hits a broker-side connection limit, not a generator one

Tested 2026-08-10, after the 1000-machine ramp above. `COUNT=2000` (target
20,000 msg/s) produced **achieved=0/s for the entire 60s run** — a different
failure mode than the COUNT=50 race below, and not fixed by that fix.

Root cause: `generator.js` waits for **every** client in a shard to connect
before it starts publishing anything. Diagnosed directly (bypassing the
generator) by opening 2000 simultaneous raw MQTT connections to the VM
broker: **1011 connected, 1385 got `ECONNREFUSED`**, and the rest cycled
`mqtt.js`'s default infinite reconnect without ever succeeding. `ECONNREFUSED`
is an active refusal (not a timeout or silent drop), which points at a
**configured connection cap on the broker itself** — Mosquitto's
`max_connections`, or an OS file-descriptor limit on that process — not
something this PC, the network, or the generator's code controls. 1011 lands
suspiciously close to a round configured value like 1000.

Caveat: that measurement was 2000 **simultaneous, unstaggered** connections
from one process, not the generator's actual staggered/per-worker approach —
the real ceiling under proper stagger could differ slightly. But the
mechanism (broker actively refusing past ~1000) explains the generator's
`achieved=0` cleanly: with `COUNT=2000` split across 4 workers (500 devices
each), failures were scattered across the device range, so essentially every
worker ended up with at least one un-connectable device, hanging that
worker's "wait for all clients" step forever and zeroing its `achieved` for
the whole run.

**Verdict: as the VM is configured today, ~1000–1200 concurrent connections
is the real ceiling — not 2000, and not a generator limitation.** If 2000
real machines becomes an actual requirement, that's a broker-config
conversation with whoever administers the VM's Mosquitto instance, not
something to chase further in this codebase. Separately, `generator.js`'s
all-or-nothing connect wait is itself a fragility worth fixing regardless of
where the real ceiling lands — one stuck client currently zeroes an entire
run instead of the run degrading gracefully; not done as of this writing.

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
