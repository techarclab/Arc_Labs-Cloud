# Credential compromise

Act immediately; every step is recorded in the audit log.

| What leaked | Do this |
|---|---|
| **One device's password / HTTP key** | Device page → *Replace password* (old one stops working at once). If the device itself is stolen: *Revoke*. Flash the new password. |
| **Organization API key** | *Integrations → API keys* → Revoke. Create a new key with the smallest role and channel list it needs. |
| **Service-account secret** (e.g. ARC LMS) | Revoke it in *Integrations*, create a new one, update the LMS. Existing access tokens expire within 15 minutes. |
| **Webhook signing secret** | Delete the webhook and create it again (new secret); update the receiver. |
| **A person's password** | Ask them to change it; an admin can remove them from *Team* immediately. |
| **`JWT_SECRET`** | Railway → Project Settings → Shared Variables → set a new random value (`openssl rand -hex 32`), redeploy `api`. Everyone is signed out; learner links and service tokens are invalidated. |
| **`INTERNAL_HOOK_TOKEN`** | New random value in Shared Variables, redeploy `api` and `emqx` together. |
| **`MQTT_SERVICE_PASSWORD`** | New value in Shared Variables, redeploy `api`, `worker` (and `emqx` if it caches auth). |
| **Broker TLS private key** | Re-run `infra/scripts/railway-cert-vars.sh` (new key; same CA, so devices keep working), paste the variables, redeploy `emqx`. If the **CA key** (`infra/certs/out/ca.key`) leaked: make a new CA and re-flash devices with the new `ca.crt`. |
| **Firmware signing private key** | *Firmware → Signing keys* → Revoke; generate a new key pair (`node tools/firmware-sign.mjs keygen`), re-sign current releases. Withdraw any release you didn't publish. |

Afterwards: review *Audit log* for actions taken with the leaked credential, check *Rejected data* for abuse, and record the incident (what leaked, when, what you rotated).
