# ARC Cloud on AWS: pilot deployment (≤ ₹5,000/month)

```
Devices ──MQTT/TLS 8883──▶ mqtt.arcloud.arclabs.in ┐
Devices/scripts ──HTTPS──▶ api.arcloud.arclabs.in  ├─ EC2 t4g.medium (Elastic IP)
                                                   │    Caddy (Let's Encrypt) → API · EMQX · worker
                                                   └──▶ RDS PostgreSQL 16 db.t4g.micro (private subnets)
Browsers ──HTTPS──▶ arcloud.arclabs.in ──▶ CloudFront ──▶ S3 (console)
DNS: all records stay in Wix (Wix has no NS records for subdomains, so there is no Route 53 zone).
```

Account `756751967044` ("ARC Cloud", a member account of the ARC LABS AWS Organization; never the management account), region `ap-south-1` (Mumbai). Terraform: `infra/terraform/{bootstrap,pilot}`. Server runtime: `deploy/aws/`.

## What it costs (on-demand list prices, ap-south-1)

| Item | Approx. per month |
|---|---|
| EC2 t4g.medium, 24×7 | ~$16 |
| Elastic IP (public IPv4 $0.005/h) | ~$3.7 |
| EBS gp3 30 GB | ~$3 |
| RDS db.t4g.micro Single-AZ + 20 GB gp3 + backups | ~$18 |
| Secrets Manager (2 secrets), S3, CloudFront, CloudWatch logs | ~$2.5 |
| **Total** | **~$43 ≈ ₹4,100, ≈ ₹4,850 with 18% GST (AWS India)** |

Notes:
- The t4g.medium price is derived (t4g.small is $0.0112/h; sizes double). The EBS and RDS storage prices are approximate.
- Internet egress above the free allowance and CPU-credit surcharges are extra.
- An AWS Budgets alert (Terraform: `monthly_budget`, default $44) emails you at 80% of actual spend and at 100% of forecast.

**Deliberately not included** (too expensive for this budget; see the target ADR for when to add them):
- NAT Gateway (~$41)
- Load balancers (~$18–24 each)
- Multi-AZ RDS (about ×2 the database cost)
- A second server

**Accepted risks:**
- One server is a single point of failure. AWS auto-recovers it on hardware faults, so outages last minutes, not hours. That makes 99.5% realistic and 99.9% not.
- If the server dies, MQTT messages that EMQX had not yet handed to the worker are lost; device buffering plus `messageId` covers this.

## You need

- **AWS CLI v2 and Terraform ≥ 1.10 (or OpenTofu ≥ 1.10)** on your Mac.
- **An administrator identity in the ARC Cloud account (`756751967044`).** IAM Identity Center user `Arc_Labs` with the AdministratorAccess permission set on that account. Configure the CLI with `aws configure sso --profile arc-admin`: portal `https://d-96679036fe.awsapps.com/start`, SSO region `ap-southeast-1` (Identity Center lives in Singapore), account **ARC Cloud**, default region `ap-south-1`.
  - **Never use root access keys.**
  - Never paste keys into chat or commit them.
- **Access to Wix DNS for `arclabs.in`** (you add 4 records there).

## 1. Bootstrap (once per account)

```bash
export AWS_PROFILE=arc-admin
aws sts get-caller-identity            # must show 756751967044
cd infra/terraform/bootstrap
terraform init && terraform apply
```

This creates:
- the Terraform state bucket `arc-cloud-tfstate-756751967044` (versioned, encrypted, TLS-only);
- the GitHub OIDC provider.

Keep `infra/terraform/bootstrap/terraform.tfstate` safe (password manager or private drive). It holds no secrets, but you need it to change the bootstrap later.

## 2. Configure the pilot stack

```bash
cd ../pilot
cp terraform.tfvars.example terraform.tfvars      # set alert_email; it is git-ignored
terraform init -backend-config="bucket=arc-cloud-tfstate-756751967044"
```

## 3. Reserve the server address and request the console certificate

```bash
terraform apply -target=aws_eip.server -target=aws_acm_certificate.console
terraform output wix_records
```

It lists three records: a CNAME for certificate validation, and A records for `api.arcloud` and `mqtt.arcloud`.

## 4. Add the step-1 records in Wix

In **Wix → Domains → arclabs.in → Manage DNS records**, add the three records from `wix_records`:

