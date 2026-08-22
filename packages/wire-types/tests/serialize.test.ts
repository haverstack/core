import { describe, it, expect } from 'vitest';
import { serializeRecord, serializeVersion } from '../src/index.js';
import type { StackRecord, RecordVersion } from '@haverstack/core';

const AUTHOR = 'did:key:zAuthor';
const EDITOR = 'did:key:zEditor';
const APP = 'did:key:zApp';

const record = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: '1hk153x00001',
  typeId: 'com.example/note@1',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  content: { title: 'Hello' },
  version: 2,
  ...overrides,
});

const version = (overrides: Partial<RecordVersion> = {}): RecordVersion => ({
  version: 1,
  typeId: 'com.example/note@1',
  content: { title: 'Hello' },
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('serializeRecord', () => {
  it('encodes dates as ISO strings and keeps the core fields', () => {
    const w = serializeRecord(record());
    expect(w).toMatchObject({
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      version: 2,
    });
  });

  it('carries authorship and attribution as four distinct fields', () => {
    const w = serializeRecord(
      record({ entityId: AUTHOR, principalId: APP, updatedBy: EDITOR, updatedVia: APP }),
    );
    expect(w.entityId).toBe(AUTHOR);
    expect(w.principalId).toBe(APP);
    expect(w.updatedBy).toBe(EDITOR);
    expect(w.updatedVia).toBe(APP);
  });

  // Absent means unknown, and it has to survive the wire as absent: a key
  // present with a null value would read back as a value.
  it('omits an absent actor rather than encoding a null', () => {
    const w = serializeRecord(record({ entityId: AUTHOR }));
    expect('updatedBy' in w).toBe(false);
    expect('updatedVia' in w).toBe(false);
    expect(JSON.parse(JSON.stringify(w))).not.toHaveProperty('updatedBy');
  });

  it('omits updatedVia alone when a write is undelegated', () => {
    const w = serializeRecord(record({ entityId: AUTHOR, updatedBy: EDITOR }));
    expect(w.updatedBy).toBe(EDITOR);
    expect('updatedVia' in w).toBe(false);
  });
});

describe('serializeVersion', () => {
  it('carries the author and the actor of that version separately', () => {
    const w = serializeVersion(version({ entityId: AUTHOR, updatedBy: EDITOR, updatedVia: APP }));
    expect(w.entityId).toBe(AUTHOR);
    expect(w.updatedBy).toBe(EDITOR);
    expect(w.updatedVia).toBe(APP);
  });

  it('omits an absent actor', () => {
    const w = serializeVersion(version({ entityId: AUTHOR }));
    expect('updatedBy' in w).toBe(false);
    expect('updatedVia' in w).toBe(false);
  });

  it('encodes updatedAt as an ISO string', () => {
    expect(serializeVersion(version()).updatedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});
