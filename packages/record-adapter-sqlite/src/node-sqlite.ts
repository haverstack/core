/**
 * Loads node:sqlite via process.getBuiltinModule() rather than a static
 * `import ... from 'node:sqlite'`. node:sqlite is new enough that some
 * bundler/test-runner toolchains (Vite/Vitest as of this writing —
 * https://github.com/vitest-dev/vitest/issues/7177) mis-resolve it,
 * stripping the "node:" prefix and trying to load a package literally
 * named "sqlite". process.getBuiltinModule() is the Node-sanctioned way
 * to reach a builtin module without going through import resolution at
 * all, so it's immune to that class of bug — useful here since a
 * consuming app's own toolchain could hit the same issue, not just ours.
 */
export const { DatabaseSync } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');

export type DatabaseSync = InstanceType<typeof DatabaseSync>;
