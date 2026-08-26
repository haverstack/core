/**
 * The change-feed fixtures encode rules rather than merely illustrating
 * them — a purge carries nothing, ready leads, a cursor is framable — and
 * a fixture that quietly violated the rule it exists to pin would take
 * every consumer with it. These assert the data against the rules it is
 * written in terms of. See docs/spec/wire-format.md § Change feed.
 */
import { describe, it, expect } from 'vitest';
import { isValidSeq } from '@haverstack/wire-types';
import type { WireRecordChange } from '@haverstack/wire-types';
import { changeFeedFixtures, changeFeedSequenceFixtures } from '../src/index.js';
import type { ChangeFeedFixture, ChangeFeedFrame } from '../src/index.js';

/** Every connection in the group, sequence steps flattened alongside singles. */
const connections: ChangeFeedFixture[] = [
  ...changeFeedFixtures,
  ...changeFeedSequenceFixtures.flatMap((s) => s.steps),
];

const framesOf = (c: ChangeFeedFixture): ChangeFeedFrame[] => [
  ...c.openingFrames,
  ...(c.activity?.flatMap((a) => a.frames) ?? []),
];

const recordFrames = connections.flatMap((c) =>
  framesOf(c)
    .filter((f) => f.event === 'record')
    .map((f) => ({ connection: c.name, change: f.data as WireRecordChange, frame: f })),
);

const KIND_OF_OP: Record<string, string> = {
  create: 'created',
  update: 'changed',
  associate: 'changed',
  dissociate: 'changed',
  permissions: 'changed',
  migrate: 'changed',
  restore: 'changed',
  undelete: 'changed',
  delete: 'deleted',
  'hard-delete': 'purged',
};

describe('change feed fixture names', () => {
  it('are unique across connections, their mutations and their sequences', () => {
    const names = [
      ...changeFeedSequenceFixtures.map((s) => s.name),
      ...connections.flatMap((c) => [
        c.name,
        ...(c.precedingMutations?.map((m) => m.name) ?? []),
        ...(c.activity?.map((a) => a.mutation.name) ?? []),
      ]),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('every connection', () => {
  it('leads with ready, before any change', () => {
    for (const c of connections) {
      expect(c.openingFrames[0]?.event, c.name).toBe('ready');
    }
  });

  // A control frame is not a position in the stream to resume from: a
  // client that stored one as its cursor would present something the
  // server never minted.
  it('gives ready and reset no frame id', () => {
    for (const c of connections) {
      for (const f of framesOf(c)) {
        if (f.event === 'ready' || f.event === 'reset') expect(f.id, c.name).toBeUndefined();
      }
    }
  });

  it('mints every frame id in the framable charset', () => {
    for (const c of connections) {
      for (const f of framesOf(c)) {
        if (f.id !== undefined) expect(isValidSeq(f.id), `${c.name}: ${f.id}`).toBe(true);
      }
    }
  });

  it('is answered 200, since a feed refusal is an ordinary auth failure', () => {
    for (const c of connections) expect(c.responseStatus, c.name).toBe(200);
  });
});

describe('every record frame', () => {
  it('carries the kind its op maps to', () => {
    for (const { connection, change } of recordFrames) {
      expect(KIND_OF_OP[change.op], `${connection}: ${change.op}`).toBe(change.kind);
    }
  });

  it('names the record, its type and the version the change produced', () => {
    for (const { connection, change } of recordFrames) {
      expect(change.recordId, connection).toBeTruthy();
      expect(change.typeId, connection).toContain('@');
      expect(change.version, connection).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(change.updatedAt)), connection).toBe(false);
    }
  });

  // The envelope describes the change; the record describes the record.
  // A provenance field here would be read as "who changed this" and mean
  // "who wrote it first", which is how the earlier shape misled its own
  // worked example.
  it('carries no record provenance beside the actor', () => {
    for (const { connection, frame } of recordFrames) {
      const data = frame.data as Record<string, unknown>;
      for (const field of ['entityId', 'appId', 'principalId', 'updatedBy', 'updatedVia']) {
        expect(field in data, `${connection}: ${field}`).toBe(false);
      }
    }
  });
});

describe('a purged frame', () => {
  const purges = recordFrames.filter(({ change }) => change.kind === 'purged');

  it('appears in the fixtures at all, including on a connection asking for records', () => {
    expect(purges.length).toBeGreaterThan(0);
    const asked = connections.filter((c) => c.path.includes('include=record'));
    expect(
      asked.some((c) => framesOf(c).some((f) => (f.data as WireRecordChange).kind === 'purged')),
    ).toBe(true);
  });

  it('carries neither the record nor anything else pointing at it', () => {
    for (const { connection, change } of purges) {
      expect('record' in change, connection).toBe(false);
      expect('parentId' in change, connection).toBe(false);
    }
  });

  // Hard delete is owner-acting-alone and refuses delegation, so a
  // principal beside the subject would describe a call that cannot happen.
  it('names an actor with no principal beside it', () => {
    for (const { connection, change } of purges) {
      expect(change.actor?.entityId, connection).toBeTruthy();
      expect(change.actor?.principalId, connection).toBeUndefined();
    }
  });
});
