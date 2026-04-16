import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        global: {
          lines: 60,
          functions: 60,
          branches: 60,
          statements: 60
        },
        'src/regiondo/auth.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90
        },
        'src/sync/repository.ts': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80
        }
      }
    }
  }
});
