-- Phases 4–7: rules & alerts, notifications/webhooks outbox, API keys & service accounts,
-- ARC LMS links, commands with acknowledgement, firmware/OTA metadata, plans/quotas/retention.

-- ---------- Plans, quotas, retention (phase 6) ----------
ALTER TABLE organizations
  ADD COLUMN plan            text NOT NULL DEFAULT 'free',
  ADD COLUMN max_devices     int  NOT NULL DEFAULT 50,
  ADD COLUMN max_projects    int  NOT NULL DEFAULT 20,
  ADD COLUMN max_rules       int  NOT NULL DEFAULT 100,
  ADD COLUMN max_api_keys    int  NOT NULL DEFAULT 20,
  ADD COLUMN max_webhooks    int  NOT NULL DEFAULT 10,
  ADD COLUMN retention_days  int  NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650);

-- ---------- Rules & alerts (phase 4) ----------
CREATE TABLE alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES devices(id) ON DELETE CASCADE,   -- NULL = every device in the channel
  name             text NOT NULL,
  rule_type        text NOT NULL CHECK (rule_type IN ('threshold', 'stale', 'offline')),
  metric_key       text,
  operator         text CHECK (operator IN ('>', '>=', '<', '<=', '==', '!=')),
  threshold        double precision,
  for_seconds      int  NOT NULL DEFAULT 0 CHECK (for_seconds BETWEEN 0 AND 86400),
  stale_seconds    int  CHECK (stale_seconds BETWEEN 30 AND 604800),
  severity         text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  cooldown_seconds int  NOT NULL DEFAULT 300 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  notify_emails    text[] NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (rule_type <> 'threshold' OR (metric_key IS NOT NULL AND operator IS NOT NULL AND threshold IS NOT NULL)),
  CHECK (rule_type <> 'stale' OR stale_seconds IS NOT NULL)
);
CREATE INDEX ON alert_rules (project_id) WHERE enabled;
CREATE INDEX ON alert_rules (organization_id);

-- Pending breaches for rules with for_seconds > 0 (breach must persist before alerting).
CREATE TABLE alert_rule_state (
  rule_id       uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  breach_since  timestamptz NOT NULL,
  PRIMARY KEY (rule_id, device_id)
);

CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  rule_id          uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name        text NOT NULL,
  rule_type        text NOT NULL,
  severity         text NOT NULL,
  status           text NOT NULL DEFAULT 'triggered' CHECK (status IN ('triggered', 'acknowledged', 'resolved')),
  message          text NOT NULL,
  value            double precision,
  triggered_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution       text CHECK (resolution IN ('recovered', 'manual', 'rule_changed')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Deduplication: at most one active alert per rule and device.
CREATE UNIQUE INDEX alerts_one_active ON alerts (rule_id, device_id) WHERE status <> 'resolved';
CREATE INDEX ON alerts (organization_id, triggered_at DESC);
CREATE INDEX ON alerts (organization_id, status);
CREATE INDEX ON alerts (rule_id, device_id, resolved_at DESC);

CREATE TABLE alert_events (
  id          bigserial PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  event       text NOT NULL,              -- triggered | acknowledged | resolved | notified | note
  actor_type  text NOT NULL,              -- system | user | service
  actor_id    text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON alert_events (alert_id, created_at);

-- ---------- Webhooks + delivery outbox (phases 4–5) ----------
CREATE TABLE webhooks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  url              text NOT NULL,
  secret           text NOT NULL,          -- HMAC-SHA256 signing secret (shown once)
  events           text[] NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0
);
CREATE INDEX ON webhooks (organization_id) WHERE enabled;

CREATE TABLE deliveries (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('email', 'webhook')),
  webhook_id       uuid REFERENCES webhooks(id) ON DELETE CASCADE,
  alert_id         uuid REFERENCES alerts(id) ON DELETE CASCADE,
  recipient        text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts         int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  response_code    int,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ON deliveries (organization_id, created_at DESC);
CREATE INDEX ON deliveries (webhook_id, created_at DESC);
CREATE INDEX ON deliveries (alert_id);

-- Fan an event out to every enabled webhook of the organization that subscribed to it.
-- Called from the API and the worker in the same transaction as the change.
CREATE FUNCTION arc_emit_event(p_org uuid, p_type text, p_data jsonb) RETURNS int
LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO deliveries (organization_id, kind, webhook_id, recipient, event_type, payload)
    SELECT p_org, 'webhook', w.id, w.url, p_type,
           jsonb_build_object('id', gen_random_uuid(), 'type', p_type, 'organizationId', p_org,
                              'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', p_data)
    FROM webhooks w
    WHERE w.organization_id = p_org AND w.enabled AND (p_type = ANY (w.events) OR '*' = ANY (w.events))
    RETURNING 1
  )
  SELECT count(*)::int FROM ins;
$$;

-- ---------- API keys & service accounts (phase 5) ----------
CREATE TABLE api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('api_key', 'service_account')),
  prefix           text NOT NULL,                      -- first characters, shown in lists
  key_hash         text NOT NULL UNIQUE,               -- sha256 of the 256-bit secret
  role             text NOT NULL CHECK (role IN ('viewer', 'engineer')),
  project_ids      uuid[],                              -- NULL = all channels
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
CREATE INDEX ON api_keys (organization_id);

-- ---------- ARC LMS links (phase 5) ----------
CREATE TABLE lms_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lms_ref            text NOT NULL,                     -- LMS course/lab identifier
  title              text NOT NULL,
  device_ids         uuid[],                            -- NULL = every device in the channel
  max_token_minutes  int NOT NULL DEFAULT 240 CHECK (max_token_minutes BETWEEN 5 AND 1440),
  expires_at         timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  UNIQUE (organization_id, lms_ref)
);

-- ---------- Commands with acknowledgement (phase 7) ----------
CREATE TABLE command_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]{0,47}$'),
  description  text NOT NULL DEFAULT '',
  params       jsonb NOT NULL DEFAULT '[]',              -- [{key,type:number|boolean|string,min,max,required}]
  ttl_seconds  int NOT NULL DEFAULT 300 CHECK (ttl_seconds BETWEEN 10 AND 604800),
  min_role     text NOT NULL DEFAULT 'engineer' CHECK (min_role IN ('engineer', 'org_admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE commands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'published', 'acknowledged', 'failed', 'expired')),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_label  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  published_at     timestamptz,
  completed_at     timestamptz,
  result           jsonb,
  error            text
);
CREATE INDEX ON commands (device_id, created_at DESC);
CREATE INDEX commands_open ON commands (expires_at) WHERE status IN ('queued', 'published');

-- ---------- Firmware / OTA (phase 7) ----------
CREATE TABLE firmware_signing_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  public_key_pem   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE TABLE firmware_releases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_type      text NOT NULL,
  version          text NOT NULL,
  url              text NOT NULL,
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  signature        text NOT NULL,                      -- Ed25519 over the canonical manifest, base64
  signing_key_id   uuid NOT NULL REFERENCES firmware_signing_keys(id),
  notes            text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'released' CHECK (status IN ('released', 'withdrawn')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_type, version)
);

CREATE TABLE firmware_rollouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  release_id       uuid NOT NULL REFERENCES firmware_releases(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  percent          int NOT NULL CHECK (percent BETWEEN 1 AND 100),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE firmware_rollout_devices (
  rollout_id   uuid NOT NULL REFERENCES firmware_rollouts(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_id   uuid REFERENCES commands(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'succeeded', 'failed')),
  detail       text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, device_id)
);
