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
 *
 * `dts.resolve` is the type-level half of `noExternal`: without it the
 * emitted .d.ts keeps `import ... from '@haverstack/sqlite-shared'` for
 * every shared type that surfaces in this package's public API, naming a
 * package the consumer will never have installed. Inlining those
 * declarations is what makes the bundled JS and the shipped types agree.
 * The `paths` entry beside it points that resolution at sqlite-shared's
 * source rather than its emitted `dist/*.d.ts`, whose relative `.js`
 * re-exports the declaration bundler does not follow — resolve alone
 * leaves a dangling `./record.js` import behind.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: {
    resolve: [/^@haverstack\/sqlite-shared/],
    compilerOptions: {
      paths: { '@haverstack/sqlite-shared': ['../sqlite-shared/src/index.ts'] },
    },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['@haverstack/core', '@haverstack/core/adapter'],
  noExternal: ['@haverstack/sqlite-shared'],
});
