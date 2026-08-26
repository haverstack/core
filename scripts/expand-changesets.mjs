/**
 * Fixes up the pending changesets so `changeset version` does the right thing.
 *
 * Two passes, both run by `pnpm run version:packages` before `changeset
 * version` consumes anything, so neither ever lands in a commit.
 *
 * ## Drop packages that cannot be released
 *
 * `@haverstack/sqlite-shared` is private, and Changesets refuses outright — not
 * skips — a changeset naming both a private package and a public one. That
 * template is exactly what changeset-bot's "add a changeset" link pre-fills,
 * so the failure is one unedited commit away, and it surfaces at version time
 * rather than on the pull request that caused it. A changeset naming _only_
 * private packages is a different mistake and still fails, loudly and here:
 * the change would otherwise release nowhere at all.
 *
 * ## Propagate breaking workspace bumps to dependents
 *
 * Changesets moves a dependent only when the dependency's new version falls
 * outside the range the dependent declares, and when it does move one it always
 * moves it by a patch. With `workspace:^` ranges on `0.x` packages that gives
 * the right answer for a patch — `^0.11.1` accepts `0.11.2`, so nothing else is
 * republished — and the wrong one for a minor: `^0.11.1` rejects `0.12.0`, so
 * every dependent must be republished against the new core, and a release that
 * carries a breaking change through is breaking in turn.
 *
 * The induced releases are written as one more changeset, so a contributor
 * writes a changeset for the package they actually touched and nothing else.
 *
 * "Breaking" is read off each package's own version rather than hardcoded to
 * `minor`, because the slot semver reserves for it moves at 1.0: while a
 * package is `0.x` a minor is breaking, and afterwards only a major is.
 *
 * Run with `--dry-run` to print the plan without writing anything.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangesetFile } from '@changesets/parse';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
const changesetDir = join(repoRoot, '.changeset');
const generatedFilePrefix = 'dependents-of-';

const dryRun = process.argv.includes('--dry-run');

/** Ordered so that a larger bump compares greater. */
const BUMP_LEVEL = { none: 0, patch: 1, minor: 2, major: 3 };

/** Ranges that carry a breaking change through to the dependent's consumers. */
const RUNTIME_DEPENDENCIES = ['dependencies', 'peerDependencies'];

/** The bump slot semver reserves for breaking changes at this version. */
function breakingBump(version) {
  return Number(version.split('.')[0]) === 0 ? 'minor' : 'major';
}

/** `@haverstack/core` -> `core`, for readable generated filenames. */
function unscoped(name) {
  return name.split('/').pop();
}

function isAtLeast(bump, floor) {
  return BUMP_LEVEL[bump ?? 'none'] >= BUMP_LEVEL[floor];
}

// -- workspace graph --------------------------------------------------------

/** @type {Map<string, { version: string, deps: string[] }>} */
const packages = new Map();
const manifests = new Map();
/** Named in the workspace but outside the release plan — see the header. */
const privateNames = new Set();
for (const dir of readdirSync(packagesDir)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private) {
    privateNames.add(manifest.name);
    continue;
  }
  manifests.set(manifest.name, manifest);
  packages.set(manifest.name, { version: manifest.version, deps: [] });
}

/** @type {Map<string, string[]>} dependency name -> packages that depend on it */
const dependents = new Map([...packages.keys()].map((name) => [name, []]));
for (const [name, manifest] of manifests) {
  const deps = new Set(
    RUNTIME_DEPENDENCIES.flatMap((depType) => Object.keys(manifest[depType] ?? {})).filter((dep) =>
      packages.has(dep),
    ),
  );
  packages.get(name).deps = [...deps];
  for (const dep of deps) dependents.get(dep).push(name);
}

// -- read, and drop what cannot be released ---------------------------------

/** @type {Map<string, string>} package name -> largest bump requested */
const requested = new Map();
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith('.md') || file === 'README.md') continue;
  const path = join(changesetDir, file);
  const { releases, summary } = parseChangesetFile(readFileSync(path, 'utf8'));

  const releasable = releases.filter((r) => !privateNames.has(r.name));
  if (releasable.length < releases.length) {
    const dropped = releases.filter((r) => privateNames.has(r.name)).map((r) => r.name);
    if (releasable.length === 0) {
      console.error(
        `${file} names only packages that are never published (${dropped.join(', ')}).\n` +
          'Name the package that ships the change instead — for sqlite-shared that is ' +
          '@haverstack/record-adapter-sqlite, which bundles it.',
      );
      process.exit(1);
    }
    const frontmatter = releasable.map((r) => `'${r.name}': ${r.type}`).join('\n');
    if (!dryRun) writeFileSync(path, `---\n${frontmatter}\n---\n\n${summary}\n`);
    console.log(`${dryRun ? 'would drop' : 'dropped'} ${dropped.join(', ')} from ${file}`);
  }

  for (const { name, type } of releasable) {
    if (!packages.has(name)) continue;
    if (!isAtLeast(requested.get(name), type)) requested.set(name, type);
  }
}

// -- propagate ---------------------------------------------------------------

/** Packages whose release is breaking, whether asked for or induced here. */
const breaking = new Set(
  [...requested]
    .filter(([name, type]) => isAtLeast(type, breakingBump(packages.get(name).version)))
    .map(([name]) => name),
);

const queue = [...breaking];
while (queue.length > 0) {
  for (const dependent of dependents.get(queue.shift())) {
    if (breaking.has(dependent)) continue;
    breaking.add(dependent);
    queue.push(dependent);
  }
}

/**
 * Group the induced packages by the breaking dependencies that forced them, so
 * each generated changeset can say which dependency it is following.
 */
const groups = new Map();
for (const name of [...breaking].sort()) {
  const bump = breakingBump(packages.get(name).version);
  if (isAtLeast(requested.get(name), bump)) continue;
  const causes = packages
    .get(name)
    .deps.filter((dep) => breaking.has(dep))
    .sort();
  const key = causes.join(', ');
  if (!groups.has(key)) groups.set(key, { causes, names: [] });
  groups.get(key).names.push({ name, bump });
}

// -- write --------------------------------------------------------------------

if (groups.size === 0) {
  console.log('No dependents to expand.');
  process.exit(0);
}

for (const [key, { causes, names }] of groups) {
  const frontmatter = names.map(({ name, bump }) => `'${name}': ${bump}`).join('\n');
  const list = causes.map((cause) => `\`${cause}\``).join(', ');
  const contents = `---\n${frontmatter}\n---\n\nReleased for a breaking change in ${list}.\n`;
  const path = join(changesetDir, `${generatedFilePrefix}${causes.map(unscoped).join('-')}.md`);

  console.log(`${dryRun ? 'would write' : 'wrote'} ${path}`);
  for (const { name, bump } of names) console.log(`  ${bump}  ${name}  (follows ${key})`);
  if (!dryRun) writeFileSync(path, contents);
}
