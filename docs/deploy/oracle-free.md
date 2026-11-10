# ARC Cloud on Oracle Cloud "Always Free" (≈ ₹0/month)

One Oracle Cloud virtual machine runs everything: Caddy (HTTPS), the console, the API, the ingestion worker, the
EMQX broker and PostgreSQL. It is the same code and the same containers as the (retired, 2026-11-10) AWS pilot
([aws-pilot.md](aws-pilot.md)); the differences are listed below. Files: [`deploy/oracle/`](../../deploy/oracle).

**Use it for** development, demos and small pilots. **Before paying customers depend on it**, move to managed
hosting (managed database backups, monitoring, patching): the AWS pilot can be recreated from aws-pilot.md, and
moving is a database dump + DNS change.

```
ESP32 devices ── MQTT over TLS :8883 ─┐
Browsers ─────── HTTPS :443 ──────────┤
                                      ▼
      Oracle VM  (Ampere A1, 2 OCPU / 12 GB, Ubuntu 24.04, home region Mumbai or Hyderabad)
      ├─ caddy     Let's Encrypt certificates; console (arcloud.…), API (api.arcloud.…), OTA files (/firmware)
      ├─ console   web app (nginx)
      ├─ api       REST API + broker hooks          ─┐
      ├─ worker    ingestion, alerts, webhooks, OTA ─┼─ PostgreSQL 16 (container, role arc_admin, not superuser)
      ├─ emqx      MQTT broker (TLS on 8883)          │   data: /opt/arc-cloud-data/postgres
      └─ postgres  ───────────────────────────────────┘   backups: /opt/arc-cloud-data/backups (daily, 7 kept)
```

| | AWS pilot | Oracle Always Free |
|---|---|---|
| Cost | ≈ ₹4,700/month (≈ ₹1,200 paused) | ₹0 within the Always Free limits |
| Database | RDS, automatic backups + point-in-time restore, password rotated weekly | PostgreSQL container, daily `pg_dump` (7 kept on the VM) |
| Console + OTA files | S3 + CloudFront | Caddy on the VM |
| Secrets | Secrets Manager | generated once on the VM, `/etc/arc-cloud/secrets.env` (root only) |
| Server access | SSM (no SSH) | SSH with a key, port 22 limited to your IP |
| Patching | weekly timer | Ubuntu unattended security upgrades, reboot at 03:30 IST if needed |
| Monitoring | CloudWatch + Route 53 alarms | none built in: add a free external uptime check (step 9) |
| Deploys | GitHub Actions → SSM | `sudo arc-deploy` over SSH |

## Limits and risks (Oracle, checked 2026-11-09)

- **Size:** Always Free Ampere A1 is **2 OCPU and 12 GB RAM** in total (cut from 4/24 on 2026-06-15), plus
  200 GB of block storage including boot volumes, and 5 volume backups.
  [Oracle: Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)
- **Home region only, chosen at sign-up, permanent.** Choose **India West (Mumbai)** or **India South (Hyderabad)**.
  Free resources cannot be created in any other region.
- **Idle reclamation:** Oracle may reclaim an Always Free VM if, over 7 days, CPU (95th percentile), network *and*
  memory utilisation are all below 20%. A quiet development server can meet that. Upgrading the account to
  Pay-As-You-Go (still ₹0 within the free limits) is reported by users to avoid it; Oracle's documentation does
  not state this. Keep backups off the VM (step 9) either way.
- **"Out of capacity":** free A1 VMs are often unavailable in popular regions; creating one may need retries.
- **One server:** if the VM or its disk is lost, you restore from your latest off-VM backup.

## 1. Oracle account

1. Sign up at oracle.com/cloud/free. **Home region: India West (Mumbai) or India South (Hyderabad).** A card is
   verified but Always Free resources are not charged.
2. Turn on multi-factor authentication for your Oracle user (Profile → Security).
3. Optional: upgrade to Pay-As-You-Go (see idle reclamation) and set a budget alert at ₹100
   (Billing → Budgets), so anything that is not free is noticed at once.

## 2. Create the VM

