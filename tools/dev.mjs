#!/usr/bin/env node
/**
 * Local helper so you don't have to paste long curl commands.
 *
 *   node tools/dev.mjs setup    create (or log in to) your account, an organization, a project
 *                               and a test device; saves the device credentials to device.json
 *   node tools/dev.mjs status   show the device's connection status and latest readings
 *   node tools/dev.mjs device   register another device (saved as device-2.json, device-3.json, ...)
 *
 * Needs the stack running (docker compose up -d) and Node 22+. No npm install required.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const API = process.env.ARC_API ?? 'http://localhost:3000/api/v1';
const SESSION_FILE = '.arc-session.json';
const ORG = { name: 'ARC LABS', slug: 'arc-labs' };
const PROJECT_NAME = 'Test Project';

// Line-queue prompt: works both in a real terminal and when Git Bash/mintty hands Node a non-TTY stdin.
const rl = createInterface({ input: stdin, terminal: false });
const queued = [];
const waiting = [];
let inputClosed = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queued.push(l)));
rl.on('close', () => {
  inputClosed = true;
  while (waiting.length) waiting.shift()('');
});
function ask(prompt) {
  stdout.write(prompt);
  if (queued.length) return Promise.resolve(queued.shift()).then((v) => (stdin.isTTY ? v : (stdout.write('\n'), v)));
  if (inputClosed) return Promise.resolve('').then((v) => (stdout.write('\n'), v));
  return new Promise((r) => waiting.push(r));
}
const say = (msg = '') => console.log(msg);
// Throw instead of process.exit(): exiting while stdin is open trips a libuv assertion on Windows.
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

async function call(method, path, token, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`Cannot reach the API at ${API}.\n  Is Docker running? Try: docker compose ps`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function loadSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function login({ allowRegister }) {
  const saved = loadSession();
  if (saved?.token) {
    const me = await call('GET', '/auth/me', saved.token);
    if (me.status === 200) return saved;
  }

  const email = (await ask(`Email${saved?.email ? ` [${saved.email}]` : ''}: `)).trim() || saved?.email;
  if (!email) fail('An email is required.');
  const password = await ask('Password (at least 12 characters): ');
  if (!password) fail('A password is required.');

  let res = await call('POST', '/auth/login', undefined, { email, password });
  if (res.status === 401 && allowRegister) {
    say('Could not sign in with that email and password — creating a new account...');
    let newPassword = password;
    for (let tries = 0; newPassword.length < 12; tries++) {
      if (tries >= 3) fail('A new account needs a password of at least 12 characters.');
      newPassword = await ask(`That password is ${newPassword.length} characters. Choose one with at least 12: `);
    }
    const name = (await ask('Your name: ')).trim() || email.split('@')[0];
    res = await call('POST', '/auth/register', undefined, { email, displayName: name, password: newPassword });
    if (res.status === 409) fail('That email is already registered with a different password.');
  }
  if (res.status >= 400) fail(`Login failed: ${JSON.stringify(res.data)}`);

  const session = { email, token: res.data.accessToken };
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  say(`✓ Signed in as ${email}`);
  return session;
}

async function ensureOrgAndProject(token) {
  const orgs = await call('GET', '/organizations', token);
  let org = orgs.data.items.find((o) => o.slug === ORG.slug) ?? orgs.data.items[0];
  if (!org) {
    let r = await call('POST', '/organizations', token, ORG);
    if (r.status === 409) r = await call('POST', '/organizations', token, { ...ORG, slug: `${ORG.slug}-${Math.random().toString(36).slice(2, 6)}` });
    if (r.status >= 400) fail(`Could not create organization: ${JSON.stringify(r.data)}`);
    org = r.data;
    say(`✓ Created organization "${org.name}"`);
  } else say(`✓ Using organization "${org.name}"`);

  const projects = await call('GET', `/projects?organizationId=${org.id}`, token);
  let project = projects.data.items.find((p) => p.name === PROJECT_NAME) ?? projects.data.items[0];
  if (!project) {
    const r = await call('POST', '/projects', token, { organizationId: org.id, name: PROJECT_NAME });
    if (r.status >= 400) fail(`Could not create project: ${JSON.stringify(r.data)}`);
    project = r.data;
    say(`✓ Created project "${project.name}"`);
  } else say(`✓ Using project "${project.name}"`);
  return { org, project };
}

async function createDevice(token, project, file, name) {
  const r = await call('POST', '/devices', token, {
    projectId: project.id,
    displayName: name,
    deviceType: 'simulator',
    expectedIntervalSeconds: 5,
  });
  if (r.status >= 400) fail(`Could not create device: ${JSON.stringify(r.data)}`);
  writeFileSync(file, JSON.stringify(r.data, null, 2));
  say(`✓ Registered device "${name}" → saved to ${file}`);
  say('  (this file contains the device password — it is only shown once, keep it)');
  return r.data;
}

function nextDeviceFile() {
  if (!existsSync('device.json')) return 'device.json';
  for (let i = 2; ; i++) if (!existsSync(`device-${i}.json`)) return `device-${i}.json`;
}

async function setup() {
  say('ARC Cloud local setup\n');
  const { token } = await login({ allowRegister: true });
  const { project } = await ensureOrgAndProject(token);
  if (existsSync('device.json')) {
    say('✓ device.json already exists — keeping it (use "node tools/dev.mjs device" to add another)');
  } else {
    await createDevice(token, project, 'device.json', 'Simulator 1');
  }
  say('\nNext — start the pretend device:');
  say('  npm install            (first time only)');
  say('  npm run simulate -- --creds device.json --ca infra/certs/out/ca.crt --interval 5');
  say('\nThen, in a second Git Bash window:');
  say('  cd /c/arc-cloud');
  say('  node tools/dev.mjs status');
  say('\nOr open the web console: http://localhost:3002\n');
}

async function addDevice() {
  const { token } = await login({ allowRegister: false });
  const { project } = await ensureOrgAndProject(token);
  const file = nextDeviceFile();
  await createDevice(token, project, file, `Device ${file.replace(/\D/g, '') || 1}`);
}

async function status() {
  const files = ['device.json', ...Array.from({ length: 20 }, (_, i) => `device-${i + 2}.json`)].filter(existsSync);
  if (!files.length) fail('No device.json found. Run: node tools/dev.mjs setup');
  const { token } = await login({ allowRegister: false });

  for (const file of files) {
    const id = JSON.parse(readFileSync(file, 'utf8')).device?.id;
    if (!id) continue;
    const s = await call('GET', `/devices/${id}/state`, token);
    if (s.status !== 200) {
      say(`\n${file}: ${JSON.stringify(s.data)}`);
      continue;
    }
    const d = await call('GET', `/devices/${id}`, token);
    const latest = await call('GET', `/devices/${id}/telemetry/latest`, token);
    const icon = { online: '[ONLINE] ', offline: '[OFFLINE]', unknown: '[NEW]    ' }[s.data.connectivity.status] ?? '';
    say(`\n${icon} ${d.data.displayName}  (${file})`);
    say(`   status:     ${s.data.connectivity.status}   lifecycle: ${d.data.lifecycleStatus}`);
    say(`   last seen:  ${s.data.lastSeenAt ? new Date(s.data.lastSeenAt).toLocaleString() : 'never'}`);
    if (latest.data.items.length) {
      say('   latest readings:');
      for (const m of latest.data.items) say(`     ${m.metric.padEnd(14)} ${m.value}   (${new Date(m.ts).toLocaleTimeString()})`);
    } else {
      say('   no readings yet — is the simulator running?');
    }
  }

  const orgs = await call('GET', '/organizations', token);
  for (const o of orgs.data.items) {
    const rej = await call('GET', `/organizations/${o.id}/rejected-messages?limit=3`, token);
    if (rej.status === 200 && rej.data.items.length) {
      say(`\nRecently rejected messages in ${o.name}:`);
      for (const r of rej.data.items) say(`   ${new Date(r.received_at).toLocaleTimeString()}  ${r.reason}: ${r.detail}`);
    }
  }
  say('');
}

const cmd = process.argv[2];
try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'status') await status();
  else if (cmd === 'device') await addDevice();
  else {
    say('Usage:');
    say('  node tools/dev.mjs setup    first-time setup (account, org, project, device.json)');
    say('  node tools/dev.mjs status   show device status and latest readings');
    say('  node tools/dev.mjs device   register another device');
  }
} catch (err) {
  console.error(`\n✗ ${err instanceof Fail ? err.message : err?.stack ?? err}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
  stdin.pause();
}
