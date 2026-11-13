# ARC Cloud on AWS: pilot deployment (≤ ₹5,000/month)

> **Retired 2026-11-10.** The hosted ARC Cloud moved to Oracle Cloud Always Free
> ([oracle-free.md](oracle-free.md)) and this pilot was deleted with the scripts in ["Tear down"](#tear-down).
> The Terraform (`infra/terraform/{bootstrap,pilot}`) and `deploy/aws/` are kept so the pilot can be
> recreated from scratch in a new account by following this guide; the GitHub deploy workflow was removed and
> would need restoring from git history.

```
Devices ──MQTT/TLS 8883──▶ mqtt.arcloud.arclabs.in ┐
Devices/scripts ──HTTPS──▶ api.arcloud.arclabs.in  ├─ EC2 t4g.medium (Elastic IP)
                                                   │    Caddy (Let's Encrypt) → API · EMQX · worker
                                                   └──▶ RDS PostgreSQL 16 db.t4g.micro (private subnets)
Browsers ──HTTPS──▶ arcloud.arclabs.in ──▶ CloudFront ──▶ S3 (console)
DNS: all records stay in Wix (Wix has no NS records for subdomains, so there is no Route 53 zone).
```

A dedicated member account of the ARC LABS AWS Organization (never the management account), region `ap-south-1` (Mumbai). Terraform: `infra/terraform/{bootstrap,pilot}`. Server runtime: `deploy/aws/`.

## What it costs (on-demand list prices, ap-south-1)

| Item | Approx. per month |
|---|---|
| EC2 t4g.medium, 24×7 | ~$16 |
| Elastic IP (public IPv4 $0.005/h) | ~$3.7 |
| EBS gp3 30 GB | ~$3 |
| RDS db.t4g.micro Single-AZ + 20 GB gp3 + backups | ~$18 |
| Secrets Manager (2 secrets), S3, CloudFront, CloudWatch logs | ~$2.5 |
| Uptime checks: 2 Route 53 health checks, one with the HTTPS option; CloudWatch alarms and 3 custom metrics (mostly free tier) | ~$1–3.5 |
| **Total** | **~$44–46.5, ≈ ₹4,950–5,250 with 18% GST (AWS India)** |

Notes:
- The t4g.medium price is derived (t4g.small is $0.0112/h; sizes double). The EBS and RDS storage prices are approximate.
- Internet egress above the free allowance and CPU-credit surcharges are extra.
- Route 53 health checks: $0.50/month each for AWS endpoints ($0.75 for non-AWS), plus $1 ($2) per optional feature such as HTTPS; up to 50 health checks on AWS endpoints are free. AWS's pricing page does not say whether a check on an Elastic IP counts as an AWS endpoint, hence the range: $1 if it does, $3.50 if not. Check the first bill.
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
- **An administrator identity in the ARC Cloud account (`<account-id>`).** IAM Identity Center user `Arc_Labs` with the AdministratorAccess permission set on that account. Configure the CLI with `aws configure sso --profile arc-admin`: portal: your IAM Identity Center access portal URL, SSO region `ap-southeast-1` (Identity Center lives in Singapore), account **ARC Cloud**, default region `ap-south-1`.
  - **Never use root access keys.**
  - Never paste keys into chat or commit them.
- **Access to Wix DNS for `arclabs.in`** (you add 4 records there).

## 1. Bootstrap (once per account)

```bash
export AWS_PROFILE=arc-admin
aws sts get-caller-identity            # must show the pilot account ID
cd infra/terraform/bootstrap
terraform init && terraform apply -var expected_account_id=<account-id>
```

This creates:
- the Terraform state bucket `arc-cloud-tfstate-<account-id>` (versioned, encrypted, TLS-only);
- the GitHub OIDC provider.

Keep `infra/terraform/bootstrap/terraform.tfstate` safe (password manager or private drive). It holds no secrets, but you need it to change the bootstrap later.

## 2. Configure the pilot stack

```bash
cd ../pilot
cp terraform.tfvars.example terraform.tfvars      # set alert_email; it is git-ignored
terraform init -backend-config="bucket=arc-cloud-tfstate-<account-id>"
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
- **Confirm both SNS subscription emails** that AWS sends to `alert_email`: `arc-cloud-pilot-alerts` (ap-south-1: server, database, certificates, worker) and `arc-cloud-pilot-uptime` (us-east-1: API and MQTT reachability; Route 53 metrics exist only there). No alarm reaches you until you do.
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

If the workflow fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`, compare the subject
GitHub sent with the one the role trusts (`github_oidc_subject` in `deploy_role.tf`):

```bash
aws cloudtrail lookup-events --region ap-south-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 5 --query 'Events[].CloudTrailEvent' --output json \
| python3 -c "import sys,json; [print(json.loads(e)['userIdentity'].get('userName'), '|', json.loads(e).get('errorCode')) for e in json.load(sys.stdin)]"
```

This repository's tokens use the ID-based form `repo:techarclab@166861876/Arc_Labs-Cloud@1415316437:environment:pilot`.
For a fork or another repository, set `github_repository`, `github_owner_id` and `github_repository_id`
(`gh api repos/OWNER/NAME --jq '.owner.id, .id'`).

## 7. Lock down sign-up and set operators

Register the first admin account in the console. Then, on the server (`aws ssm start-session …`):

```bash
sudo tee /etc/arc-cloud/extra.env >/dev/null <<'EOF'
ALLOW_SIGNUP=false
# GOOGLE_CLIENT_ID=…apps.googleusercontent.com   (add https://arcloud.arclabs.in as an authorized JS origin)
# SMTP_URL=smtps://user:pass@smtp.example.com:465 (alert emails; without it they are recorded as skipped)
EOF
sudo arc-deploy main
```

Only the keys shown above are read from `extra.env`.

**Platform admins** (ARC LABS staff: every organization, plans, invite codes) come only from the database flag
`users.is_platform_admin`, set with the operator tool on the server. The person must already have an account, and you
must have confirmed it is really theirs: sign-up does not verify email addresses.

```bash
COMPOSE="docker compose -f /opt/arc-cloud/deploy/aws/docker-compose.yml"
sudo $COMPOSE run --rm --no-deps api node apps/api/dist/tools/platform-admin.js grant you@example.com --reason "first operator"
sudo $COMPOSE run --rm --no-deps api node apps/api/dist/tools/platform-admin.js list
sudo $COMPOSE run --rm --no-deps api node apps/api/dist/tools/platform-admin.js revoke someone@example.com --reason "left ARC LABS"
```

Each grant and revoke is recorded in `audit_logs` (`platform_admin.grant` / `platform_admin.revoke`) and applies on the
person's next request. A platform admin manages plans and codes for every organization, but sees an organization's
data only through time-limited, read-only, audited support access (Platform page). Keep the list short anyway.

`PLATFORM_ADMIN_EMAILS` is no longer used: it is ignored (it grants nothing), and the API logs a warning at startup if
it is still set. When upgrading from it, grant the same people with the tool **before** deploying, or they lose access.

## 8. Move data from Railway (optional, do it before real use)

On the server (`aws ssm start-session …`). This **replaces** everything in the RDS database with Railway's data.

```bash
COMPOSE="docker compose -f /opt/arc-cloud/deploy/aws/docker-compose.yml"
sudo $COMPOSE stop api worker emqx                      # nothing writes during the copy
# DATABASE_URL has no password (it rotates; see "Database password" below): add the current one from the password file.
DB_URL="$(sudo grep '^DATABASE_URL=' /etc/arc-cloud/api.env | cut -d= -f2-)"
DB_PW="$(sudo cat /opt/arc-cloud-data/db-secret/password | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(),safe=""))')"
DST="${DB_URL/@/:$DB_PW@}&sslrootcert=/certs/rds-ca.pem"
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
| OS security updates | `arc-os-patch.timer` applies Amazon Linux security advisories every Sunday ~03:30 IST and reboots only if the kernel or core libraries changed (~2 min downtime). AL2023 pins dnf to the AMI's release, so the script uses `--releasever=latest`. Manual run: `sudo arc-os-patch` (add `--no-reboot` to defer); last run: `journalctl -u arc-os-patch` |
| Firmware images (OTA) | Upload signed images to `s3://<console_bucket>/firmware/<device-type>/<version>.bin`; devices download them from `https://arcloud.arclabs.in/firmware/…` (CloudFront, Amazon Root CA 1, already pinned in firmware). Console deploys never delete `firmware/`. A wrong URL returns the console page instead of a 404, which the device rejects on the SHA-256 check |
| Database restore | RDS console → `arc-cloud-pilot` → Restore to point in time (7 days) |
| Secrets | Secrets Manager `arc-cloud/pilot/app` (app) and the RDS-managed master secret. App secrets are rewritten into `/etc/arc-cloud/*.env` (0600) on every deploy |
| Database password | **RDS rotates it every 7 days.** It is not in the env files: `arc-db-secret-sync.timer` copies the current one to `/opt/arc-cloud-data/db-secret/password` every minute (mounted read-only into the API and worker, which read it for every new connection). No restart is needed after a rotation; at most ~1 minute of refused new connections. Check: `journalctl -u arc-db-secret-sync` (logs only when it changes); `systemctl list-timers arc-db-secret-sync.timer` |
| Spend | Billing → Budgets → `arc-cloud-pilot-monthly` |

**Alerts (email via SNS; each also emails when it recovers):**

| Alarm | Fires when | First thing to check |
|---|---|---|
| `api-down` (us-east-1) | `https://api.…/health/deep` fails for 3 min from Route 53's checkers: server, Caddy, API or database down, the API lost its broker connection, or DNS broken | `docker ps`; `docker exec arc-cloud-api-1 wget -qO- http://127.0.0.1:3000/health/deep`; `docker logs arc-cloud-api-1` |
| `mqtt-down` (us-east-1) | TCP to `mqtt.…:8883` fails for 3 min | `docker logs arc-cloud-emqx-1` |
| `cert-expiry-api` / `cert-expiry-mqtt` | Certificate served on :443 / :8883 has < 14 days left, or could not be read (-1) | Caddy logs (renewal); for mqtt `sudo arc-cert-sync` |
| `worker-not-ready` | Ingestion worker reports database/broker not OK for 10 min, **or `arc-monitor` stopped reporting** | `docker logs arc-cloud-worker-1`; `systemctl status arc-monitor.timer` |
| existing | server recover/reboot, CPU credits, database CPU and storage, budget | see above |

`arc-monitor.timer` runs `/usr/local/bin/arc-monitor` every 5 minutes (manual run: `sudo arc-monitor`; history: `journalctl -u arc-monitor`). Let's Encrypt stopped sending expiry emails in June 2025, so these alarms are the only certificate warning. Expect an alert pair (down, then OK) if a Sunday patch reboot or a deploy takes longer than about 3 minutes.

**Scale-up signals:**
- The `server-cpu-credits` alarm fires.
- The `db-cpu` alarm fires.
- You need more than ~500 active devices or a 99.9% SLA.

Next step at that point: the load-balanced design in the target ADR, which needs no code changes, only hosting.

## Pause and resume

To stop paying for compute while nobody uses the pilot (≈ $0.40/day paused instead of ≈ $1.40). Nothing is
deleted; the server keeps its Elastic IP, so DNS and devices need no change. Run on your computer with the
`arc-admin` profile, **not** inside an SSM session on the server.

**Pause**
```bash
export AWS_PROFILE=arc-admin
aws cloudwatch disable-alarm-actions --region ap-south-1 --alarm-names $(aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix arc-cloud-pilot --query 'MetricAlarms[].AlarmName' --output text)
aws cloudwatch disable-alarm-actions --region us-east-1 --alarm-names arc-cloud-pilot-api-down arc-cloud-pilot-mqtt-down
SERVER=$(aws ec2 describe-instances --region ap-south-1 --filters Name=tag:Name,Values=arc-cloud-pilot --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ec2 stop-instances --region ap-south-1 --instance-ids "$SERVER" && aws ec2 wait instance-stopped --region ap-south-1 --instance-ids "$SERVER"
aws rds stop-db-instance --region ap-south-1 --db-instance-identifier arc-cloud-pilot
```
**AWS starts a stopped RDS database again after 7 days.** Stop it again with the last line if the pause continues.

**Resume** (database first, then the server)
```bash
export AWS_PROFILE=arc-admin
aws rds start-db-instance --region ap-south-1 --db-instance-identifier arc-cloud-pilot   # an error here means it is already running
aws rds wait db-instance-available --region ap-south-1 --db-instance-identifier arc-cloud-pilot
SERVER=$(aws ec2 describe-instances --region ap-south-1 --filters Name=tag:Name,Values=arc-cloud-pilot --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ec2 start-instances --region ap-south-1 --instance-ids "$SERVER" && aws ec2 wait instance-running --region ap-south-1 --instance-ids "$SERVER"
sleep 180; curl -s https://api.arcloud.arclabs.in/health/deep; echo     # {"status":"ok","db":true,"mqtt":"connected"}
aws cloudwatch enable-alarm-actions --region ap-south-1 --alarm-names $(aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix arc-cloud-pilot --query 'MetricAlarms[].AlarmName' --output text)
aws cloudwatch enable-alarm-actions --region us-east-1 --alarm-names arc-cloud-pilot-api-down arc-cloud-pilot-mqtt-down
```
The weekly database password rotation also happens while paused; the server picks up the current password
within a minute of starting (`arc-db-secret-sync`).

## Tear down

Deletes the pilot for good: no final database snapshot, Terraform state and secrets destroyed. Run in **AWS
CloudShell** (browser), Mumbai region selected. Each script first only lists what it found; nothing changes
until you run it again with `--delete` and type the account ID a second time. Both are safe to re-run.

1. **Pilot account** (sign in to the pilot account from the access portal, open CloudShell):
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/techarclab/Arc_Labs-Cloud/main/deploy/aws/teardown-pilot.sh
   bash teardown-pilot.sh <pilot-account-id>            # list
   bash teardown-pilot.sh <pilot-account-id> --delete   # 20-40 min, mostly waiting for RDS and CloudFront
   ```
   It ends by checking every region for instances, volumes, snapshots, Elastic IPs, NAT gateways, RDS, load
   balancers and secrets, and says "nothing billable is left" only when that is true.
2. **Management account**, old staging leftovers (2026-10-11 IoT Core design). Only `arc-staging*` /
   `arc_staging*` names, role `claude-arc-cloud-deployer` and an unattached IoT policy `arc-device` are touched;
   ArcHome, IAM Identity Center and its KMS key are not:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/techarclab/Arc_Labs-Cloud/main/deploy/aws/teardown-mgmt-staging.sh
   bash teardown-mgmt-staging.sh <management-account-id>            # list
   bash teardown-mgmt-staging.sh <management-account-id> --delete
   ```
3. **Close the pilot account**, only after step 1 reports nothing left: management account → AWS Organizations →
   AWS accounts → the pilot account → **Close account**. It shows `CLOSED` and can be reopened for 90 days, then
   AWS deletes it permanently. You still receive one last bill for usage up to the closing date.
4. **GitHub** (Settings → Secrets and variables → Actions, and Settings → Environments): delete the variables
   `AWS_DEPLOY_ROLE_ARN`, `SERVER_INSTANCE_ID`, `CONSOLE_BUCKET`, `CONSOLE_DISTRIBUTION_ID`, `API_URL` and the
   `pilot` environment.
5. **Wix DNS:** delete the `_…arcloud` CNAME that validated the ACM certificate. Leave the three A records
   (they point at Oracle).

## Security notes

- **Open ports:** 80 (ACME + redirect), 443 (API) and 8883 (MQTT/TLS). EMQX's 1883 and dashboard (18083), the API hook port (3001) and PostgreSQL are not reachable from the internet.
- **Database connection:** RDS forces TLS (`rds.force_ssl=1`), and the app verifies the RDS certificate (`sslmode=verify-full` with the RDS CA bundle).
- **Instance metadata:** IMDSv2 only, hop limit 1, so containers cannot use the server's IAM role.
- **Terraform state** contains the generated app secrets. The bucket is private, encrypted, versioned and TLS-only. Treat state access as secret access.
- **Database user:** the app currently connects as the RDS master user. It is not a superuser, and row-level security still applies through `arc_tenant`. Moving to a dedicated least-privilege login is a follow-up.
- **Certificate issuance (optional hardening):** Wix's DNS editor shows no CAA records. If it ever offers them, add `0 issue "letsencrypt.org"` and `0 issue "amazon.com"` for `arcloud.arclabs.in`.
