import { defineConfig } from 'tsup';

/**
 * Mirrors record-adapter-sqlite's tsup config: @haverstack/sqlite-shared is
 * internal (private, no stability promise, not published) and gets bundled
 * into this package's output rather than resolved from the registry.
 * @haverstack/core stays external — a real published peer, and inlining it
 * would give this package its own private copy of the error classes,
 * breaking `instanceof` against the caller's.
 *
 * target: 'es2022' rather than a Node target — this ships into a Workers
 * bundle (via wrangler/esbuild in the consuming app), not run standalone
 * under node.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['@haverstack/core', '@haverstack/core/adapter'],
  noExternal: ['@haverstack/sqlite-shared'],
});
