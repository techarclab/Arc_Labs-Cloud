/* Applies infra/db/migrations/*.sql in order, once each, inside a transaction per file. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

function migrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(__dirname, '../../../../infra/db/migrations'),
    resolve(process.cwd(), 'infra/db/migrations'),
    '/app/infra/db/migrations',
  ].filter(Boolean) as string[];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
  return dir;
}

export async function migrate(databaseUrl: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log('migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