| Section | Host name (type exactly as printed) | Value |
|---|---|---|
| CNAME | `_<long id>.arcloud` | `_<long id>.<…>.acm-validations.aws` |
| A (Host) | `api.arcloud` | the Elastic IP |
| A (Host) | `mqtt.arcloud` | the Elastic IP |

- Wix appends `.arclabs.in` itself, so type only the host shown.
- Leave TTL at the default.
- **Keep the validation CNAME forever:** ACM uses it to renew the console certificate.
- **Never click "Use custom nameservers"** (that moves all of `arclabs.in` away from Wix, taking the website and email with it).

Check from Terminal (each must answer):

```bash
dig api.arcloud.arclabs.in +short @ns12.wixdns.net
dig mqtt.arcloud.arclabs.in +short @ns12.wixdns.net
```

> **Remove the old `arcloud` CNAME first (it points to Vercel).** AWS checks which certificate authorities may
> issue for `arcloud.arclabs.in`. Through a CNAME it reads the *target's* CAA records, and Vercel's allow only
> Let's Encrypt, GlobalSign, Sectigo and Google, so ACM fails with `CAA_ERROR`. Delete the CNAME in Wix, wait until
> `dig arcloud.arclabs.in @8.8.8.8 +short` returns nothing (cached for up to 1 hour), then run the full apply. The
> console is offline from the deletion until the CloudFront CNAME is added at the end of step 5.
> If ACM already failed: `terraform apply -replace=aws_acm_certificate.console` requests a fresh certificate.

## 5. Create everything else

```bash
terraform apply
```

This takes about 20–40 minutes and does the following, in order:

1. Waits until the console certificate validates. This proves the Wix CNAME is live.
2. Creates RDS (~10 min), CloudFront (~5–15 min) and the server.
3. The server's first boot takes about 10 more minutes:
   - installs Docker;
   - builds the images;
   - gets Let's Encrypt certificates for `api.` and `mqtt.` (through the A records);
   - runs the database migrations;
   - starts the stack.

Then:

- **Point the console at AWS.** In Wix, edit the existing `arcloud` CNAME and replace the Vercel value with the CloudFront name from `terraform output wix_console_cname`. The old Vercel console stays live until this edit, so the downtime is only DNS caching (≤ 1 hour).
- **Confirm the SNS subscription email** that AWS sends to `alert_email`. No alarm reaches you until you do.
- **Check the server:**
  ```bash
  curl https://api.arcloud.arclabs.in/health/ready
  aws ssm start-session --target "$(terraform output -raw server_instance_id)"   # shell, no SSH
  sudo tail -n 50 /var/log/arc-bootstrap.log
  ```

## 6. Publish the console (GitHub Actions)

1. **GitHub → Settings → Environments → New environment `pilot`.**
   - Add yourself as a **required reviewer**: only jobs in this environment can assume the AWS deploy role.
   - Add these environment **variables** from `terraform output`:

     | Variable | Value |
     |---|---|
     | `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arn` |
     | `SERVER_INSTANCE_ID` | `server_instance_id` |
     | `CONSOLE_BUCKET` | `console_bucket` |
     | `CONSOLE_DISTRIBUTION_ID` | `console_distribution_id` |
     | `API_URL` | `https://api.arcloud.arclabs.in` |

2. **Actions → Deploy (AWS pilot) → Run workflow** with `main`. It does the following:
   - deploys that exact commit to the server via SSM;
   - builds the console against `API_URL`;
   - uploads it to S3 and refreshes CloudFront.

Open `https://arcloud.arclabs.in`.

## 7. Lock down sign-up and set operators

Register the first admin account in the console. Then, on the server (`aws ssm start-session …`):

```bash
sudo tee /etc/arc-cloud/extra.env >/dev/null <<'EOF'
ALLOW_SIGNUP=false
PLATFORM_ADMIN_EMAILS=you@example.com
# GOOGLE_CLIENT_ID=…apps.googleusercontent.com   (add https://arcloud.arclabs.in as an authorized JS origin)
# SMTP_URL=smtps://user:pass@smtp.example.com:465 (alert emails; without it they are recorded as skipped)
EOF
sudo arc-deploy main
```

Only the keys shown above are read from `extra.env`.

## 8. Move data from Railway (optional, do it before real use)

