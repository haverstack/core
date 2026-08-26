import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/wire-types': resolve(__dirname, '../wire-types/src/index.ts'),
      '@haverstack/core/adapter': resolve(__dirname, '../core/src/adapter-entry.ts'),
      '@haverstack/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});
