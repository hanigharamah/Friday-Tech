import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load test env into the vitest process so workers inherit the right DATABASE_URL
const parsed = config({ path: resolve(process.cwd(), '.env.test') }).parsed ?? {};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        env: parsed,
      },
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
