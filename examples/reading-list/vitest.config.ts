import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const pkg = (path: string) => resolve(__dirname, '../../packages', path);

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/core/testing': pkg('core/src/testing.ts'),
      '@haverstack/core/adapter': pkg('core/src/adapter-entry.ts'),
      '@haverstack/core/wire': pkg('core/src/wire-entry.ts'),
      '@haverstack/core/did': pkg('core/src/did-entry.ts'),
      '@haverstack/core': pkg('core/src/index.ts'),
      '@haverstack/commons': pkg('commons/src/index.ts'),
      '@haverstack/adapter-local': pkg('adapter-local/src/index.ts'),
      '@haverstack/record-adapter-sqlite': pkg('record-adapter-sqlite/src/index.ts'),
      '@haverstack/sqlite-shared': pkg('sqlite-shared/src/index.ts'),
      '@haverstack/blob-adapter-disk': pkg('blob-adapter-disk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});
