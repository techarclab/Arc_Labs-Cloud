#!/usr/bin/env node
/**
 * The ArcCloud library must accept exactly the field names ARC Cloud accepts (METRIC_KEY in packages/shared),
 * limited to the 32 characters the library stores. A name the library accepts but the server rejects compiles,
 * runs, and then every reading is refused as metric_not_allowed / schema_invalid: the board looks offline.
 *
 *   node tests/firmware/field-names.mjs        (needs g++)
 *
 * Compiles firmware/arduino-library/ArcCloud/src/ArcCloudFieldName.h on this machine and compares it, name by name,
 * with the server's regular expression.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
// The server's rule, read from its source so this test follows any change to it.
const src0 = readFileSync(join(ROOT, 'packages/shared/src/telemetry.ts'), 'utf8');
const m = /export const METRIC_KEY = \/(.+)\/;/.exec(src0);
if (!m) throw new Error('METRIC_KEY not found in packages/shared/src/telemetry.ts');
const METRIC_KEY = new RegExp(m[1]);
const LIB_MAX = 32;

const tmp = mkdtempSync(join(tmpdir(), 'arc-fields-'));
const src = join(tmp, 'check.cpp');
const bin = join(tmp, 'check');
writeFileSync(
  src,
  `#include <cstdio>
#include <string>
#include <iostream>
#include "ArcCloudFieldName.h"
int main() {
  std::string line;
  while (std::getline(std::cin, line)) std::printf("%d\\n", arcValidFieldName(line.c_str()) ? 1 : 0);
  std::printf("null:%d\\n", arcValidFieldName(nullptr) ? 1 : 0);
}
`,
);
execFileSync('g++', ['-std=c++17', '-Wall', '-Werror', '-I', join(ROOT, 'firmware/arduino-library/ArcCloud/src'), src, '-o', bin], { stdio: 'inherit' });

const cases = [
  // accepted by the server
  'temperature', 'led1', 'T', 'humidity_pct', 'rssi', 'fieldName2', 'A_b_C_1', 'x'.repeat(32),
  // rejected by the server
  '', '1st', '_hidden', 'temp-c', 'temp.c', 'temp c', 'température', 'led1\t', 'a/b', 'a+b', '-x', '.x',
  // accepted by the server but longer than the library stores
  'x'.repeat(33), 'y'.repeat(64),
];
// Plus every printable ASCII character alone and after a letter.
for (let c = 32; c < 127; c++) cases.push(String.fromCharCode(c), `a${String.fromCharCode(c)}`);

const out = execFileSync(bin, { input: cases.join('\n') + '\n', encoding: 'utf8' }).trim().split('\n');
const nullLine = out.pop();
let failures = 0;
const mismatches = [];
cases.forEach((name, i) => {
  const expected = METRIC_KEY.test(name) && name.length <= LIB_MAX;
  const got = out[i] === '1';
  if (got !== expected) mismatches.push(`${JSON.stringify(name)}: library ${got ? 'accepts' : 'rejects'}, should ${expected ? 'accept' : 'reject'}`);
});
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
};
check(`library field names match the server rule ${METRIC_KEY} (max ${LIB_MAX} characters), ${cases.length} cases`, () =>
  assert.deepEqual(mismatches, []),
);
check('a null name is rejected', () => assert.equal(nullLine, 'null:0'));
process.exit(failures ? 1 : 0);
