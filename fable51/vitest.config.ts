import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // slow ELK experiments, run explicitly with `npx vitest run test/perf.test.ts`
    exclude: process.env.ALL_TESTS ? ['node_modules/**'] : ['test/perf.test.ts', 'test/probe.test.ts', 'node_modules/**'],
  },
});
