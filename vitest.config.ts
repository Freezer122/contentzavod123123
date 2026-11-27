import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/._*'],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
