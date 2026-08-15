import { defineConfig } from 'tsup';

/**
 * @haverstack/sqlite-shared is bundled into this package's output rather
 * than shipped as a dependency. It is an internal package — it carries no
 * API stability promise and is not published — so a consumer installing
 * this adapter from the registry must not need to resolve it.
 *
 * @haverstack/core stays external: it is a real published peer, and
 * inlining it would give this package its own private copy of the error
 * classes, breaking `instanceof` against the caller's copy.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['@haverstack/core', '@haverstack/core/adapter'],
  noExternal: ['@haverstack/sqlite-shared'],
});
