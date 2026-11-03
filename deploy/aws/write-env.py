#!/usr/bin/env python3
"""Writes /etc/arc-cloud/{api,worker,emqx}.env from Secrets Manager + /etc/arc-cloud/config.

Each service gets only the secrets it needs. Optional operator settings (Google sign-in client ID,
platform admins, SMTP, signup) go in /etc/arc-cloud/extra.env; only the keys in EXTRA_KEYS are used.

The database password is NOT in the env files: RDS rotates the master password every 7 days, and env files
are read only when a container starts (the 2026-10-31 outage). It goes to DB_SECRET_DIR/password, mounted
read-only into the API and worker, which read it for every new connection (packages/shared/src/db.ts).
  write-env.py                     all env files + the password file (arc-deploy)
  write-env.py --db-password-only  just refresh the password file (arc-db-secret-sync.timer, every minute)
"""
import argparse
import json
import os
import re
import subprocess
from urllib.parse import quote

CONF = os.environ.get("ARC_CONF_DIR", "/etc/arc-cloud")
EXTRA_KEYS = {"GOOGLE_CLIENT_ID", "PLATFORM_ADMIN_EMAILS", "ALLOW_SIGNUP", "SMTP_URL", "MAIL_FROM"}
DB_SECRET_DIR = os.environ.get("ARC_DB_SECRET_DIR", "/opt/arc-cloud-data/db-secret")
DB_PASSWORD_IN_CONTAINER = "/run/arc-db/password"  # docker-compose.yml mounts DB_SECRET_DIR at /run/arc-db
CONTAINER_GID = 1000  # the `node` user in the API/worker image (node:22-alpine)


def read_kv(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def secret(arn, region):
    raw = subprocess.check_output(
        ["aws", "secretsmanager", "get-secret-value", "--region", region, "--secret-id", arn,
         "--query", "SecretString", "--output", "text"], text=True)
    return json.loads(raw)


def write(name, values):
    path = os.path.join(CONF, name)
    for k, v in values.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", k) or "\n" in str(v):
            raise SystemExit(f"refusing to write unsafe env entry {k!r}")
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.writelines(f"{k}={v}\n" for k, v in sorted(values.items()))
    os.replace(path + ".tmp", path)


def write_db_password(password):
    """Replaces DB_SECRET_DIR/password atomically (rename, so the bind-mounted directory sees the new file).
    Returns True when the password changed."""
    if not password or "\n" in password:
        raise SystemExit("refusing to write an empty or multi-line database password")
    path = os.path.join(DB_SECRET_DIR, "password")
    try:
        with open(path, encoding="utf-8") as f:
            if f.read().strip() == password:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(DB_SECRET_DIR, mode=0o750, exist_ok=True)
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(password + "\n")
    if os.geteuid() == 0:  # root-owned, readable by the container's node group only
        os.chown(DB_SECRET_DIR, 0, CONTAINER_GID)
        os.chmod(DB_SECRET_DIR, 0o750)
        os.chown(path + ".tmp", 0, CONTAINER_GID)
    os.replace(path + ".tmp", path)
    return True


parser = argparse.ArgumentParser()
parser.add_argument("--db-password-only", action="store_true", help="only refresh the database password file")
args = parser.parse_args()

cfg = read_kv(os.path.join(CONF, "config"))
region = cfg["AWS_REGION"]
db = secret(cfg["DB_SECRET_ARN"], region)
changed = write_db_password(db["password"])
if args.db_password_only:
    if changed:
        print("[arc-db-secret-sync] database password changed (rotation); new connections use it from now on")
    raise SystemExit(0)

app = secret(cfg["APP_SECRET_ARN"], region)
extra = {k: v for k, v in read_kv(os.path.join(CONF, "extra.env")).items() if k in EXTRA_KEYS}

# No password in the URL: node-postgres would let it override the password file.
database_url = (
    f"postgres://{quote(db['username'], safe='')}"
    f"@{cfg['DB_HOST']}:{cfg['DB_PORT']}/{cfg['DB_NAME']}?sslmode=verify-full"
)

write("api.env", {
    "NODE_ENV": "production",
    "DATABASE_URL": database_url,
    "DATABASE_PASSWORD_FILE": DB_PASSWORD_IN_CONTAINER,
    "JWT_SECRET": app["JWT_SECRET"],
    "INTERNAL_HOOK_TOKEN": app["INTERNAL_HOOK_TOKEN"],
    "MQTT_SERVICE_USERNAME": "arc-ingest",
    "MQTT_SERVICE_PASSWORD": app["MQTT_SERVICE_PASSWORD"],
    "MQTT_PUBLIC_HOST": cfg["MQTT_HOST"],
    "MQTT_PUBLIC_PORT": "8883",
    "HTTP_PUBLIC_URL": f"https://{cfg['API_HOST']}",
    "CORS_ORIGINS": cfg["CONSOLE_ORIGIN"],
    "CONSOLE_URL": cfg["CONSOLE_ORIGIN"],
    "DEVICE_KEY_IN_QUERY": "false",
    "EMQX_API_KEY": "arc-api",
    "EMQX_API_SECRET": app["EMQX_API_SECRET"],
    **{k: v for k, v in extra.items() if k != "SMTP_URL" and k != "MAIL_FROM"},
})
write("worker.env", {
    "NODE_ENV": "production",
    "DATABASE_URL": database_url,
    "DATABASE_PASSWORD_FILE": DB_PASSWORD_IN_CONTAINER,
    "MQTT_SERVICE_USERNAME": "arc-ingest",
    "MQTT_SERVICE_PASSWORD": app["MQTT_SERVICE_PASSWORD"],
    "CONSOLE_URL": cfg["CONSOLE_ORIGIN"],
    **{k: v for k, v in extra.items() if k in ("SMTP_URL", "MAIL_FROM")},
})
write("emqx.env", {
    "INTERNAL_HOOK_TOKEN": app["INTERNAL_HOOK_TOKEN"],
    "ARC_EMQX_API_KEY": "arc-api",  # not EMQX_*: EMQX treats those as config overrides
    "ARC_EMQX_API_SECRET": app["EMQX_API_SECRET"],
    "EMQX_DASHBOARD__DEFAULT_PASSWORD": app["EMQX_DASHBOARD_PASS"],
    "EMQX_NODE__COOKIE": app["EMQX_NODE_COOKIE"],
})
print("[arc-deploy] wrote api.env, worker.env, emqx.env")
