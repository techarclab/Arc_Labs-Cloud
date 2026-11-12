#!/usr/bin/env node
// Prints the unit and end-to-end coverage totals as a Markdown table (for the CI job summary and the evidence docs).
import { existsSync, readFileSync } from 'node:fs';

const rows = [
  ['Unit tests (whole backend measured; floors only on the pure-logic files)', 'coverage/unit/coverage-summary.json'],
  ['End-to-end suite (API + worker + shared)', 'coverage/e2e/coverage-summary.json'],
];
console.log('| Suite | Lines | Branches | Functions |\n|---|---|---|---|');
for (const [name, file] of rows) {
  if (!existsSync(file)) continue;
  const t = JSON.parse(readFileSync(file, 'utf8')).total;
  console.log(`| ${name} | ${t.lines.pct}% | ${t.branches.pct}% | ${t.functions.pct}% |`);
}
