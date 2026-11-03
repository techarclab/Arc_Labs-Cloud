import { readFileSync } from 'node:fs';
import { parse } from 'pg-connection-string';

/**
 * node-postgres settings for DATABASE_URL (use for every Pool and Client).
 *
 * With `passwordFile`, the password is read from that file for every new connection instead of from the URL.
 * Why: RDS rotates the master password every 7 days. On the AWS server the host keeps the file current
 * (deploy/aws/write-env.py --db-password-only, every minute), so new connections use the new password without a
 * restart; containers never need AWS credentials. Open connections are unaffected by a password change.
 *
 * The URL must then carry no password: node-postgres lets connection-string fields override explicit settings,
 * so a password in the URL (even an empty one) would silently replace the file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pgConnectionConfig(databaseUrl: string, passwordFile?: string): { [key: string]: any } {
  if (!passwordFile) return { connectionString: databaseUrl };
  const { password, ...rest } = parse(databaseUrl);
  if (password) throw new Error('DATABASE_URL must not contain a password when DATABASE_PASSWORD_FILE is set');
  return {
    ...rest,
    password: () => {
      const value = readFileSync(passwordFile, 'utf8').trim();
      if (!value) throw new Error(`database password file ${passwordFile} is empty`);
      return value;
    },
  };
}
