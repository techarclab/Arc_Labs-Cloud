SELECT string_agg(t || '=' || n, E'\n' ORDER BY t) FROM (
  SELECT 'organizations' AS t, (SELECT count(*) FROM organizations) AS n UNION ALL
  SELECT 'users', (SELECT count(*) FROM users) UNION ALL
  SELECT 'projects', (SELECT count(*) FROM projects) UNION ALL
  SELECT 'devices', (SELECT count(*) FROM devices) UNION ALL
  SELECT 'device_credentials', (SELECT count(*) FROM device_credentials) UNION ALL
  SELECT 'telemetry_measurements', (SELECT count(*) FROM telemetry_measurements) UNION ALL
  SELECT 'alert_rules', (SELECT count(*) FROM alert_rules) UNION ALL
  SELECT 'alerts', (SELECT count(*) FROM alerts) UNION ALL
  SELECT 'api_keys', (SELECT count(*) FROM api_keys) UNION ALL
  SELECT 'webhooks', (SELECT count(*) FROM webhooks) UNION ALL
  SELECT 'commands', (SELECT count(*) FROM commands) UNION ALL
  SELECT 'firmware_releases', (SELECT count(*) FROM firmware_releases) UNION ALL
  SELECT 'audit_logs', (SELECT count(*) FROM audit_logs) UNION ALL
  SELECT 'schema_migrations', (SELECT count(*) FROM schema_migrations)
) s;
