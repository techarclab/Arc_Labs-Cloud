# Ingestion backlog

**You notice:** dashboards lag behind; `worker` metrics show `arc_ingest_errors_total` rising; logs say `processing failed; message will be redelivered`.

**Why it happens:** the worker only acknowledges a message after it's stored. If the database is slow or down, the broker keeps the messages (persistent session, QoS 1) and redelivers them; duplicates are dropped by `messageId`.

**Check**
1. `worker` logs: database errors (`connection`, `timeout`, `too many clients`) → see [database-exhaustion.md](database-exhaustion.md).
2. Message rate vs capacity: one worker handled ~200 msg/s in the load test (`docs/operations/load-test-results.md`). Count devices × messages per second.
3. `rejected_total{reason="rate_limited"}` rising → a device is flooding (limit 5 msg/s, burst 20 per device). Find it in *Rejected data* and fix its firmware.

**Fix**
- Scale out: first delete the `WORKER_ID` variable on `worker` (each replica then gets its own MQTT client id from Railway's replica ID), then Railway → `worker` → Settings → Replicas: 2 or more. MQTT shared subscriptions split the messages between replicas, and the background jobs use database locks so they never run twice.
- If the database is the bottleneck, give Postgres more resources (Railway → Postgres → Settings), or move to TimescaleDB (see `docs/aws/deployment.md`).

**Confirm:** `arc_ingest_errors_total` stops rising; device *Last seen* is current.
