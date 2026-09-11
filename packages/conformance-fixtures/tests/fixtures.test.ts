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

/** Every named fixture reachable from a group, including sequence steps and the mutations nested inside a change-feed connection. */
function collect(value: unknown, into: Named[]): Named[] {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
  } else if (typeof value === 'object' && value !== null) {
    if (isNamed(value)) into.push(value);
    for (const nested of Object.values(value)) collect(nested, into);
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
  const isPlain = (v: unknown): v is ConformanceFixture =>
    isNamed(v) && 'method' in v && 'responseStatus' in v;

  /** The groups it concatenates: every exported array of plain request/response fixtures. */
  const plainGroups = exportedArrays.filter(
    ([name, group]) => name !== 'allConformanceFixtures' && group.every(isPlain),
  );

  it('contains every plain request/response fixture group', () => {
    const present = new Set(fixtures.allConformanceFixtures.map((f) => f.name));
    for (const [group, entries] of plainGroups) {
      const missing = entries
        .filter(isPlain)
        .filter((f) => !present.has(f.name))
        .map((f) => f.name);
      expect(missing, group).toEqual([]);
    }
  });

  // The groups carrying their own fixture type — attachments and the change
  // feed pin headers and SSE frames, not a JSON pair — are deliberately out,
  // and a consumer iterating this array must not receive one.
  it('contains nothing but those', () => {
    const expected = plainGroups.reduce((total, [, group]) => total + group.length, 0);
    expect(fixtures.allConformanceFixtures).toHaveLength(expected);
  });
});
