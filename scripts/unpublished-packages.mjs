/**
 * Lists the publishable packages whose current version is not on the registry.
 *
 * `changesets/action` picks between its two jobs by one question — are any
 * changesets pending? Yes refreshes the version pull request, no publishes.
 * A changeset landing on `main` while the version PR is open answers that
 * question "yes" for the very push that merges the PR, so the versions that
 * merge just committed are passed over and the run goes green having
 * published nothing. Nothing downstream says so: no tags are pushed, the
 * registry sits a version behind, and `main`'s CHANGELOG describes a release
 * nobody can install.
 *
 * So `release.yml` asks the registry rather than the action. Every
 * publishable package's version is checked against the versions the registry
 * holds, and each one missing is written to stdout as `name@version`, one per
 * line — empty stdout meaning the registry is level with `main`. Diagnostics
 * go to stderr, so a caller reads the list without filtering them out.
 *
 * A package the registry has never heard of counts as missing, which is what
 * a tenth package looks like before its first publish. Any other registry
 * error is fatal: an unreachable registry must not read as "everything needs
 * publishing".
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

const note = (msg) => process.stderr.write(`${msg}\n`);

/** Every version the registry holds for `name`, or `null` if it holds none. */
function registryVersions(name) {
  let stdout;
  try {
    stdout = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A package that has never published reports E404 — on stdout under
    // `--json`, on stderr without it, so both are worth reading.
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (output.includes('E404')) return null;
    note(output.trim());
    throw new Error(`could not read ${name} from the registry`, { cause: error });
  }
  const parsed = JSON.parse(stdout);
  // A package holding exactly one version comes back as a bare string.
  return Array.isArray(parsed) ? parsed : [parsed];
}

const missing = [];
for (const dir of readdirSync(packagesDir)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private) {
    note(`  skip (private)  ${manifest.name}`);
    continue;
  }

  const { name, version } = manifest;
  const versions = registryVersions(name);
  if (versions === null) {
    note(`  never published ${name}@${version}`);
    missing.push(`${name}@${version}`);
  } else if (!versions.includes(version)) {
    note(`  missing         ${name}@${version}`);
    missing.push(`${name}@${version}`);
  } else {
    note(`  published       ${name}@${version}`);
  }
}

note(
  missing.length === 0
    ? '\nThe registry is level with this checkout.'
    : `\n${missing.length} package(s) to publish.`,
);

if (missing.length > 0) process.stdout.write(`${missing.join('\n')}\n`);
