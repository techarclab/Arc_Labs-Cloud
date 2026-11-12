#!/usr/bin/env node
// Turns Trivy JSON reports (security/out/*.json) into one Markdown table for the CI job summary and the evidence doc.
//   node tools/trivy-summary.mjs security/out
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'security/out';
const SEV = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const rows = [];
const details = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.cdx.json')).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const count = Object.fromEntries(SEV.map((s) => [s, 0]));
  let fixable = 0;
  let mis = 0;
  for (const res of r.Results ?? []) {
    for (const v of res.Vulnerabilities ?? []) {
      count[v.Severity] = (count[v.Severity] ?? 0) + 1;
      if (v.FixedVersion && (v.Severity === 'CRITICAL' || v.Severity === 'HIGH')) {
        fixable++;
        details.push(`| ${f.replace('.json', '')} | ${v.Severity} | ${v.VulnerabilityID} | ${v.PkgName} ${v.InstalledVersion} → ${v.FixedVersion} | ${res.Target} |`);
      }
    }
    for (const m of res.Misconfigurations ?? []) {
      if (m.Status === 'FAIL') {
        mis++;
        details.push(`| ${f.replace('.json', '')} | ${m.Severity} | ${m.ID} | ${m.Title} | ${res.Target} |`);
      }
    }
  }
  rows.push(`| ${f.replace('.json', '')} | ${SEV.map((s) => count[s]).join(' | ')} | ${fixable} | ${mis} |`);
}
console.log('| Scan | Critical | High | Medium | Low | Unknown | High+ with a fix | Misconfigurations |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
if (details.length) {
  console.log('\n| Scan | Severity | ID | Package / check | Where |\n|---|---|---|---|---|');
  for (const d of details.slice(0, 150)) console.log(d);
  if (details.length > 150) console.log(`\n…and ${details.length - 150} more (see the JSON reports in the artifact).`);
}
