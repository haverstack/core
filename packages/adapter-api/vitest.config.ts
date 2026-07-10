import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/core': resolve(__dirname, '../core/src/index.ts'),
      '@haverstack/wire-types': resolve(__dirname, '../wire-types/src/index.ts'),
      '@haverstack/conformance-fixtures': resolve(
        __dirname,
        '../conformance-fixtures/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'node',
  },
});
