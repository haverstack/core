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
 *
 * dts.compilerOptions.types is scoped to *this* isolated dts compilation
 * only, not the package's shared tsconfig.json (which drives `tsc
 * --noEmit` over src/** and tests/** together). src/executor.ts uses the
 * ambient DurableObjectStorage/SqlStorage/SqlStorageValue globals with no
 * import, so this build step — which follows the entry's module graph,
 * not tsconfig's "include" — needs @cloudflare/workers-types to resolve
 * them; the test tsconfig gets the same globals for free from wrangler's
 * generated worker-configuration.d.ts, and adding workers-types there too
 * conflicts with it over the ambient Env/Cloudflare.Env declaration (the
 * exact clash wrangler's own "uninstall @cloudflare/workers-types"
 * migration note warns about) without ever being needed.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: { compilerOptions: { types: ['@cloudflare/workers-types'] } },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['@haverstack/core', '@haverstack/core/adapter'],
  noExternal: ['@haverstack/sqlite-shared'],
});
