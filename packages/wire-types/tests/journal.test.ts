import { describe, it, expect } from 'vitest';
import { serializeJournalEntry } from '../src/index.js';
import type { RecordJournalEntry } from '@haverstack/core';

const ACTOR = 'did:key:zActor';
const PRINCIPAL = 'did:key:zPrincipal';

const entry = (overrides: Partial<RecordJournalEntry> = {}): RecordJournalEntry => ({
  seq: 1,
  at: new Date('2024-01-02T00:00:00.000Z'),
  kind: 'changed',
  ops: ['associate'],
  version: 3,
  typeId: 'com.example/note@1',
  ...overrides,
});

describe('serializeJournalEntry', () => {
  it('carries the envelope, with `at` as an ISO string', () => {
    expect(serializeJournalEntry(entry())).toEqual({
      seq: 1,
      at: '2024-01-02T00:00:00.000Z',
      kind: 'changed',
      ops: ['associate'],
      version: 3,
      typeId: 'com.example/note@1',
    });
  });

  it('copies `ops` rather than aliasing the entry it read', () => {
    const source = entry();
    const w = serializeJournalEntry(source);
    expect(w.ops).toEqual(source.ops);
    expect(w.ops).not.toBe(source.ops);
  });

  it('omits every optional field the entry does not carry', () => {
    const w = serializeJournalEntry(entry());
    for (const key of [
      'parentId',
      'actor',
      'previousParentId',
      'associationsAdded',
      'associationsRemoved',
      'associationsReplaced',
    ]) {
      expect(key in w).toBe(false);
    }
  });

  it('carries a null previousParentId, which is the root and not an absent field', () => {
    const w = serializeJournalEntry(entry({ ops: ['reparent'], previousParentId: null }));
    expect('previousParentId' in w).toBe(true);
    expect(w.previousParentId).toBeNull();
  });

  it('carries a named previousParentId', () => {
    const w = serializeJournalEntry(entry({ ops: ['reparent'], previousParentId: '1hk153x0000f' }));
    expect(w.previousParentId).toBe('1hk153x0000f');
  });

  it('carries the actor whole, principal and app included', () => {
    const w = serializeJournalEntry(
      entry({ actor: { entityId: ACTOR, principalId: PRINCIPAL, appId: 'com.example/editor' } }),
    );
    expect(w.actor).toEqual({
      entityId: ACTOR,
      principalId: PRINCIPAL,
      appId: 'com.example/editor',
    });
  });

  it('carries associationsReplaced, which no change frame has', () => {
    const replaced = [
      {
        kind: 'attachment' as const,
        label: 'embed',
        fileId: 'a'.repeat(64),
        attachmentRecordId: '1hk153x00009',
      },
    ];
    expect(
      serializeJournalEntry(entry({ associationsReplaced: replaced })).associationsReplaced,
    ).toEqual(replaced);
  });
});