On your Mac, make an SSH key for this server only:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/arc-oracle -C arc-oracle
```
Oracle console → **Compute → Instances → Create instance**:
- **Image:** Canonical Ubuntu 24.04 (the aarch64 build is chosen automatically for the A1 shape).
- **Shape:** Ampere → **VM.Standard.A1.Flex**, **2 OCPU, 12 GB** (shows "Always Free-eligible").
- **Networking:** create a new VCN + public subnet, **assign a public IPv4 address**.
- **SSH keys:** paste `~/.ssh/arc-oracle.pub`.
- **Boot volume:** 100 GB (the free 200 GB includes it).

Note the **public IP address** once it is running. If the IP ever changes, update the three DNS records (step 5).

## 3. Open the ports (Oracle network)

Instance → subnet → **Security List** → **Add ingress rules**, source `0.0.0.0/0`, TCP, destination ports
**80**, **443**, **8883**. Edit the existing **22** rule: set the source to *your* IP (`curl https://checkip.amazonaws.com`)
followed by `/32`, instead of `0.0.0.0/0`.

The VM's own firewall (Oracle's Ubuntu image rejects everything but SSH) is opened by the bootstrap script.

## 4. Bootstrap the VM (once)

```bash
ssh -i ~/.ssh/arc-oracle ubuntu@<VM_IP>
curl -fsSL https://raw.githubusercontent.com/techarclab/Arc_Labs-Cloud/main/deploy/oracle/bootstrap.sh -o bootstrap.sh
sudo bash bootstrap.sh --console-host arcloud.arclabs.in --api-host api.arcloud.arclabs.in \
     --mqtt-host mqtt.arcloud.arclabs.in --email <your email for Let's Encrypt>
```
It installs Docker, opens 80/443/8883 in the VM firewall, turns on automatic security updates, clones the code to
`/opt/arc-cloud` and writes `/etc/arc-cloud/config`. Safe to run again.

## 5. DNS (Wix)

Point the three names at the VM (Wix → Domains → arclabs.in → DNS records):

| Host | Type | Value | Change from the AWS setup |
|---|---|---|---|
| `arcloud` | **A** | `<VM_IP>` | delete the CNAME to CloudFront first, then add the A record |
| `api.arcloud` | A | `<VM_IP>` | edit (was the AWS Elastic IP) |
| `mqtt.arcloud` | A | `<VM_IP>` | edit (was the AWS Elastic IP) |

The `_…arcloud` ACM validation CNAME is no longer needed (AWS pilot deleted). Check from the Mac before deploying
(all three must print the VM IP): `for h in arcloud api.arcloud mqtt.arcloud; do dig +short $h.arclabs.in; done`

Devices need nothing new: they connect by name, and the Let's Encrypt chain (ISRG Root X1) is the one their
firmware already pins.

## 6. First account (skip if you move your data from AWS, step 7)

On the VM, before the first deploy:
```bash
sudo tee /etc/arc-cloud/extra.env > /dev/null <<'EOF'
ALLOW_SIGNUP=true
PLATFORM_ADMIN_EMAILS=<your email>
EOF
```
After deploying (step 8), register in the console with that email. New accounts must confirm their email address,
so set up email (step 10) first, or confirm this one account by hand:
`sudo docker exec -i -u postgres arc-cloud-postgres-1 psql -d arc_cloud -c "UPDATE users SET email_verified_at = now() WHERE email = '<your email>'"`.

