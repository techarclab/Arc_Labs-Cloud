#!/usr/bin/env node
// Summarises ZAP JSON reports (security/zap/out/*.json) as Markdown and fails (exit 1) on any High-risk alert that is
// not listed in security/zap/accepted.tsv (id<TAB>reason). Medium and lower are reported, not gated.
//   node tools/zap-report.mjs security/zap/out
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'security/zap/out';
const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const accepted = new Map(
  existsSync('security/zap/accepted.tsv')
    ? readFileSync('security/zap/accepted.tsv', 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('\t'))
    : [],
);
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
      if (accepted.has(String(a.pluginid))) status = `accepted: ${accepted.get(String(a.pluginid))}`;
      else {
        status = '**blocking**';
        blocking++;
      }
    }
    console.log(`| ${risk} | ${a.name} | ${a.pluginid} | ${a.count ?? a.instances?.length ?? ''} | \`${ex}\` | ${status} |`);
  }
}
console.log(`\n${blocking ? `**${blocking} High-risk alert type(s) not accepted: failing.**` : 'No unaccepted High-risk alerts.'}`);
process.exit(blocking ? 1 : 0);
