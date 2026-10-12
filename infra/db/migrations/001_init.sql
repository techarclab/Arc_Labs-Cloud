-- ARC Cloud initial schema (V1: identity, registry, provisioning, telemetry, audit)
-- Works on plain PostgreSQL 16; uses TimescaleDB hypertables + retention when the extension is available.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb not available, telemetry uses a plain table';
END $$;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Identity & tenancy ----------
CREATE TABLE organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_id      text NOT NULL DEFAULT 'free',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  display_name        text NOT NULL,
  password_hash       text,               -- null when an external OIDC provider is used
  identity_provider_id text UNIQUE,
  is_platform_admin   boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('org_admin', 'engineer', 'viewer')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX ON organization_members (user_id);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description     text NOT NULL DEFAULT '',
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX ON projects (organization_id);

CREATE TABLE metric_definitions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_key text NOT NULL CHECK (metric_key ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  label      text NOT NULL,
  data_type  text NOT NULL DEFAULT 'number' CHECK (data_type IN ('number')),
  unit       text NOT NULL DEFAULT '',
  min_value  double precision,
  max_value  double precision,
  PRIMARY KEY (project_id, metric_key)
);

-- ---------- Device registry & provisioning ----------
CREATE TABLE devices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id               uuid NOT NULL,
  display_name             text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  device_type              text NOT NULL DEFAULT 'generic',
  model                    text NOT NULL DEFAULT '',
  firmware_version         text,
  tags                     text[] NOT NULL DEFAULT '{}',
  metadata                 jsonb NOT NULL DEFAULT '{}',
  lifecycle_status         text NOT NULL DEFAULT 'provisioned'
                           CHECK (lifecycle_status IN ('created', 'pending_claim', 'provisioned', 'active',
                                                       'maintenance', 'suspended', 'revoked', 'retired')),
  expected_interval_seconds integer NOT NULL DEFAULT 60 CHECK (expected_interval_seconds BETWEEN 1 AND 86400),
  reported_state           jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz,
  last_connected_at        timestamptz,
  last_disconnected_at     timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX ON devices (organization_id, project_id);
CREATE INDEX ON devices USING gin (tags);

CREATE TABLE device_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  secret_hash text NOT NULL,             -- scrypt hash; plaintext is shown once at issue time
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX device_credentials_one_active ON device_credentials (device_id) WHERE status = 'active';

CREATE TABLE device_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  event_time      timestamptz NOT NULL DEFAULT now(),
  details         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON device_events (device_id, event_time DESC);

-- ---------- Telemetry ----------
CREATE TABLE telemetry_measurements (
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  device_id       uuid NOT NULL,
  metric_key      text NOT NULL,
  metric_value    double precision NOT NULL,
  ts              timestamptz NOT NULL,          -- device timestamp, or received time if missing
  received_at     timestamptz NOT NULL,
  message_id      text NOT NULL
);
CREATE INDEX ON telemetry_measurements (device_id, metric_key, ts DESC);
CREATE INDEX ON telemetry_measurements (organization_id, project_id, ts DESC);

-- Idempotency: one row per (device, messageId). Kept separately because hypertable
-- unique constraints must include the time column. The ingestion worker prunes rows
-- older than the dedupe window (default 7 days, matching the max message age).
CREATE TABLE ingested_messages (
  device_id   uuid NOT NULL,
  message_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, message_id)
);
CREATE INDEX ON ingested_messages (received_at);

CREATE TABLE rejected_messages (
  id              bigserial PRIMARY KEY,
  organization_id uuid,
  device_id       uuid,
  topic           text NOT NULL,
  reason          text NOT NULL,
  detail          text NOT NULL DEFAULT '',
  payload_excerpt text NOT NULL DEFAULT '',
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rejected_messages (organization_id, received_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('telemetry_measurements', 'ts', chunk_time_interval => interval '1 day');
    PERFORM add_retention_policy('telemetry_measurements', interval '90 days');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hypertable setup skipped: %', SQLERRM;
END $$;

-- ---------- Audit ----------
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'device', 'service', 'system')),
  actor_id        text,
  organization_id uuid,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (organization_id, created_at DESC);
