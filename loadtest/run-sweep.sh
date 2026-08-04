#!/usr/bin/env bash
# Sweeps viewers x machines-per-viewer, capturing k6 summaries and container stats.
set -euo pipefail

# MSYS_NO_PATHCONV: Git Bash on Windows mangles leading-/ paths (e.g. /scripts/...)
# into host paths before they reach docker. Every docker invocation below needs it.
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f docker-compose.loadtest.yml"
OUT="loadtest/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# 50 viewers is the actual production target; 200 is a 4x headroom probe, kept
# only so a future growth question has a data point. Anything above that was
# dropped once the target was confirmed — see Decisions.
for VIEWERS in 50 200; do
  for K in 250 500 0; do   # 0 = unfiltered worst case, i.e. all 1000 machines
    NAME="v${VIEWERS}-k${K}"
    echo "=== $NAME ==="

    # Sample the backend container for the duration of the run.
    ( while true; do
        docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' backend-loadtest
        sleep 2
      done ) > "$OUT/$NAME.stats" 2>/dev/null &
    STATS_PID=$!

    $COMPOSE run --rm \
      -e VIEWERS="$VIEWERS" -e K="$K" -e TICKS=12 \
      k6 run --summary-export="/scripts/results/$(basename "$OUT")/$NAME.json" \
      /scripts/viewers.js 2>&1 | tee "$OUT/$NAME.log" || echo "THRESHOLD BREACH in $NAME"

    kill $STATS_PID 2>/dev/null || true

    # Let the snapshot cache expire and the container settle between runs, so
    # one run's tail does not land inside the next run's baseline.
    sleep 15
  done
done

echo "results in $OUT"
