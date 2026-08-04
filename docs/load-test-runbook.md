# Load-Test Runbook (Windows cmd.exe)

Step-by-step for bringing up the containerized load-test stack and running it
yourself from **Command Prompt**, using the `dx-center-back-local-nht-nat`
repo root as the working directory. `cmd.exe` doesn't mangle `/` paths the
way Git Bash does, so **no `MSYS_NO_PATHCONV` is needed anywhere below** —
that was a Git-Bash-only workaround.

`cmd.exe` has no `grep`/`sed`/`awk`. Two steps below (`5` and `6`) need real
text processing that cmd can't do — those steps say so explicitly and give a
PowerShell command instead. Everything else is plain `docker`/`curl` and runs
in cmd as-is.

## 0. Prerequisites

- Docker Desktop must be **running** before `docker compose` will connect —
  if you see `open //./pipe/dockerDesktopLinuxEngine: ... cannot find`, start
  Docker Desktop and retry.
- Port `8009` must be free. If a local `node` dev server is already running
  the backend outside Docker, stop it first. To find what's holding it:
  ```cmd
  netstat -ano | findstr :8009
  ```
  Then, in PowerShell: `Get-Process -Id <pid>` to identify it before stopping it.

## 1. Bring the stack up

```cmd
cd dx-center-back-local-nht-nat
docker compose -f docker-compose.loadtest.yml up -d --build
```

First run pulls `redis`, `mssql`, `mosquitto` images (a few minutes). Watch
the boot log:

```cmd
docker compose -f docker-compose.loadtest.yml logs -f backend
```

Expect `[redis] connected`, `[mqttHub] connected to mqtt://mosquitto:1883`,
and a wall of `Invalid object name` / `Unable to connect` errors for *other*
realtime processes (GD, AVS, MBR, …) — expected, since the seeded DB only has
`master_mc_storage_tb` for `tn`. Ctrl-C to stop tailing.

Confirm idle CPU is low before trusting any later number:

```cmd
docker stats --no-stream backend-loadtest
```
Expect CPU well under 5%.

## 2. Seed 1000 machines

```cmd
docker compose -f docker-compose.loadtest.yml exec -e NODE_PATH=/app/node_modules backend node /loadtest/seed.js
```

Expect: `seeded: 1000 master rows, 1000 rt_data entries`

Then restart the backend so `masterStorage`'s indefinite cache reloads, and
confirm the real route sees all 1000 machines with real values (not zeros —
that's the double-JSON-encoding failure mode, and it does not raise an
error):

```cmd
docker compose -f docker-compose.loadtest.yml restart backend
```

Wait ~10-15s for it to come back up, then:

```cmd
curl -s "http://localhost:8009/nat/tn/tn-realtime-redis/machines" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);console.log('machines:',b.data.length,'| sample:',JSON.stringify(b.data[0]).slice(0,200))})"
```
Expect: `machines: 1000` with non-zero `prod_pos4`/`target_ct` etc. in the sample.

## 3. Start the live writer

Keeps `rt_*` hashes moving so machines don't flip to `SIGNAL LOST` after 10
minutes. Start it **before** any timed run and leave it running for the
whole session:

```cmd
docker compose -f docker-compose.loadtest.yml --profile writer up -d writer
docker compose -f docker-compose.loadtest.yml logs -f writer
```
Expect a `[writer] seed=1337 machines=1000 ...` startup line, then periodic
`[writer] N writes/s` every 10s (order of a few hundred writes/s at 1000
machines). Ctrl-C to stop tailing (the writer keeps running in the background
regardless).

**To confirm it's actually incrementing values, not just logging activity**,
run this in cmd — `FOR /L` is cmd's loop syntax (note the single `%i`; if you
ever put this inside a `.bat` file instead of typing it directly at the
prompt, double it to `%%i`):

```cmd
FOR /L %i IN (1,1,3) DO (docker compose -f docker-compose.loadtest.yml exec redis redis-cli HGET rt_data "data/nat/tn/tb0017" & timeout /t 6 /nobreak > nul)
```

Each of the 3 samples prints the full JSON entry for machine `tb0017`. Check
`prod_pos4` inside the payload — it should be **strictly increasing** across
the three prints (e.g. 3472 → 3476 → 3480), and `timestamp` should advance
too. If it's flat across all 3, the writer isn't reaching Redis — check
`docker compose -f docker-compose.loadtest.yml logs writer` for errors.

## 4. Run a single k6 scenario yourself

