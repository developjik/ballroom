import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Loopback by name resolution is not available in every sandbox; the tests
  // talk to each other over 127.0.0.1 and the HTTP suite binds an ephemeral port.
  server: { host: '127.0.0.1' },
  test: {
    include: ['tests/**/*.test.ts'],
    api: { host: '127.0.0.1' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
