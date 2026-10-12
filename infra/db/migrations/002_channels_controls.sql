-- ARC Cloud 002: ThingSpeak/Blynk-style channels.
--  * Fields: numbered (field1, field2…), either "data" (device → cloud) or "control" (cloud → device).
--  * Each channel has a read API key for feeds export.
--  * Each device credential also works as an HTTP API key (looked up by SHA-256; the secret is 256-bit random).
--  * Control values and dashboard layouts are stored per channel / device.

ALTER TABLE metric_definitions
  ADD COLUMN position  integer,
  ADD COLUMN kind      text NOT NULL DEFAULT 'data' CHECK (kind IN ('data', 'control')),
  ADD COLUMN decimals  integer NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 6),
  ADD COLUMN step      double precision;

-- Number existing fields in key order.
UPDATE metric_definitions m SET position = n.rn
FROM (SELECT project_id, metric_key, row_number() OVER (PARTITION BY project_id ORDER BY metric_key) AS rn FROM metric_definitions) n
WHERE m.project_id = n.project_id AND m.metric_key = n.metric_key;

ALTER TABLE metric_definitions ALTER COLUMN position SET NOT NULL;
ALTER TABLE metric_definitions ADD CONSTRAINT metric_definitions_position_range CHECK (position BETWEEN 1 AND 32);
CREATE UNIQUE INDEX metric_definitions_position ON metric_definitions (project_id, position);

ALTER TABLE projects ADD COLUMN read_api_key text;
UPDATE projects SET read_api_key = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)) WHERE read_api_key IS NULL;
ALTER TABLE projects ALTER COLUMN read_api_key SET NOT NULL;
CREATE UNIQUE INDEX projects_read_api_key ON projects (read_api_key);

ALTER TABLE device_credentials ADD COLUMN api_key_hash text;
CREATE UNIQUE INDEX device_credentials_api_key_hash ON device_credentials (api_key_hash) WHERE api_key_hash IS NOT NULL;

CREATE TABLE control_values (
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  field_key   text NOT NULL,
  value       double precision NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (device_id, field_key)
);

CREATE TABLE dashboards (
  project_id  uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  widgets     jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
