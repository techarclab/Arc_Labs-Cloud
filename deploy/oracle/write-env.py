#!/usr/bin/env python3
"""Writes /etc/arc-cloud/{api,worker,emqx}.env and the database password files on the Oracle VM.

There is no secrets service: secrets are generated once into /etc/arc-cloud/secrets.env (root, 0600) and reused on
every deploy. A key that is missing (first deploy, or a new key added later) is generated; existing keys are never
changed, because the database role's password is fixed when PostgreSQL first initialises its data directory.

Database passwords go to DB_SECRET_DIR (mounted read-only into postgres, api and worker at /run/arc-db):
  password               arc_admin (the app's role)      owner 999 (postgres), group 1000 (node), 0640
  pg-superuser-password  postgres (maintenance only)     owner 999, 0600
Optional operator settings (platform admins, sign-up, SMTP, Google client ID) go in /etc/arc-cloud/extra.env.
"""
import os
import re
import secrets
import string

CONF = os.environ.get("ARC_CONF_DIR", "/etc/arc-cloud")
DB_SECRET_DIR = os.environ.get("ARC_DB_SECRET_DIR", "/opt/arc-cloud-data/db-secret")
# PLATFORM_ADMIN_EMAILS is no longer passed on (platform admins come only from users.is_platform_admin, set with
# apps/api/dist/tools/platform-admin.js); an old extra.env that still has it is filtered out like any unknown key.
EXTRA_KEYS = {"GOOGLE_CLIENT_ID", "ALLOW_SIGNUP", "ORGS_PER_USER", "SMTP_URL", "MAIL_FROM"}
POSTGRES_UID = 999  # `postgres` user in the postgres:16 (Debian) image
NODE_GID = 1000     # `node` user in the API/worker image (node:22-alpine)
SECRET_KEYS = {     # name -> length
    "JWT_SECRET": 48, "INTERNAL_HOOK_TOKEN": 40, "MQTT_SERVICE_PASSWORD": 32, "EMQX_API_SECRET": 40,
    "EMQX_DASHBOARD_PASS": 24, "EMQX_NODE_COOKIE": 32, "DB_PASSWORD": 32, "PG_SUPERUSER_PASSWORD": 32,
}
ALPHABET = string.ascii_letters + string.digits  # URL- and env-file-safe


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


def write_file(path, content, mode, uid=None, gid=None):
    """Atomic replace (rename), so bind-mounted directories always see a complete file."""
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    os.fchmod(fd, mode)  # explicit: arc-deploy runs under umask 077, which would strip the group read bit
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    if os.geteuid() == 0 and uid is not None:
        os.chown(path + ".tmp", uid, gid if gid is not None else uid)
    os.replace(path + ".tmp", path)


def write_env(name, values):
    for k, v in values.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", k) or "\n" in str(v):
            raise SystemExit(f"refusing to write unsafe env entry {k!r}")
    write_file(os.path.join(CONF, name), "".join(f"{k}={v}\n" for k, v in sorted(values.items())), 0o600)


cfg = read_kv(os.path.join(CONF, "config"))
for key in ("API_HOST", "MQTT_HOST", "CONSOLE_HOST"):
    if not cfg.get(key):
        raise SystemExit(f"{key} missing in {CONF}/config (see docs/deploy/oracle-free.md)")

secrets_path = os.path.join(CONF, "secrets.env")
sec = read_kv(secrets_path)
created = [k for k in SECRET_KEYS if not sec.get(k)]
for k in created:
    sec[k] = "".join(secrets.choice(ALPHABET) for _ in range(SECRET_KEYS[k]))
if created:
    write_env("secrets.env", sec)
    print(f"[arc-deploy] generated secrets: {', '.join(created)} (kept in {secrets_path}; back this file up)")

os.makedirs(DB_SECRET_DIR, exist_ok=True)
if os.geteuid() == 0:
    os.chown(DB_SECRET_DIR, 0, NODE_GID)
    os.chmod(DB_SECRET_DIR, 0o751)  # node group can list; postgres (other) can only open files it knows
write_file(os.path.join(DB_SECRET_DIR, "password"), sec["DB_PASSWORD"] + "\n", 0o640, POSTGRES_UID, NODE_GID)
write_file(os.path.join(DB_SECRET_DIR, "pg-superuser-password"), sec["PG_SUPERUSER_PASSWORD"] + "\n", 0o600, POSTGRES_UID)

extra = {k: v for k, v in read_kv(os.path.join(CONF, "extra.env")).items() if k in EXTRA_KEYS}
console = f"https://{cfg['CONSOLE_HOST']}"
# No password in the URL: node-postgres would let it override DATABASE_PASSWORD_FILE.
database_url = "postgres://arc_admin@postgres:5432/arc_cloud?sslmode=disable"  # private Docker network only

write_env("api.env", {
    "NODE_ENV": "production",
    "DATABASE_URL": database_url,
    "DATABASE_PASSWORD_FILE": "/run/arc-db/password",
    "JWT_SECRET": sec["JWT_SECRET"],
    "INTERNAL_HOOK_TOKEN": sec["INTERNAL_HOOK_TOKEN"],
    "MQTT_SERVICE_USERNAME": "arc-ingest",
    "MQTT_SERVICE_PASSWORD": sec["MQTT_SERVICE_PASSWORD"],
    "MQTT_PUBLIC_HOST": cfg["MQTT_HOST"],
    "MQTT_PUBLIC_PORT": "8883",
    "HTTP_PUBLIC_URL": f"https://{cfg['API_HOST']}",
    "CORS_ORIGINS": console,
    "CONSOLE_URL": console,
    "DEVICE_KEY_IN_QUERY": "false",
    "EMQX_API_KEY": "arc-api",
    "EMQX_API_SECRET": sec["EMQX_API_SECRET"],
    **{k: v for k, v in extra.items() if k not in ("SMTP_URL", "MAIL_FROM")},
})
write_env("worker.env", {
    "NODE_ENV": "production",
    "DATABASE_URL": database_url,
    "DATABASE_PASSWORD_FILE": "/run/arc-db/password",
    "MQTT_SERVICE_USERNAME": "arc-ingest",
    "MQTT_SERVICE_PASSWORD": sec["MQTT_SERVICE_PASSWORD"],
    "CONSOLE_URL": console,
    **{k: v for k, v in extra.items() if k in ("SMTP_URL", "MAIL_FROM")},
})
write_env("emqx.env", {
    "INTERNAL_HOOK_TOKEN": sec["INTERNAL_HOOK_TOKEN"],
    "ARC_EMQX_API_KEY": "arc-api",  # not EMQX_*: EMQX treats those as config overrides
    "ARC_EMQX_API_SECRET": sec["EMQX_API_SECRET"],
    "EMQX_DASHBOARD__DEFAULT_PASSWORD": sec["EMQX_DASHBOARD_PASS"],
    "EMQX_NODE__COOKIE": sec["EMQX_NODE_COOKIE"],
})
print("[arc-deploy] wrote api.env, worker.env, emqx.env and the database password files")
