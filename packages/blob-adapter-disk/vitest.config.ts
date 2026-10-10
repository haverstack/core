import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/core/adapter': resolve(__dirname, '../core/src/adapter/index.ts'),
      '@haverstack/core': resolve(__dirname, '../core/src/index.ts'),
      '@haverstack/adapter-conformance': resolve(__dirname, '../adapter-conformance/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});
