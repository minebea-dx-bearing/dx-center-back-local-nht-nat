# MQTT ingest load generator (Phase B)

Simulates up to 1000 machines publishing to the **VM's** Mosquitto broker, so the
write-side ingest path (Mosquitto → Redis / Kafka → ClickHouse) can be load
tested independently of the local read-side harness in [../](../).

Run with:

```cmd
docker compose -f ../../docker-compose.mqttgen.yml run --rm gen
```

## Safety rules — do not break these

1. This directory reads `loadtest/.env.vm` and **never**
   `local-backend/.env.loadtest`. Mixing them points the local stack at the VM
   broker — [mqttHub.js](../../local-backend/util/mqttHub.js) subscribes to
   `#`, so the local backend would ingest the VM's entire firehose.
2. Nothing here issues `DELETE`, `DROP`, or `TRUNCATE` against the VM. Any
   cleanup query must be scoped by `WHERE device LIKE 'test%'`.

## Reference

- Plan: [../../docs/plans/2026-08-10-mqtt-ingest-generator.md](../../docs/plans/2026-08-10-mqtt-ingest-generator.md)
- Phase A findings (topology, encoding, valid status/alarm values): [../../docs/mqtt-ingest-load-test.md](../../docs/mqtt-ingest-load-test.md)
