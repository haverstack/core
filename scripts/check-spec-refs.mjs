/**
 * Spec reference integrity.
 *
 * Section names are load-bearing: prose links to them as `](./file.md#anchor)`
 * and code comments cite them as `docs/spec/<file>.md § Section`. Renaming a
 * heading breaks both silently — nothing fails to build, and the reader who
 * follows the link is the one who finds out. This checks both directions:
 *
 *   1. Every intra-repo markdown anchor link resolves to a real heading.
 *   2. Every `§` citation in TypeScript resolves to a real heading.
 *
 * A `§` name is matched by longest heading prefix rather than by parsing where
 * the name ends, because headings legitimately contain the characters a
 * sentence ends with — `§ Enforcement: Stack.asEntity()`,
 * `§ Optimistic concurrency (ifVersion)` — so there is no punctuation that
 * reliably terminates one. Citations are also unwrapped first: a JSDoc
 * comment may break a reference across lines, and the two halves only read as
 * one reference once the `*` gutter is gone.
 *
 * Runs as `pnpm run check:refs`, and in CI.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.changeset']);

/** Every file under `dir` matching `ext`, recursively. */
function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (entry.endsWith(ext)) out.push(path);
  }
  return out;
}

/**
 * GitHub's heading slug: formatting stripped, lowercased, anything that is
 * not a word character, space or hyphen removed, then spaces to hyphens.
 * Underscores survive — `_config` anchors depend on it. A repeated slug gets
 * `-1`, `-2`, … appended, same as GitHub.
 */
function slugify(heading) {
  return stripMarkdown(heading)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');
}

/**
 * A heading's rendered text. Underscores are left alone: `_config` and
 * `_attachment` are type names, not emphasis, and GitHub keeps them in the
 * slug — stripping them breaks every anchor naming a system type.
 */
function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link in a heading reads as its text
    .replace(/`/g, '')
    .replace(/\*\*|\*/g, '')
    .trim();
}

/** `{ slugs: Set<string>, titles: string[] }` for one markdown file. */
function headingsOf(path) {
  const slugs = new Set();
  const titles = [];
  const seen = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
    titles.push(stripMarkdown(m[1]));
  }
  return { slugs, titles };
}

const markdown = new Map(); // repo-relative path -> headings
for (const path of walk(join(repoRoot, 'docs'), '.md')) {
  markdown.set(relative(repoRoot, path), headingsOf(path));
}
for (const root of ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md']) {
  try {
    markdown.set(root, headingsOf(join(repoRoot, root)));
  } catch {
    // A root doc that doesn't exist is not this script's business.
  }
}

const failures = [];
let anchorLinks = 0;
let citations = 0;

// -- 1. markdown anchor links ----------------------------------------------

for (const path of markdown.keys()) {
  const src = readFileSync(join(repoRoot, path), 'utf8');
  let inFence = false;
  src.split('\n').forEach((rawLine, i) => {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // Link syntax shown as an example is not a link. Blank inline code spans
    // rather than removing them, so reported line numbers stay true.
    const line = rawLine.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target) || !target.includes('#')) continue;
      anchorLinks++;
      const [file, anchor] = target.split('#');
      const targetPath = file ? normalize(join(dirname(path), file)) : path;
      const headings = markdown.get(targetPath);
      if (!headings) failures.push(`${path}:${i + 1}  no such file: ${target}`);
      else if (!headings.slugs.has(anchor))
        failures.push(`${path}:${i + 1}  no such anchor: ${target}`);
    }
  });
}

// -- 2. `§` citations in code ----------------------------------------------

/**
 * Longest heading in `titles` that `text` begins with, or null. A heading is
 * also matched by its unparenthesized form, since a citation reasonably drops
 * a parenthetical clarifier — `§ Optimistic concurrency` for
 * `## Optimistic concurrency (ifVersion)`.
 */
function longestPrefixHeading(titles, text) {
  const probe = text.toLowerCase();
  let best = null;
  for (const title of titles) {
    for (const form of [title, title.replace(/\s*\([^)]*\)/g, '')]) {
      const candidate = form.toLowerCase().trim();
      if (candidate && probe.startsWith(candidate) && candidate.length > (best?.length ?? 0)) {
        best = candidate;
      }
    }
  }
  return best;
}

for (const path of walk(join(repoRoot, 'packages'), '.ts')) {
  const rel = relative(repoRoot, path);
  // Unwrap comment gutters and string concatenation so a citation split
  // across lines reads as one.
  const flat = readFileSync(path, 'utf8')
    .replace(/\n\s*\*\s?/g, ' ')
    .replace(/\n\s*\/\/\s?/g, ' ')
    .replace(/['"]\s*\+\s*\n?\s*['"]/g, '');
  for (const m of flat.matchAll(/(docs\/[\w./-]*\.md)\s+§\s+([^\n]{1,160})/g)) {
    citations++;
    const targetPath = normalize(m[1]);
    const headings = markdown.get(targetPath);
    if (!headings) {
      failures.push(`${rel}  no such file: ${m[1]} § …`);
      continue;
    }
    const name = stripMarkdown(m[2]);
    if (!longestPrefixHeading(headings.titles, name)) {
      failures.push(`${rel}  no such section: ${m[1]} § ${name.slice(0, 60)}`);
    }
  }
}

// -- report ----------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(
    `\n${failures.length} unresolved reference(s) — checked ${anchorLinks} anchor links and ${citations} § citations.`,
  );
  console.error('A renamed heading needs its inbound references updated in the same change.\n');
  process.exit(1);
}

console.log(`${anchorLinks} anchor links and ${citations} § citations all resolve.`);