`ALLOW_SIGNUP=true` is open self-service sign-up (anyone 18+; under-18s only with an institution's invite code). Set
`ALLOW_SIGNUP=false` to make every sign-up need an invite code (Platform → Invite codes), then `sudo arc-deploy`.

## 7. Move your data from AWS (optional, keeps accounts, devices and history)

> **No longer possible:** the AWS pilot was deleted on 2026-11-10 without a final snapshot. Kept for reference.

Your ESP32s keep their stored credentials, so with the data moved they reconnect without being provisioned again.
Personal data is copied here: delete the dump files at the end.

1. **Deploy on Oracle first** (step 8), so PostgreSQL exists.
2. **Start AWS** with "Resume" in [aws-pilot.md](aws-pilot.md#pause-and-resume) (database *and* server: the
   server is the tunnel to the private database). Skip re-enabling the alarms.
3. **Look up the AWS names** (Mac; same terminal for the next steps):
   ```bash
   export AWS_PROFILE=arc-admin AWS_REGION=ap-south-1
   SERVER=$(aws ec2 describe-instances --filters Name=tag:Name,Values=arc-cloud-pilot Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
   DB_HOST=$(aws rds describe-db-instances --db-instance-identifier arc-cloud-pilot --query 'DBInstances[0].Endpoint.Address' --output text)
   DB_SECRET=$(aws rds describe-db-instances --db-instance-identifier arc-cloud-pilot --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
   echo "$SERVER $DB_HOST"
   ```
4. **Tunnel to the database** (keep it running; `&` puts it in the background of this terminal):
   ```bash
   aws ssm start-session --target "$SERVER" --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters "host=$DB_HOST,portNumber=5432,localPortNumber=15432" > /dev/null &
   sleep 5
   ```
5. **Dump it** (needs PostgreSQL 16 client tools: `brew install postgresql@16`):
   ```bash
   export PGPASSWORD="$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET" --query SecretString --output text \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')"
   "$(brew --prefix postgresql@16)/bin/pg_dump" -h 127.0.0.1 -p 15432 -U arc_admin -d arc_cloud -Fc -f ~/arc-cloud-aws.dump
   unset PGPASSWORD; kill %1
   ```
6. **Copy and restore:**
   ```bash
   scp -i ~/.ssh/arc-oracle ~/arc-cloud-aws.dump ubuntu@<VM_IP>:/tmp/
   ssh -t -i ~/.ssh/arc-oracle ubuntu@<VM_IP> 'sudo arc-restore /tmp/arc-cloud-aws.dump && rm /tmp/arc-cloud-aws.dump'
   rm ~/arc-cloud-aws.dump
   ```
   `arc-restore` reports any RDS-only grants that do not apply here (harmless), then checks the migrations and
   row-level security policies before starting the services again. It asks you to type `RESTORE` first.
7. **OTA firmware files** (only if you use releases):
   ```bash
   BUCKET=$(aws s3 ls | awk '/arc-cloud-pilot-console-/ {print $3}')
   aws s3 cp --recursive "s3://$BUCKET/firmware/" ~/arc-firmware/
   scp -i ~/.ssh/arc-oracle -r ~/arc-firmware ubuntu@<VM_IP>:/tmp/
   ssh -i ~/.ssh/arc-oracle ubuntu@<VM_IP> 'sudo cp -r /tmp/arc-firmware/. /opt/arc-cloud-data/firmware/ && rm -r /tmp/arc-firmware'
   ```
8. **Pause AWS again** ("Pause and resume" in aws-pilot.md). Your platform-admin email: set
   `PLATFORM_ADMIN_EMAILS=<your email>` and `ALLOW_SIGNUP=false` in `/etc/arc-cloud/extra.env`, then `sudo arc-deploy`.

## 8. Deploy

```bash
sudo arc-deploy          # or: sudo arc-deploy <branch | tag | commit>
```
It generates the secrets on the first run, builds the images on the VM (first build ≈ 10 minutes on 2 OCPU), starts
PostgreSQL, Caddy and the console, waits for the certificates, runs migrations, starts the rest and finishes with
`healthy: https://arcloud.arclabs.in … https://api.arcloud.arclabs.in`. If not, it prints the container logs.

Check: open the console and sign in; `curl -s https://api.arcloud.arclabs.in/health/deep` →
`{"status":"ok","db":true,"mqtt":"connected"}`; your ESP32 shows Online within ~5 minutes.

## 9. Backups and monitoring (do this the same day)

- **Daily database dump** (automatic, 02:30 IST): `/opt/arc-cloud-data/backups`, 7 kept. Run one now:
  `sudo arc-backup`. These copies are on the same VM.
- **Off the VM:** at least one of:
  - Oracle **boot volume backup policy**: Storage → Boot Volumes → the VM's volume → assign a backup policy
    (a custom weekly policy keeping ≤ 4 fits in the 5 free volume backups).
  - Copy dumps to your Mac now and then:
    `scp -i ~/.ssh/arc-oracle "ubuntu@<VM_IP>:/opt/arc-cloud-data/backups/*.dump" ~/arc-backups/` (the files are
    root-only; run `sudo cp /opt/arc-cloud-data/backups/<file> /tmp/ && sudo chown ubuntu /tmp/<file>` first), or
  - an executable `/etc/arc-cloud/backup-upload` script, called by `arc-backup` with each new file path (for
    example an OCI Object Storage upload).
- **Restore:** `sudo arc-restore /opt/arc-cloud-data/backups/<file>.dump`.
- **Secrets:** keep a copy of `/etc/arc-cloud/secrets.env` in your password manager (not in Git, not in chat).
- **Uptime:** there is no CloudWatch here. Add a free external monitor (for example UptimeRobot or Better Stack):
  an HTTPS keyword check on `https://api.arcloud.arclabs.in/health/deep` for `"status":"ok"`, and a TCP check on
  `mqtt.arcloud.arclabs.in:8883`, alerting your email.

## 10. Email: account confirmation and alerts (Brevo)

New accounts get a confirmation link from `no-reply@arclabs.in`; until they open it they can only sign in and ask
for another link. Alert emails use the same settings. Without this step nobody can finish signing up.

1. **Brevo account** (free plan: 300 emails/day, shared by all sending) at brevo.com, with a company address.
2. **Authenticate `arclabs.in`:** Brevo → Senders, Domains & Dedicated IPs → Domains → Add a domain. Brevo shows a
   *Brevo code* TXT record and DKIM records (two CNAMEs `brevo1._domainkey` / `brevo2._domainkey`, or one TXT), and a
   DMARC record. Add them in **Wix DNS exactly as Brevo shows them**, then click *Authenticate* in Brevo. Add the DMARC
   record only if `arclabs.in` has none yet (one per domain; check with `dig +short TXT _dmarc.arclabs.in`). No SPF
   change is needed on Brevo's shared IPs. Do not change the domain's MX records: Microsoft 365 mail is unaffected.
3. **Sender:** Senders → add `no-reply@arclabs.in` (name "ARC Cloud"). If Brevo asks to confirm the address by email,
   that address must receive mail once: create it as an alias or shared mailbox in Microsoft 365 first.
4. **SMTP key:** SMTP & API → SMTP → *Generate a new SMTP key*. Note the **SMTP login** shown on that page and the key.
   Never paste the key into chat, email or git.
5. **On the VM**, add to `/etc/arc-cloud/extra.env` (in the login, write `@` as `%40`):
   ```bash
   sudo nano /etc/arc-cloud/extra.env
   ```
   ```
   SMTP_URL=smtp://<smtp-login-with-%40>:<smtp-key>@smtp-relay.brevo.com:587/?requireTLS=true
   MAIL_FROM=ARC Cloud <no-reply@arclabs.in>
   ALLOW_SIGNUP=true
   ```
   then `sudo arc-deploy`. The file stays root-only (0600); `write-env` copies these two values only into the worker's
   settings, never the API's.
6. **Test:** sign up in a private window with an address you can read. The email should arrive within a minute; if
   not, `sudo docker logs --since 10m arc-cloud-worker-1 2>&1 | grep -i deliver`, and
   `SELECT status, last_error FROM deliveries ORDER BY id DESC LIMIT 3;` in `psql`.

## Operating it

| Task | Command (on the VM) |
|---|---|
| Deploy an update | `sudo arc-deploy main` |
| Status | `sudo docker compose -f /opt/arc-cloud/deploy/oracle/docker-compose.yml ps` |
| Logs | `sudo docker logs --tail 100 arc-cloud-api-1` (also `-worker-1`, `-emqx-1`, `-caddy-1`, `-postgres-1`) |
| Backup now / list | `sudo arc-backup` / `sudo ls -lh /opt/arc-cloud-data/backups` |
| Restore | `sudo arc-restore <file.dump>` |
| Certificates | Caddy renews automatically; `arc-cert-sync.timer` copies the MQTT one to EMQX daily |
| OS updates | automatic (unattended-upgrades); reboots at 03:30 IST when an update needs it |
| Upload an OTA image | `scp` it to the VM, then `sudo cp <file> /opt/arc-cloud-data/firmware/<type>/<version>.bin` |

**One deploy at a time.** Do not run `arc-deploy` twice in parallel.

## Moving to AWS later

1. `sudo arc-backup` on Oracle and copy the newest dump to your Mac.
2. Recreate the pilot in a new account (aws-pilot.md, steps 1-5; restore the deploy workflow from git history),
   tunnel to RDS as in step 7, restore with
   `pg_restore -h 127.0.0.1 -p 15432 -U arc_admin -d arc_cloud --clean --if-exists --no-owner <file.dump>`.
3. Point the three DNS names back (`api.arcloud`, `mqtt.arcloud` → the Elastic IP; `arcloud` → CNAME to the
   CloudFront domain from `terraform output wix_console_cname`), then run the AWS deploy once.
