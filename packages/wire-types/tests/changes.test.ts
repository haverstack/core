import { describe, it, expect } from 'vitest';
import {
  CHANGE_TRANSPORT_SSE,
  WIRE_PROTOCOL_VERSION,
  isValidSeq,
  serializeChange,
  supportsChangeFeed,
} from '../src/index.js';
import type { DiscoveryResponse } from '../src/index.js';
import type { RecordChange, StackRecord } from '@haverstack/core';

const AUTHOR = 'did:key:zAuthor';
const EDITOR = 'did:key:zEditor';
const APP = 'did:key:zApp';
const OWNER = 'did:key:zOwner';

const record = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: '1hk153x00001',
  typeId: 'com.example/note@1',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  content: { title: 'Hello' },
  version: 2,
  entityId: AUTHOR,
  ...overrides,
});

const change = (overrides: Partial<RecordChange> = {}): RecordChange => ({
  kind: 'changed',
  op: 'update',
  recordId: '1hk153x00001',
  typeId: 'com.example/note@1',
  version: 2,
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  ...overrides,
});

const discovery = (overrides: Partial<DiscoveryResponse> = {}): DiscoveryResponse => ({
  version: WIRE_PROTOCOL_VERSION,
  entityId: OWNER,
  capabilities: {
    filter: {
      content: 'path',
      contentPresent: true,
      search: true,
    },
    sort: {
      fields: ['createdAt'],
      contentField: true,
    },
    limits: {
      attachmentBytes: null,
      contentBytes: null,
    },
  },
  ...overrides,
});

describe('serializeChange', () => {
  it('encodes the envelope with updatedAt as an ISO string', () => {
    expect(serializeChange(change())).toEqual({
      kind: 'changed',
      op: 'update',
      recordId: '1hk153x00001',
      typeId: 'com.example/note@1',
      version: 2,
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
  });

  it('carries the actor, and omits the principal on an undelegated write', () => {
    const w = serializeChange(change({ actor: { entityId: EDITOR } }));
    expect(w.actor).toEqual({ entityId: EDITOR });
    expect(w.actor).not.toHaveProperty('principalId');
  });

  it('carries the principal and the app when a delegated app acted', () => {
    const w = serializeChange(
      change({ actor: { entityId: EDITOR, principalId: APP, appId: 'com.example.app' } }),
    );
    expect(w.actor).toEqual({
      entityId: EDITOR,
      principalId: APP,
      appId: 'com.example.app',
    });
  });

  // Absent means unknown — an unscoped write with no requester to name —
  // and it has to survive the wire as absent, since a key present with a
  // null value reads back as a value.
  it('omits an absent actor rather than encoding a null', () => {
    const w = serializeChange(change());
    expect('actor' in w).toBe(false);
    expect(JSON.parse(JSON.stringify(w))).not.toHaveProperty('actor');
  });

  it('carries the record when the frame includes one', () => {
    const w = serializeChange(change({ record: record() }));
    expect(w.record).toMatchObject({ id: '1hk153x00001', entityId: AUTHOR, version: 2 });
  });

  it('carries parentId for a record that has one', () => {
    const w = serializeChange(change({ parentId: '1hk153x00000' }));
    expect(w.parentId).toBe('1hk153x00000');
  });

  it('carries a server-minted cursor when the frame has one', () => {
    expect(serializeChange(change({ seq: 'AA3f1R' })).seq).toBe('AA3f1R');
  });
});

describe('serializeChange on a purge', () => {
  const purge = (overrides: Partial<RecordChange> = {}): RecordChange =>
    change({
      kind: 'purged',
      op: 'hard-delete',
      version: 4,
      actor: { entityId: OWNER },
      ...overrides,
    });

  // A server holds the purged record at emission, because readability can
  // only be evaluated before the write. That is exactly the position from
  // which to leak it, so the prohibition is enforced here rather than
  // trusted to every call site.
  it('drops a record handed to it, whatever the subscriber asked for', () => {
    const w = serializeChange(purge({ record: record({ version: 4 }) }));
    expect('record' in w).toBe(false);
  });

  it('drops parentId, which points at what was erased', () => {
    const w = serializeChange(purge({ parentId: '1hk153x00000', record: record() }));
    expect('parentId' in w).toBe(false);
  });

  it('keeps the outline a purge is auditable by', () => {
    expect(serializeChange(purge({ record: record() }))).toEqual({
      kind: 'purged',
      op: 'hard-delete',
      recordId: '1hk153x00001',
      typeId: 'com.example/note@1',
      version: 4,
      updatedAt: '2024-01-02T00:00:00.000Z',
      actor: { entityId: OWNER },
    });
  });
});

describe('supportsChangeFeed', () => {
  it('is true for a server advertising the streaming transport', () => {
    const d = discovery({
      changes: { transports: [CHANGE_TRANSPORT_SSE], resume: true, records: true },
    });
    expect(supportsChangeFeed(d)).toBe(true);
  });

  // A server may advertise a feed it cannot resume, or one that never
  // includes records. Both are conformant, and neither is the question
  // this predicate answers.
  it('is true for a feed that neither resumes nor includes records', () => {
    const d = discovery({
      changes: { transports: [CHANGE_TRANSPORT_SSE], resume: false, records: false },
    });
    expect(supportsChangeFeed(d)).toBe(true);
  });

  it('is false when a server advertises no feed at all', () => {
    expect(supportsChangeFeed(discovery())).toBe(false);
  });

  it('is false for a feed offering only transports this client cannot speak', () => {
    const d = discovery({
      changes: { transports: [] as never[], resume: true, records: true },
    });
    expect(supportsChangeFeed(d)).toBe(false);
  });
});

describe('isValidSeq', () => {
  it('accepts unreserved base64url characters', () => {
    for (const good of ['AA3f1Q', 'a-b_c', '0', 'A'.repeat(64)]) {
      expect(isValidSeq(good)).toBe(true);
    }
  });

  // A cursor rides an SSE `id:` field, so anything that can end a line or
  // a field ends the frame carrying it instead.
  it('rejects anything that could span a frame', () => {
    for (const bad of ['', 'a b', 'a\nb', 'a\rb', 'a:b', 'a+b', 'a/b', 'AA==', '../etc']) {
      expect(isValidSeq(bad)).toBe(false);
    }
  });
});
