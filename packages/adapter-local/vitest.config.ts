import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/core': resolve(__dirname, '../core/src/index.ts'),
      '@haverstack/record-adapter-sqlite': resolve(
        __dirname,
        '../record-adapter-sqlite/src/index.ts',
      ),
      '@haverstack/sqlite-shared': resolve(__dirname, '../sqlite-shared/src/index.ts'),
      '@haverstack/blob-adapter-disk': resolve(__dirname, '../blob-adapter-disk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});
