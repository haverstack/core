/**
 * Invariants every fixture group owes, asserted across the whole package
 * rather than per group. Two of them — that names are unique and that
 * `allConformanceFixtures` is the complete concatenation it claims to be —
 * are promises the fixture *types* make to consumers, and both are the kind
 * a hand-maintained list stops keeping the moment a group is added.
 *
 * The groups are read off the module's own exports, not listed here: a list
 * would need the same maintenance it exists to guard.
 */
import { describe, it, expect } from 'vitest';
import * as fixtures from '../src/index.js';
import type { ConformanceFixture } from '../src/index.js';

type Named = { name: string; description: string };

const isNamed = (v: unknown): v is Named =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Named).name === 'string' &&
  typeof (v as Named).description === 'string';

const exportedArrays: [string, readonly unknown[]][] = Object.entries(
  fixtures as Record<string, unknown>,
).filter((entry): entry is [string, readonly unknown[]] => Array.isArray(entry[1]));

/**
 * The only fields that nest a further fixture. Everything else a fixture
 * carries is payload — a request or response body, an SSE frame's data —
 * and walking into one would hold any payload that happens to carry a
 * `name` and a `description` to the rules below, which are promises the
 * fixture types make and a payload does not.
 */
const NESTING_KEYS = ['steps', 'precedingMutations', 'activity', 'mutation'] as const;

/** Every named fixture reachable from a group, including sequence steps and the mutations nested inside a change-feed connection. */
function collect(value: unknown, into: Named[]): Named[] {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return into;
  }
  if (typeof value !== 'object' || value === null) return into;
  if (isNamed(value)) into.push(value);
  for (const key of NESTING_KEYS) {
    if (key in value) collect((value as Record<string, unknown>)[key], into);
  }
  return into;
}

describe('every fixture group', () => {
  it('is exported non-empty, so a group cannot be silently emptied', () => {
    for (const [name, group] of exportedArrays) expect(group.length, name).toBeGreaterThan(0);
  });

  // Names are the test-case ids consumers report against, so a collision
  // makes two obligations indistinguishable in a consumer's output.
  it('names every fixture uniquely across the whole package', () => {
    const named = exportedArrays
      // Its entries are the other groups' by reference; counting them would
      // report every name twice.
      .filter(([name]) => name !== 'allConformanceFixtures')
      .flatMap(([, group]) => collect(group, []));

    const counts = new Map<string, number>();
    for (const { name } of named) counts.set(name, (counts.get(name) ?? 0) + 1);

    // A sequence step repeats an earlier fixture byte for byte — that is
    // what makes a replay a replay — so it carries its own name too.
    expect([...counts].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([]);
  });

  it('describes what each fixture pins', () => {
    for (const [group, value] of exportedArrays) {
      for (const { name, description } of collect(value, [])) {
        expect(description.length, `${group}/${name}`).toBeGreaterThan(20);
      }
    }
  });
});

describe('allConformanceFixtures', () => {
  /**
   * The field each of the four groups carrying its own fixture type has and
   * a plain request/response fixture does not. Telling them apart by their
   * own markers rather than by `method` alone keeps the classification
   * honest if one of them later grows the fields a plain fixture has — an
   * upload fixture is a POST with a body, and naming them so would not make
   * it a JSON pair a consumer of this array can replay.
   */
  const OWN_TYPE_MARKERS = ['steps', 'openingFrames', 'responseHeaders', 'requestBodyBytes'];

  const isPlain = (v: unknown): v is ConformanceFixture =>
    isNamed(v) &&
    'method' in v &&
    'responseStatus' in v &&
    !OWN_TYPE_MARKERS.some((marker) => marker in v);

  const groups = exportedArrays.filter(([name]) => name !== 'allConformanceFixtures');

  /** The groups it concatenates: every exported array of plain request/response fixtures. */
  const plainGroups = groups.filter(([, group]) => group.every(isPlain));

  // A group is one kind of fixture or the other. A mixed one would be half
  // concatenated below and half not, and either half would look correct.
  it('draws from groups that are wholly plain or wholly not', () => {
    for (const [name, group] of groups) {
      const plain = group.filter(isPlain).length;
      expect([0, group.length], name).toContain(plain);
    }
  });

  it('contains every plain request/response fixture group', () => {
    const present = new Set<unknown>(fixtures.allConformanceFixtures);
    for (const [group, entries] of plainGroups) {
      const missing = entries.filter((f) => !present.has(f)).map((f) => (f as Named).name);
      expect(missing, group).toEqual([]);
    }
  });

  // The groups carrying their own fixture type — attachments and the change
  // feed pin headers and SSE frames, not a JSON pair — are deliberately out,
  // and a consumer iterating this array must not receive one.
  it('contains nothing but those', () => {
    const fromPlainGroups = new Set<unknown>(plainGroups.flatMap(([, group]) => group));
    const strangers = fixtures.allConformanceFixtures
      .filter((f) => !fromPlainGroups.has(f))
      .map((f) => f.name);
    expect(strangers).toEqual([]);

    // By reference, so a fixture copied in rather than concatenated — which
    // would pass the check above by name alone — is still caught.
    const expected = plainGroups.reduce((total, [, group]) => total + group.length, 0);
    expect(fixtures.allConformanceFixtures).toHaveLength(expected);
  });
});
