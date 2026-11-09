/**
 * The version-history sequences encode the snapshot rule rather than merely
 * illustrating it: a bumping mutation adds exactly the entry for the state
 * it replaced, and a no-bump one adds nothing. A sequence whose reads
 * drifted from that would pin a server to the wrong history. These assert
 * the data against the rule. See docs/spec/versioning.md § Version history.
 */
import { describe, it, expect } from 'vitest';
import type { WireRecord, WireVersionsResponse } from '@haverstack/wire-types';
import { getVersionsSequenceFixtures } from '../src/index.js';

const versionsOf = (body: unknown): number[] =>
  (body as WireVersionsResponse).versions.map((v) => v.version);

describe('getVersionsSequenceFixtures', () => {
  for (const sequence of getVersionsSequenceFixtures) {
    // Reads on both sides of every mutation are what make each one's effect
    // on the history observable.
    it(`${sequence.name} reads the history around every mutation`, () => {
      const methods = sequence.steps.map((s) => s.method);
      expect(methods.length % 2).toBe(1);
      methods.forEach((method, i) => {
        if (i % 2 === 0) expect(method, sequence.steps[i].name).toBe('GET');
        else expect(method, sequence.steps[i].name).not.toBe('GET');
      });
    });

    it(`${sequence.name} grows the history only on a version bump`, () => {
      const [first, ...rest] = sequence.steps;
      let history = versionsOf(first.responseBody);

      for (let i = 0; i < rest.length; i += 2) {
        const [mutation, read] = [rest[i], rest[i + 1]];
        // Every replaced version has a snapshot, so the newest is one behind.
        const prior = history[0] + 1;
        const { version } = mutation.responseBody as WireRecord;
        expect([prior, prior + 1], mutation.name).toContain(version);

        const expected = version === prior ? history : [prior, ...history];
        expect(versionsOf(read.responseBody), read.name).toEqual(expected);
        history = expected;
      }
    });
  }
});
