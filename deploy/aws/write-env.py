#!/usr/bin/env python3
"""Writes /etc/arc-cloud/{api,worker,emqx}.env from Secrets Manager + /etc/arc-cloud/config.

Each service gets only the secrets it needs. Optional operator settings (Google sign-in client ID,
platform admins, SMTP, signup) go in /etc/arc-cloud/extra.env; only the keys in EXTRA_KEYS are used.
"""
import json
import os
import re
import subprocess
from urllib.parse import quote

CONF = os.environ.get("ARC_CONF_DIR", "/etc/arc-cloud")
EXTRA_KEYS = {"GOOGLE_CLIENT_ID", "PLATFORM_ADMIN_EMAILS", "ALLOW_SIGNUP", "SMTP_URL", "MAIL_FROM"}


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


cfg = read_kv(os.path.join(CONF, "config"))
region = cfg["AWS_REGION"]
app = secret(cfg["APP_SECRET_ARN"], region)
db = secret(cfg["DB_SECRET_ARN"], region)
extra = {k: v for k, v in read_kv(os.path.join(CONF, "extra.env")).items() if k in EXTRA_KEYS}

database_url = (
    f"postgres://{quote(db['username'], safe='')}:{quote(db['password'], safe='')}"
    f"@{cfg['DB_HOST']}:{cfg['DB_PORT']}/{cfg['DB_NAME']}?sslmode=verify-full"
)

write("api.env", {
    "NODE_ENV": "production",
    "DATABASE_URL": database_url,
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
    "MQTT_SERVICE_USERNAME": "arc-ingest",
    "MQTT_SERVICE_PASSWORD": app["MQTT_SERVICE_PASSWORD"],
    "CONSOLE_URL": cfg["CONSOLE_ORIGIN"],
    **{k: v for k, v in extra.items() if k in ("SMTP_URL", "MAIL_FROM")},
})
write("emqx.env", {
    "INTERNAL_HOOK_TOKEN": app["INTERNAL_HOOK_TOKEN"],
    "EMQX_API_KEY": "arc-api",
    "EMQX_API_SECRET": app["EMQX_API_SECRET"],
    "EMQX_DASHBOARD__DEFAULT_PASSWORD": app["EMQX_DASHBOARD_PASS"],
    "EMQX_NODE__COOKIE": app["EMQX_NODE_COOKIE"],
})
print("[arc-deploy] wrote api.env, worker.env, emqx.env")