```cmd
docker compose -f docker-compose.loadtest.yml run --rm -e VIEWERS=50 -e K=0 -e TICKS=12 k6 run /scripts/viewers.js
```

- `VIEWERS` — concurrent simulated dashboards
- `K` — machines each viewer filters to (`0` = unfiltered, the worst case; production target is `VIEWERS=50 K=0`)
- `TICKS` — number of 5s wall-clock-aligned bursts to run (12 ≈ 1 minute)

Read the `THRESHOLDS` block at the end of the output:
- `http_req_duration p(95)` — must be comfortably under 5000ms (the real tick budget; the script's own threshold is a stricter 2000ms smoke-test line)
- `http_req_failed` — should be 0%
- `wrong_machine_count` — must be `count==0`; non-zero means a filter bug and invalidates the run

## 5. Run the full sweep

`loadtest/run-sweep.sh` is a **bash script** (background jobs, `mkdir -p`,
`$(date ...)`) — it cannot be translated into cmd or rewritten as a `.bat`
without losing behavior. The pragmatic fix is to invoke Git Bash's `bash.exe`
directly from cmd, which Git for Windows adds to `PATH`:

```cmd
bash loadtest/run-sweep.sh
```

That single line runs fine from a cmd prompt — you're just handing that one
script off to bash to interpret; everything else in this doc still runs
natively in cmd.

Runs all 6 grid points (`VIEWERS ∈ {50,200} × K ∈ {250,500,0}`), ~8-10
minutes total, sampling `docker stats` on `backend-loadtest` throughout each
run. Results land in `loadtest/results/<timestamp>/` — one `.log`
(human-readable k6 output), `.json` (k6 summary export), and `.stats`
(CPU%,MEM samples) per scenario. This directory is gitignored — commit the
runner, never the results.

**To read a run's numbers back out afterward**, cmd has no `grep -A`
equivalent worth using — either open the `.log` file directly in an editor
and search for `THRESHOLDS`, or use PowerShell:

```powershell
$out = "loadtest\results\<timestamp>"
Select-String -Path "$out\v50-k0.log" -Pattern "✓|✗|p\(95\)|rate=|count=" | Select-Object -First 10
(Get-Content "$out\v50-k0.stats" | ForEach-Object { [double]($_ -replace '%.*','') } | Measure-Object -Maximum).Maximum
```

**`v50-k0` is the pass/fail run** — 50 viewers, all 1000 machines unfiltered. Report that one first; everything else in the grid is context.

## 6. Monitor live while a run is in progress

Open a **second** cmd window while a sweep or single run is executing in the first:

```cmd
docker stats backend-loadtest writer-loadtest
```
(live, refreshes in place — Ctrl-C to exit)

```cmd
docker compose -f docker-compose.loadtest.yml logs -f backend
```
(error/log tail — Ctrl-C to exit)

If p95 looks bad but `backend-loadtest` CPU stays low, suspect **k6 itself**
before believing the server is slow — the `k6` service is capped at 2 CPUs
(see `docker-compose.loadtest.yml`), and a saturated load generator is the
most common false positive in this kind of test.

## 7. Tear down

```cmd
docker compose -f docker-compose.loadtest.yml --profile writer down
```

This stops and removes `redis`, `mssql`, `mosquitto`, `backend`, and `writer`.
Nothing here ever touches production — every value comes from
`local-backend/.env.loadtest`, never `.env`.

## Known gotchas (hit and fixed this session)

| Symptom | Cause | Fix |
|---|---|---|
| `open //./pipe/dockerDesktopLinuxEngine: cannot find` | Docker Desktop not running | Start Docker Desktop, retry |
| `Ports are not available: ... 0.0.0.0:8009` | A local dev server (outside Docker) already holds 8009 | Stop it — find the PID with `netstat -ano \| findstr :8009`, identify it with PowerShell `Get-Process -Id <pid>` |
| `Cannot find module '/app/C:/Program Files/Git/loadtest/seed.js'` | *(Git Bash only, not cmd)* Git Bash rewrote the container path | If ever running from Git Bash instead of cmd, prefix the command with `MSYS_NO_PATHCONV=1`. Not needed in cmd — cmd doesn't do this rewrite. |
| `Cannot find module 'dotenv'` inside a `/loadtest/*.js` script | Node module resolution walks up from the script's own directory, and `/loadtest` isn't under `/app` — so it never finds `/app/node_modules` | Set `NODE_PATH=/app/node_modules` (either `-e NODE_PATH=...` on `exec`, or `environment: NODE_PATH: /app/node_modules` in the compose service) |
