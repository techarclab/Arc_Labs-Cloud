# Broker outage (EMQX)

**You notice:** every MQTT device shows *Offline* at once; an "offline" alert rule fires for many devices; `worker` logs `reconnecting to broker`; HTTP devices still work.

**Check**
1. Railway → `emqx` → Deployments: is the latest deployment *Crashed* or restarting?
2. `emqx` logs:
   - `no TLS certificate` → the `MQTT_TLS_*_B64` variables are missing or broken (re-run `bash infra/scripts/railway-cert-vars.sh <tcp-proxy-domain>` and paste them).
   - `nxdomain` on AUTHN/AUTHZ → the broker can't reach the API: `API_HOOKS_URL` must be `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3001`.
   - `401` from hooks → `INTERNAL_HOOK_TOKEN` differs between `api` and `emqx` (both should reference `${{shared.INTERNAL_HOOK_TOKEN}}`).
3. Railway → `emqx` → Settings → Networking: the TCP proxy for port 8883 still exists. If it was recreated, its domain/port changed: update devices (or keep the old proxy).

**Fix:** correct the variable, then *Redeploy* `emqx`. Devices reconnect automatically (they retry every few seconds); the worker re-sends control values and open commands on reconnect.

**Confirm:** devices go *Online* within a minute; offline alerts recover by themselves (resolution `recovered`).

**Data:** messages devices sent while the broker was down are lost unless the firmware buffers them (the ESP32 example retries on reconnect; it does not buffer). HTTP devices are unaffected.
