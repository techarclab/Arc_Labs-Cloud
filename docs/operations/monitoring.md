# Monitoring and observability

## Health
- `GET /health/live`, `GET /health/ready` (API; ready checks the database). Railway uses `/health/ready` as the deploy health check.
- Worker: `:9100/health/ready` reports `{db, mqtt}`.

## Metrics (worker `:9100/metrics`, Prometheus text format)
| Metric | Meaning | Alert when |
|---|---|---|
| `arc_ingest_accepted_total`, `arc_ingest_measurements_total` | messages/measurements stored | rate drops to 0 while devices are online |
| `arc_ingest_rejected_total{reason}` | rejected messages by reason | sudden rise (bad firmware, abuse) |
| `arc_ingest_errors_total` | storage failures (messages redelivered) | > 0 for 5 min |
| `arc_ingest_processing_ms_sum` / `arc_ingest_processed_total` | average processing time | > 200 ms |
| `arc_ingest_mqtt_connected` | worker connected to broker | 0 |
| `arc_alerts_triggered_total`, `arc_alerts_recovered_total` | rules engine activity | — |
| `arc_deliveries_sent_total{kind}`, `…_retried_total`, `…_failed_total`, `…_skipped_total` | email/webhook delivery | failed rising; skipped = email not configured |
| `arc_commands_expired_total`, `arc_commands_acks_total{status}` | command outcomes | expired rising |
| `arc_jobs_errors_total{job}` | background job failures | > 0 |
| `arc_retention_deleted_total` | rows removed by retention | — |

On Railway the metrics port is private; scrape it from a Grafana Agent/Prometheus service in the same project, or read it with `railway ssh`.

## Logs
Structured JSON from the worker (`ts, level, svc, msg, …`) and Nest logs from the API. Railway → service → Logs (filter by `level":"error"`).

## In the product
- *Rejected data*: why messages were refused and how to fix the firmware.
- *Audit log*: every change.
- Webhook delivery log, alert notification status, command status.
