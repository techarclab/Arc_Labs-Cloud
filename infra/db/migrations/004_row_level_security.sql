-- Row-level security: a second, database-enforced layer of tenant isolation behind AccessService.
--
-- How it works
--   * `arc_tenant` is a NOLOGIN role that does not own any table, so RLS applies to it.
--   * For authenticated tenant requests the API switches to it inside each transaction
--     (set_config('role', 'arc_tenant', true)) and pins the caller's organizations in
--     `arc.org_ids` (also transaction-local, so nothing leaks between pooled connections).
--   * Every tenant table only shows/accepts rows whose organization is in that list. A query
--     that forgets `WHERE organization_id = …` returns nothing from other tenants instead of leaking.
--   * System paths (ingestion worker, broker hooks, device HTTP API lookups by key, sign-in,
--     platform admins, org creation) keep running as the owning role, which RLS does not restrict.
--     The application role must therefore NOT be granted BYPASSRLS for arc_tenant, and the
--     connection role must be allowed to SET ROLE arc_tenant (granted below).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    CREATE ROLE arc_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- The migrating/connecting role may switch into arc_tenant (no-op for superusers).
DO $$
BEGIN
  EXECUTE format('GRANT arc_tenant TO %I', current_user);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'GRANT arc_tenant TO % skipped: %', current_user, SQLERRM;
END $$;

GRANT USAGE ON SCHEMA public TO arc_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arc_tenant;
REVOKE ALL ON schema_migrations FROM arc_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arc_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arc_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO arc_tenant;

-- The caller's organizations for this transaction (NULL when unset → policies match nothing).
CREATE OR REPLACE FUNCTION arc_scope_orgs() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT string_to_array(nullif(current_setting('arc.org_ids', true), ''), ',')::uuid[]
$$;

-- Tables keyed by organization_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'alert_rules', 'alerts', 'api_keys', 'audit_logs', 'commands', 'deliveries', 'device_events', 'devices',
    'firmware_releases', 'firmware_rollouts', 'firmware_signing_keys', 'lms_links', 'organization_members',
    'projects', 'rejected_messages', 'webhooks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO arc_tenant USING (organization_id = ANY (arc_scope_orgs())) WITH CHECK (organization_id = ANY (arc_scope_orgs()))', t);
  END LOOP;
END $$;

-- Telemetry: plain/partitioned tables support RLS. A TimescaleDB hypertable is skipped with a notice
-- (the AWS target, RDS PostgreSQL, has no TimescaleDB; see docs/architecture/decisions.md).
DO $$
DECLARE is_hypertable boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry_measurements')$q$
      INTO is_hypertable;
  END IF;
  IF is_hypertable THEN
    RAISE NOTICE 'telemetry_measurements is a TimescaleDB hypertable: row-level security not enabled on it';
  ELSE
    ALTER TABLE telemetry_measurements ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON telemetry_measurements;
    CREATE POLICY tenant_isolation ON telemetry_measurements TO arc_tenant
      USING (organization_id = ANY (arc_scope_orgs())) WITH CHECK (organization_id = ANY (arc_scope_orgs()));
  END IF;
END $$;

-- Organizations themselves (creation runs as the owner, see OrganizationsController.create).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations TO arc_tenant
  USING (id = ANY (arc_scope_orgs())) WITH CHECK (id = ANY (arc_scope_orgs()));

-- Tables keyed by project.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['command_types', 'dashboards', 'metric_definitions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO arc_tenant
         USING (project_id IN (SELECT id FROM projects WHERE organization_id = ANY (arc_scope_orgs())))
         WITH CHECK (project_id IN (SELECT id FROM projects WHERE organization_id = ANY (arc_scope_orgs())))', t);
  END LOOP;
END $$;

-- Tables keyed by device.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_rule_state', 'control_values', 'device_credentials', 'firmware_rollout_devices', 'ingested_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO arc_tenant
         USING (device_id IN (SELECT id FROM devices WHERE organization_id = ANY (arc_scope_orgs())))
         WITH CHECK (device_id IN (SELECT id FROM devices WHERE organization_id = ANY (arc_scope_orgs())))', t);
  END LOOP;
END $$;

-- Alert history, keyed by alert.
ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON alert_events;
CREATE POLICY tenant_isolation ON alert_events TO arc_tenant
  USING (alert_id IN (SELECT id FROM alerts WHERE organization_id = ANY (arc_scope_orgs())))
  WITH CHECK (alert_id IN (SELECT id FROM alerts WHERE organization_id = ANY (arc_scope_orgs())));

-- `users` stays without RLS: it is the global identity table (sign-in, adding members by email).
