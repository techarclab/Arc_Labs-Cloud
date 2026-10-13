# Load test results

Produced by `npm run test:load` (tests/load/run.ts): real API + ingestion worker + PostgreSQL, devices over MQTT through a broker that calls the same auth/ACL hooks as EMQX. Latency is device timestamp → row stored.

| Date (UTC) | Devices | Msg/s per device | Duration | Sent | Stored | Lost | Rejected | Throughput (msg/s) | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-12 12:51 | 200 | 1 | 60s | 11800 | 11800 | 0 | 0 | 196.7 | 273 ms | 1056 ms | 1513 ms | 1701 ms |
