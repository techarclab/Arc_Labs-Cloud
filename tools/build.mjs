// Root build. On Vercel (which only hosts the web console) build just the console;
// everywhere else build the backend packages (shared, api, worker).
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) => {
  console.log(`> npm ${args.join(' ')}`);
  const r = spawnSync(npm, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
  return r.status === 0;
};

if (process.env.VERCEL) {
  console.log('Vercel detected: building the web console only (apps/console).');
  run(['run', 'build', '-w', '@arc/console']);
} else {
  run(['run', 'build', '-w', '@arc/shared']) &&
    run(['run', 'build', '-w', '@arc/api', '-w', '@arc/ingestion-worker']);
}