On the server (`aws ssm start-session …`). This **replaces** everything in the RDS database with Railway's data.

```bash
COMPOSE="docker compose -f /opt/arc-cloud/deploy/aws/docker-compose.yml"
sudo $COMPOSE stop api worker emqx                      # nothing writes during the copy
DST="$(sudo grep '^DATABASE_URL=' /etc/arc-cloud/api.env | cut -d= -f2-)&sslrootcert=/certs/rds-ca.pem"
sudo docker run --rm -v /opt/arc-cloud-data/rds-ca.pem:/certs/rds-ca.pem:ro \
  -e SRC='postgres://USER:PASS@HOST:PORT/railway' -e DST="$DST" postgres:16 sh -ec '
    pg_dump --no-owner --no-acl -Fc -f /tmp/arc.dump "$SRC"
    psql "$DST" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    pg_restore --no-owner --no-acl --exit-on-error -d "$DST" /tmp/arc.dump'
sudo arc-deploy main                                    # applies newer migrations (e.g. 004 RLS) and restarts
```

- Use Railway's **public** connection URL (Railway → Postgres → Connect).
- If the Railway database used the TimescaleDB extension, the restore fails on RDS (no TimescaleDB). In that case, export with `--exclude-schema=_timescaledb*` and ask for help converting the telemetry table first.
- **Devices keep their credentials** (the password hashes move with the data). They only need the new endpoints (step 9).

## 9. Point devices at AWS

- **MQTT** (`config.h`):
  ```c
  #define MQTT_HOST "mqtt.arcloud.arclabs.in"
  #define MQTT_PORT 8883
  #define BROKER_CA ARC_PUBLIC_ROOTS
  ```
  The certificate is Let's Encrypt RSA, issued under ISRG Root X1, which is already pinned in `arc_roots.h`.
- **HTTP** (`arc_http`):
  ```c
  SERVER = "https://api.arcloud.arclabs.in";
  ```
  Keys in URLs are refused here (`DEVICE_KEY_IN_QUERY=false`), so use firmware that sends `Authorization: Bearer`.

## Operating it

| Task | How |
|---|---|
| Deploy a version | Actions → Deploy (AWS pilot), or on the server `sudo arc-deploy <branch/tag/sha>` |
| Logs | CloudWatch Logs group `/arc-cloud/pilot` (14 days), one stream per container |
| Shell | `aws ssm start-session --target <instance-id>` (no SSH port is open) |
| MQTT certificate | Caddy renews automatically. A daily timer (`arc-cert-sync.timer`) installs the new cert into EMQX and restarts it, so devices reconnect once per renewal (~every 60 days) |
| Database restore | RDS console → `arc-cloud-pilot` → Restore to point in time (7 days) |
| Secrets | Secrets Manager `arc-cloud/pilot/app` (app) and the RDS-managed master secret. They are rewritten into `/etc/arc-cloud/*.env` (0600) on every deploy |
| Spend | Billing → Budgets → `arc-cloud-pilot-monthly` |

**Scale-up signals:**
- The `server-cpu-credits` alarm fires.
- The `db-cpu` alarm fires.
- You need more than ~500 active devices or a 99.9% SLA.

Next step at that point: the load-balanced design in the target ADR, which needs no code changes, only hosting.

## Security notes

- **Open ports:** 80 (ACME + redirect), 443 (API) and 8883 (MQTT/TLS). EMQX's 1883 and dashboard (18083), the API hook port (3001) and PostgreSQL are not reachable from the internet.
- **Database connection:** RDS forces TLS (`rds.force_ssl=1`), and the app verifies the RDS certificate (`sslmode=verify-full` with the RDS CA bundle).
- **Instance metadata:** IMDSv2 only, hop limit 1, so containers cannot use the server's IAM role.
- **Terraform state** contains the generated app secrets. The bucket is private, encrypted, versioned and TLS-only. Treat state access as secret access.
- **Database user:** the app currently connects as the RDS master user. It is not a superuser, and row-level security still applies through `arc_tenant`. Moving to a dedicated least-privilege login is a follow-up.
- **Certificate issuance (optional hardening):** Wix's DNS editor shows no CAA records. If it ever offers them, add `0 issue "letsencrypt.org"` and `0 issue "amazon.com"` for `arcloud.arclabs.in`.
