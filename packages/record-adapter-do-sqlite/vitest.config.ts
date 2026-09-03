import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@haverstack/core/wire': resolve(__dirname, '../core/src/wire-entry.ts'),
      '@haverstack/core/adapter': resolve(__dirname, '../core/src/adapter-entry.ts'),
      '@haverstack/core': resolve(__dirname, '../core/src/index.ts'),
      '@haverstack/sqlite-shared/record': resolve(__dirname, '../sqlite-shared/src/record.ts'),
    },
  },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
