/**
 * Pre-publish verification.
 *
 * Packs every publishable workspace package, installs the tarballs into a
 * throwaway project OUTSIDE the workspace, and imports each entry point.
 * This catches the two failure modes that a green `pnpm build` cannot:
 *
 *   1. A subpath `exports` map that resolves in the workspace but not from
 *      a published tarball (`files` missing an emitted entry, a stale path).
 *   2. A dependency that resolves via the pnpm workspace link but is not
 *      actually declared — most importantly @haverstack/sqlite-shared,
 *      which is private and must be bundled into record-adapter-sqlite
 *      rather than installed.
 *
 * Run before `pnpm run publish:all`. Exits non-zero on the first failure.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

/** Entry points to import, and a symbol each must export. */
const EXPECTATIONS = {
  '@haverstack/core': [
    ['.', ['Stack', 'ScopedStack', 'StackError', 'SYSTEM_TYPES']],
    ['/did', ['generateDidKeypair', 'verifyDidSignature', 'isValidDid']],
    [
      '/wire',
      ['buildAuthChallengePayload', 'verifyAuthChallenge', 'resolveAttachmentDownloadContentType'],
    ],
    ['/adapter', ['combineAdapters', 'assertQueryCapabilities']],
    ['/testing', ['MemoryAdapter']],
  ],
  '@haverstack/wire-types': [['.', ['serializeRecord', 'serializeError', 'WIRE_PROTOCOL_VERSION']]],
  '@haverstack/blob-adapter-disk': [['.', ['DiskBlobAdapter']]],
  '@haverstack/record-adapter-sqlite': [['.', ['NativeSQLiteRecordAdapter', 'NativeTokenStore']]],
  '@haverstack/adapter-local': [['.', ['LocalAdapter']]],
  '@haverstack/adapter-api': [['.', ['APIAdapter']]],
  '@haverstack/commons': [['.', ['NOTE', 'defineCommonsTypes']]],
  '@haverstack/conformance-fixtures': [['.', ['discoveryFixtures', 'allConformanceFixtures']]],
};

/** Packages that must NOT appear in the installed tree at all. */
const MUST_NOT_INSTALL = ['@haverstack/sqlite-shared'];

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`\n  FAIL  ${msg}\n`);
  process.exitCode = 1;
};

// -- collect publishable packages ------------------------------------------

const publishable = [];
for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private) {
    log(`  skip (private)  ${manifest.name}`);
    continue;
  }
  publishable.push({ dir, name: manifest.name, version: manifest.version });
}

log(`\nPacking ${publishable.length} publishable packages...`);

// -- pack ------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'haverstack-verify-'));
const tarballDir = join(work, 'tarballs');
mkdirSync(tarballDir);

const tarballs = {};
for (const pkg of publishable) {
  execFileSync('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', tarballDir], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const produced = readdirSync(tarballDir).find(
    (f) => f.endsWith('.tgz') && !Object.values(tarballs).some((t) => t.endsWith(f)),
  );
  if (!produced) {
    fail(`no tarball produced for ${pkg.name}`);
    continue;
  }
  tarballs[pkg.name] = join(tarballDir, produced);
  log(`  packed  ${pkg.name}@${pkg.version}`);
}

// -- install into a throwaway project outside the workspace ----------------

const consumer = join(work, 'consumer');
mkdirSync(consumer);

// `overrides` forces the internal @haverstack/* dependencies of each tarball
// to resolve to the sibling tarball rather than the public registry, which
// has no build of these versions yet.
const overrides = Object.fromEntries(
  Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
);

writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify(
    { name: 'verify-consumer', private: true, type: 'module', dependencies: overrides, overrides },
    null,
    2,
  ),
);

log('\nInstalling tarballs into a clean project outside the workspace...');
try {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: consumer,
    stdio: 'pipe',
  });
} catch (err) {
  fail(`npm install failed:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`);
  log(`\nLeft for inspection: ${work}`);
  process.exit(1);
}

// -- assert forbidden packages are absent ----------------------------------

log('\nChecking bundled-not-installed packages...');
for (const name of MUST_NOT_INSTALL) {
  const path = join(consumer, 'node_modules', ...name.split('/'));
  let present = true;
  try {
    readFileSync(join(path, 'package.json'));
  } catch {
    present = false;
  }
  if (present) fail(`${name} is private and must be bundled, but it was installed`);
  else log(`  absent (correct)  ${name}`);
}

// -- import every entry point ----------------------------------------------

log('\nImporting entry points...');
for (const [name, entries] of Object.entries(EXPECTATIONS)) {
  for (const [subpath, symbols] of entries) {
    const specifier = subpath === '.' ? name : `${name}${subpath}`;
    const probe = join(consumer, 'probe.mjs');
    writeFileSync(
      probe,
      `import * as m from ${JSON.stringify(specifier)};\n` +
        `const missing = ${JSON.stringify(symbols)}.filter((s) => !(s in m));\n` +
        `if (missing.length) { console.error('missing: ' + missing.join(', ')); process.exit(1); }\n`,
    );
    try {
      execFileSync(process.execPath, [probe], { cwd: consumer, stdio: 'pipe' });
      log(`  ok  ${specifier}`);
    } catch (err) {
      const out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim();
      fail(`${specifier} — ${out.split('\n')[0] || 'import threw'}`);
    }
  }
}

// -- report ----------------------------------------------------------------

if (process.exitCode) {
  log(`\nLeft for inspection: ${work}`);
  log('\nVerification FAILED — do not publish.\n');
} else {
  rmSync(work, { recursive: true, force: true });
  log('\nAll entry points resolve from packed tarballs. Safe to publish.\n');
}
