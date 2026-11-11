#!/usr/bin/env node
// Summarises ZAP JSON reports (security/zap/out/*.json) as Markdown and fails (exit 1) on any High-risk alert instance
// that is not accepted in security/zap/accepted.tsv: <pluginid> TAB <regex on "METHOD url"> TAB <reason, who, date>.
// Acceptance is per rule AND per route, so accepting a false positive never hides the same rule elsewhere.
// Medium and lower are reported, not gated. High-risk instances are printed with ZAP's attack and evidence.
//   node tools/zap-report.mjs security/zap/out
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'security/zap/out';
const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const accepted = (existsSync('security/zap/accepted.tsv') ? readFileSync('security/zap/accepted.tsv', 'utf8') : '')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [id, pattern, reason] = l.split('\t');
    return { id, re: new RegExp(pattern), reason };
  });
const acceptance = (pluginid, inst) => accepted.find((a) => a.id === String(pluginid) && a.re.test(`${inst.method} ${inst.uri}`));
const highs = [];
let blocking = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const alerts = (r.site ?? []).flatMap((s) => (s.alerts ?? []).map((a) => ({ ...a, site: s['@name'] })));
  alerts.sort((a, b) => Number(b.riskcode) - Number(a.riskcode));
  console.log(`\n#### ${f.replace('.json', '')}: ${alerts.length} alert types\n`);
  if (!alerts.length) continue;
  console.log('| Risk | Alert | Rule | Instances | Example | Status |\n|---|---|---|---|---|---|');
  for (const a of alerts) {
    const risk = RISK[a.riskcode] ?? a.riskcode;
    const ex = a.instances?.[0] ? `${a.instances[0].method} ${a.instances[0].uri}`.slice(0, 90) : '';
    let status = '';
    if (Number(a.riskcode) >= 3) {
      const open = (a.instances ?? []).filter((i) => !acceptance(a.pluginid, i));
      blocking += open.length;
      status = open.length ? `**blocking** (${open.length})` : `accepted: ${acceptance(a.pluginid, a.instances[0]).reason}`;
      for (const i of a.instances ?? []) highs.push({ a, i, ok: !!acceptance(a.pluginid, i) });
    }
    console.log(`| ${risk} | ${a.name} | ${a.pluginid} | ${a.count ?? a.instances?.length ?? ''} | \`${ex}\` | ${status} |`);
  }
}
if (highs.length) {
  console.log('\n#### High-risk instances: what ZAP sent and saw\n');
  for (const { a, i, ok } of highs) {
    console.log(`- ${ok ? 'accepted' : '**blocking**'}: ${a.name} (${a.pluginid}) on \`${i.method} ${i.uri}\``);
    for (const k of ['param', 'attack', 'evidence', 'otherinfo']) if (i[k]) console.log(`  - ${k}: \`${String(i[k]).replace(/\s+/g, ' ').slice(0, 300)}\``);
  }
}
console.log(`\n${blocking ? `**${blocking} High-risk alert instance(s) not accepted: failing.**` : 'No unaccepted High-risk alerts.'}`);
process.exit(blocking ? 1 : 0);
