#!/usr/bin/env node
// Verifies that every runtime dependency of the given workspaces resolves the way Node will resolve it
// at startup (workspace node_modules first, then each parent node_modules). Run inside the final Docker
// image: a dependency that npm nested under a workspace and the Dockerfile did not copy fails the build.
//   node tools/check-runtime-deps.cjs apps/api apps/ingestion-worker ...
'use strict';
const fs = require('fs');
const path = require('path');

let missing = 0;
for (const ws of process.argv.slice(2)) {
  const dir = path.resolve(ws);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    let found = false;
    for (let d = dir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'node_modules', dep, 'package.json'))) { found = true; break; }
      if (path.dirname(d) === d) break;
    }
    if (!found) { console.error(`missing runtime dependency: ${ws} -> ${dep}`); missing++; }
  }
}
if (missing) process.exit(1);
console.log('runtime dependencies present');
