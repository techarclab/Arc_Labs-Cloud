# Architecture decisions (V1)

Short records of the choices made while building the MVP backbone. Each one can be revisited when the "revisit when" condition is met.

**1. EMQX (open-source 5.8.x) as the broker, with HTTP auth/ACL hooks into the API.**
Per-device identity and topic ACLs stay in our database instead of being duplicated into broker config, and a revoked device is refused on its next connect. 5.8.x is the last Apache-2.0 line; later EMQX releases changed licensing, so review terms before upgrading. *Revisit when:* auth hook latency or load becomes a bottleneck (then cache in Redis or move to EMQX's built-in PostgreSQL authenticator), or if AWS IoT Core becomes preferred (see AWS doc).

**2. Username/password per device over TLS (not client certificates) for V1.**
Easiest path for ESP32/ESP8266 and student projects, rotation is one API call, and the secret is stored only as an scrypt hash. *Revisit when:* industrial customers require mutual TLS; the hooks can switch to `${cert_common_name}` with an ACM Private CA.

**3. One modular API service plus one ingestion worker.**
The plan says split services only when scale or team size justifies it. The API and worker share `packages/shared` so topic, payload and ACL rules can never drift.

**4. PostgreSQL for everything, TimescaleDB when available.**
The migration creates a hypertable with 90-day retention if the extension exists and falls back to a plain indexed table otherwise; queries use `date_bin`, which works on both. *Revisit when:* sustained ingest passes roughly a few thousand measurements per second or retention needs grow — then evaluate continuous aggregates or a dedicated time-series store.

**5. At-least-once ingestion with idempotent writes.**
The worker acks a QoS 1 message only after it is stored (or deliberately rejected). If the database fails it withholds the ack and reconnects so the broker redelivers. `(deviceId, messageId)` in `ingested_messages` makes repeats harmless. *Revisit when:* throughput needs batching; add a durable queue (e.g. Kafka/Kinesis via EMQX data bridge) between broker and worker.

**6. Tenant scope is resolved server-side on every request.**
Controllers never trust an organization ID from the client for authorization: they load the resource, read its `organization_id`, and check membership. Non-members get 404. Telemetry queries always include `organization_id` in the predicate.

**7. Email/password plus Google Identity Services for console sign-in.**
Google ID tokens are verified by the API against the configured Web client ID, then mapped to `users.identity_provider_id`; the rest of the API continues to use ARC Cloud JWTs and only reads the JWT `sub`.

## Known gaps (tracked for later phases)

- Claim codes (`POST /devices/{id}/claim-codes`) are not built; devices are provisioned directly by an engineer.
- Revocation does not yet kick a live session through the EMQX management API (bounded by the 30 s authz cache).
- No email invitations (members must register first), no API keys/webhooks, no rules/alerts, no console UI.
- Rate limiting in the worker is per instance; with several workers use EMQX listener limits as well.
