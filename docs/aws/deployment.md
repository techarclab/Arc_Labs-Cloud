# Moving ARC Cloud to AWS

The local Docker stack maps onto AWS service-for-service. Do this in phase 6 (hardening) once the kickoff decisions in the design plan (device count, publish rate, retention, budget) are answered, because they decide instance sizes.

## Recommended layout

| Local (compose) | AWS |
|---|---|
| `api` container | ECS Fargate service behind an Application Load Balancer (HTTPS via ACM). Only port 3000 is attached to the ALB. |
| API port 3001 (broker hooks) | Same task, reachable only from the broker's security group; no ALB route. |
| `ingestion-worker` | ECS Fargate service, 2+ tasks (shared subscription splits load), private subnets. |
| `emqx` | EMQX on ECS (EC2 launch type) or EC2 behind a **Network Load Balancer** on 8883. TLS can terminate on EMQX with a cert for e.g. `mqtt.arclabs.in`. |
| `db` (TimescaleDB) | See the database choice below. |
| `.env` secrets | AWS Secrets Manager, injected into ECS task definitions. |
| dev certs | Real certificate for the broker domain (Let's Encrypt or a public CA; ESP32s need a CA they trust). |
| logs / metrics | CloudWatch Logs (JSON logs already), CloudWatch alarms on `/health/ready`; scrape the worker's `/metrics` with Amazon Managed Prometheus or the CloudWatch agent. |

**Region:** `ap-south-2` (Hyderabad) or `ap-south-1` (Mumbai) keeps data in India, which simplifies DPDP Act conversations with colleges and industrial customers. Confirm service availability in Hyderabad for everything you pick before committing.

## Database choice

Amazon RDS / Aurora PostgreSQL **do not offer the TimescaleDB extension**. Options:

1. **RDS PostgreSQL without Timescale** — simplest to run; the schema already falls back to a plain table. Add native monthly partitioning on `telemetry_measurements` and a scheduled job to drop old partitions once volume grows.
2. **Timescale Cloud on AWS** (managed, same region) — keeps hypertables, compression and retention policies.
3. **Self-managed TimescaleDB on EC2** — most control, most operational work (backups, patching, failover are yours).

For an MVP with tens to a few hundred devices, option 1 is usually enough and cheapest to operate.

## AWS IoT Core instead of EMQX?

IoT Core removes broker operations but changes the identity model: devices use X.509 certificates and IoT policies rather than our username/password hooks, and ingestion would read from IoT Rules (e.g. into SQS/Kinesis) instead of an MQTT subscription. It is a reasonable phase-7 evaluation, not a drop-in swap. Keeping EMQX means the code you test locally is the code you run in AWS.

## Rollout checklist

- [ ] VPC with public subnets (ALB, NLB) and private subnets (ECS tasks, database)
- [ ] Security groups: NLB→EMQX 8883; EMQX→API 3001; worker→EMQX 1883; tasks→DB 5432; nothing else inbound
- [ ] Secrets in Secrets Manager; `ALLOW_SIGNUP=false`; strong EMQX dashboard password, dashboard not public
- [ ] Run migrations as a one-off ECS task before deploying a new API version (`RUN_MIGRATIONS` off in prod)
- [ ] Automated DB backups + a tested restore (plan §18 RPO/RTO)
- [ ] Alarms: API 5xx, worker not ready, `arc_ingest_errors_total` rising, DB CPU/storage
- [ ] Infrastructure as code (Terraform or CDK) under `infra/terraform/` — next step once the region and DB option are chosen
