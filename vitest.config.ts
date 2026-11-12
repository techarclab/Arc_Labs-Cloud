import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // npm run test:coverage. Unit-test coverage only: the API and worker are mostly covered by the end-to-end
    // suite, whose coverage is measured separately (npm run test:e2e:coverage).
    coverage: {
      provider: 'v8',
      include: ['packages/shared/src/**', 'apps/api/src/**', 'apps/ingestion-worker/src/**', 'apps/console/src/arduinoSketch.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage/unit',
      // Floors for the pure business logic (device protocol, ACL, rules, sketch generator), set just under what the
      // tests reach on 2026-11-11. Raise them as tests are added; lower only on purpose. (db.ts is I/O, not here.)
      thresholds: {
        'packages/shared/src/{acl,connectivity,rules,telemetry,topics}.ts': { lines: 90, branches: 75, functions: 95 },
        'apps/console/src/arduinoSketch.ts': { lines: 95, branches: 80, functions: 95 },
      },
    },
  },
});
