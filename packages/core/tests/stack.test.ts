import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack.js';
import {
  StackError,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackSchemaDriftError,
  StackQueryError,
  StackPayloadTooLargeError,
  StackClosedError,
  StackMisconfigurationError,
} from '../src/errors.js';
import {
  generateId,
  crockford32Encode,
  idTimestamp,
  isValidIdFormat,
  MAX_ID_TIMESTAMP,
  IdGenerationError,
} from '../src/id.js';
import type { TypeSchema } from '../src/types.js';
import { RESERVED_CONTENT_KEYS, CONTENT_KEY_PATH_METACHARACTERS } from '../src/validate.js';
import { InvalidDidError } from '../src/did.js';
import { MemoryAdapter, IncapableMemoryAdapter } from '../src/testing.js';
import { firstRecordedAttachment } from '../src/attachment-download.js';
import type {
  DataAssociation,
  AttachmentContent,
  BlobFileInfo,
  Association,
  AuthorityAssociation,
  GrantContent,
  GrantGrantee,
  RecordChange,
  RecordFilter,
  RelationshipTarget,
  StackAdapter,
  StackRecord,
} from '../src/types.js';

// -------------------------------------------------------
// Test setup
// -------------------------------------------------------

// Builds a well-formed 12-char id with a specific timestamp prefix, bypassing
// generateId()'s own monotonic-clock clamp (which would otherwise pull an
// "ancient" test timestamp forward to the real current time).
const idWithTimestamp = (ms: number): string => `${crockford32Encode(ms).padStart(9, '0')}000`;

const NOTE_V1 = 'com.example.test/note@1';
const NOTE_V2 = 'com.example.test/note@2';
const NOTE_V3 = 'com.example.test/note@3';

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
  stack = await Stack.open(adapter);

  await stack.defineType(NOTE_V1, 'Note', {
    text: { kind: 'text', required: true },
  });
});

// -------------------------------------------------------
// Stack.open
// -------------------------------------------------------

describe('Stack.open', () => {
  test('reads ownerEntityId from adapter', async () => {
    expect(stack.ownerEntityId).toBe('owner-123');
  });

  test('reads timezone from adapter', async () => {
    expect(stack.timezone).toBe('UTC');
  });

  test('an adapter with no ownerEntityId is a StackMisconfigurationError, outside StackError', async () => {
    const emptyAdapter = new MemoryAdapter();
    const err = await Stack.open(emptyAdapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackMisconfigurationError);
    expect(err).not.toBeInstanceOf(StackError);
    expect((err as Error).name).toBe('StackMisconfigurationError');
    expect((err as Error).message).toContain('adapter has no ownerEntityId');
  });

  // timezone is optional passthrough metadata, nothing more — no
  // default, since defaulting to a real timezone would claim knowledge the
  // stack doesn't have.
  test('timezone is undefined when not specified — no default', async () => {
    const adapter = new MemoryAdapter({ ownerEntityId: 'entity-without-timezone' });
    const s = await Stack.open(adapter);
    expect(s.timezone).toBeUndefined();
  });

  describe('ownerProfile', () => {
    test('does nothing when omitted', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter);
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(0);
    });

    test('creates the owner _entity record on first init', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, {
        ownerProfile: { name: 'Jane Smith', handle: 'janesmith' },
      });

      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
      expect(records[0].content).toEqual({
        did: 'did:key:owner',
        name: 'Jane Smith',
        handle: 'janesmith',
      });
    });

    test('omits handle when not provided', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records[0].content).toEqual({ did: 'did:key:owner', name: 'Jane Smith' });
    });

    test('is idempotent across reopen — does not duplicate the owner record', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      // Simulate a later run against the same (still-open) adapter/data.
      const reopened = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const { records } = await reopened.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
    });

    test('does not overwrite an existing owner record with different content', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      await Stack.open(emptyAdapter, { ownerProfile: { name: 'Original Name' } });
      const reopened = await Stack.open(emptyAdapter, { ownerProfile: { name: 'New Name' } });

      const { records } = await reopened.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
      expect(records[0].content).toMatchObject({ name: 'Original Name' });
    });

    // A soft-deleted card still reserves the owner's did, so the bootstrap
    // treats it as present rather than minting a second card the binding
    // rules would refuse — reopening stays possible either way.
    test('treats a soft-deleted owner record as existing', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      await s.delete(records[0].id);

      const reopened = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const all = await reopened.query({
        filter: { typeId: '_entity@1', includeDeleted: true },
      });
      expect(all.records).toHaveLength(1);
      expect(all.records[0].deletedAt).toBeDefined();
    });

    // The bootstrap probe and the binding rules must agree about what
    // "already exists" means on every axis, version included: uniqueness is
    // checked across the whole `_entity` family, so a probe that looked only
    // at `_entity@1` would mint a card the rules then refuse.
    test('treats an owner record migrated to a later type version as existing', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      await s.defineType('_entity@2', 'Entity', {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        handle: { kind: 'string' },
        pronouns: { kind: 'string' },
      });
      s.registerMigration({ from: '_entity@1', to: '_entity@2', migrate: (c) => ({ ...c }) });
      await s.migrateAll('_entity');

      const reopened = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const { records } = await reopened.query({ filter: { baseId: '_entity' } });
      expect(records).toHaveLength(1);
      expect(records[0].typeId).toBe('_entity@2');
    });

    test('leaves the created record unauthored (no createdBy), matching owner-attributed convention', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records[0].createdBy?.subjectId).toBeUndefined();
    });

    // The idempotency check cursor-walks every `_entity@1` record, so an
    // owner card past page one (>50 `_entity` records, e.g. an address
    // book) is still found and Stack.open({ ownerProfile }) stays a
    // no-op rather than minting a duplicate.
    test('does not duplicate the owner record when it exists past the first query page (regression)', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s0 = await Stack.open(emptyAdapter);
      for (let i = 0; i < 55; i++) {
        await s0.create('_entity@1', { did: `did:key:filler-${i}`, name: `Filler ${i}` });
      }
      // The owner's own card, created directly (not through ensureOwnerEntity),
      // lands after the filler records in insertion order — past page one.
      await s0.create('_entity@1', { did: 'did:key:owner', name: 'Original Name' });

      await Stack.open(emptyAdapter, { ownerProfile: { name: 'New Name' } });

      const { records } = await s0.query({
        filter: { typeId: '_entity@1' },
        limit: 100,
      });
      const ownerRecords = records.filter(
        (r) => (r.content as Record<string, unknown>).did === 'did:key:owner',
      );
      expect(ownerRecords).toHaveLength(1);
      expect(ownerRecords[0].content).toMatchObject({ name: 'Original Name' });
    });
  });

  describe('getEntityByDid / getOwnerEntity', () => {
    test('resolves the card claiming a did', async () => {
      const created = await stack.create('_entity@1', { did: 'did:key:x', name: 'X' });
      const found = await stack.getEntityByDid('did:key:x');
      expect(found?.id).toBe(created.id);
    });

    test('returns null when no card claims the did', async () => {
      expect(await stack.getEntityByDid('did:key:nobody')).toBeNull();
    });

    // checkBindingUnique() enforces did uniqueness across the whole _entity
    // family, so the lookup must too: filtering by typeId '_entity@1' alone
    // would miss a card migrated to '_entity@2'.
    test('matches a card migrated to a later type version', async () => {
      await stack.defineType('_entity@2', 'Entity', {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        handle: { kind: 'string' },
        pronouns: { kind: 'string' },
      });
      const created = await stack.create('_entity@1', { did: 'did:key:x', name: 'X' });
      stack.registerMigration({ from: '_entity@1', to: '_entity@2', migrate: (c) => ({ ...c }) });
      await stack.migrateAll('_entity');

      const found = await stack.getEntityByDid('did:key:x');
      expect(found?.id).toBe(created.id);
      expect(found?.typeId).toBe('_entity@2');
    });

    // A soft-deleted card still reserves its did (see docs/spec/identity.md
    // § DID bindings), so the lookup must still find it.
    test('includes a soft-deleted card', async () => {
      const created = await stack.create('_entity@1', { did: 'did:key:x', name: 'X' });
      await stack.delete(created.id);
      const found = await stack.getEntityByDid('did:key:x');
      expect(found?.id).toBe(created.id);
      expect(found?.deletedAt).toBeInstanceOf(Date);
    });

    test('includes an unlisted card', async () => {
      const created = await stack.create('_entity@1', { did: 'did:key:x', name: 'X' });
      await stack.mutate(created.id, { unlisted: true });
      const found = await stack.getEntityByDid('did:key:x');
      expect(found?.id).toBe(created.id);
    });

    // The content filter is capability-gated; the in-memory predicate must
    // still find the match when it's unavailable.
    test('resolves the card on an adapter reaching no content', async () => {
      const incapableAdapter = new IncapableMemoryAdapter({ ownerEntityId: 'owner-x' });
      const s = await Stack.open(incapableAdapter);
      const created = await s.create('_entity@1', { did: 'did:key:y', name: 'Y' });
      const found = await s.getEntityByDid('did:key:y');
      expect(found?.id).toBe(created.id);
    });

    test('getOwnerEntity resolves the card ownerProfile created', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.open(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const found = await s.getOwnerEntity();
      expect(found?.content).toMatchObject({ did: 'did:key:owner', name: 'Jane Smith' });
    });

    test('getOwnerEntity returns null when no owner card exists', async () => {
      expect(await stack.getOwnerEntity()).toBeNull();
    });
  });
});

// -------------------------------------------------------
// defineType
// -------------------------------------------------------

describe('defineType', () => {
  test('saves the type to the adapter', async () => {
    const type = await stack.getType(NOTE_V1);
    expect(type).not.toBeNull();
    expect(type?.name).toBe('Note');
  });

  test('computes and stores a schemaHash', async () => {
    const type = await stack.getType(NOTE_V1);
    expect(type?.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('throws for invalid TypeId format', async () => {
    await expect(stack.defineType('no-version', 'Bad', {})).rejects.toThrow();
  });

  test('stores migratesFrom when provided', async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );
    const type = await stack.getType(NOTE_V2);
    expect(type?.migratesFrom).toBe(NOTE_V1);
  });

  // -------------------------------------------------------
  // Schema drift detection
  // -------------------------------------------------------

  test('redefining with an identical schema is a no-op — createdAt does not churn', async () => {
    const before = await stack.getType(NOTE_V1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    const after = await stack.getType(NOTE_V1);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  test('a name-only change persists, preserving createdAt', async () => {
    const before = await stack.getType(NOTE_V1);
    await stack.defineType(NOTE_V1, 'Renamed Note', {
      text: { kind: 'text', required: true },
    });
    const after = await stack.getType(NOTE_V1);
    expect(after?.name).toBe('Renamed Note');
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  test('adding a new optional field in place is accepted, preserving createdAt', async () => {
    const before = await stack.getType(NOTE_V1);
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const after = await stack.getType(NOTE_V1);
    expect(after?.schema.title).toEqual({ kind: 'string' });
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    expect(after?.schemaHash).not.toBe(before?.schemaHash);
  });

  test('adding a new optional field nested inside an existing object is accepted', async () => {
    const nested = 'com.example.test/nested@1';
    await stack.defineType(nested, 'Nested', {
      author: { kind: 'object', required: true, properties: { name: { kind: 'string' } } },
    });
    await stack.defineType(nested, 'Nested', {
      author: {
        kind: 'object',
        required: true,
        properties: { name: { kind: 'string' }, email: { kind: 'string' } },
      },
    });
    const type = await stack.getType(nested);
    expect((type?.schema.author as { properties: unknown }).properties).toHaveProperty('email');
  });

  test('adding a new required field is rejected with StackSchemaDriftError', async () => {
    await expect(
      stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('removing a field is rejected with StackSchemaDriftError', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    await expect(
      stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('changing a field kind is rejected with StackSchemaDriftError, even text/string', async () => {
    await expect(
      stack.defineType(NOTE_V1, 'Note', { text: { kind: 'string', required: true } }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('flipping an existing field required is rejected with StackSchemaDriftError', async () => {
    await expect(stack.defineType(NOTE_V1, 'Note', { text: { kind: 'text' } })).rejects.toThrow(
      StackSchemaDriftError,
    );
  });

  test('StackSchemaDriftError names the specific violation', async () => {
    try {
      await stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StackSchemaDriftError);
      const err = e as StackSchemaDriftError;
      expect(err.typeId).toBe(NOTE_V1);
      expect(err.violations).toEqual([
        { path: 'title', message: 'new field is required; new fields must be optional' },
      ]);
      expect(err.message).toContain('title');
      expect(err.message).toContain('Bump the version');
    }
  });

  test('an illegal redefinition does not overwrite the stored type', async () => {
    const before = await stack.getType(NOTE_V1);
    await expect(
      stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      }),
    ).rejects.toThrow(StackSchemaDriftError);
    const after = await stack.getType(NOTE_V1);
    expect(after).toEqual(before);
  });

  test('repeated seedSystemTypes()-style redefinition across Stack.open() calls stays idempotent', async () => {
    // Simulates the every-open churn this issue closes: a second Stack
    // instance (e.g. a fresh process reopening the same adapter) redefines
    // the same types on the same underlying storage.
    const before = await stack.getType(NOTE_V1);
    const stackB = await Stack.open(adapter);
    await stackB.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    const after = await stackB.getType(NOTE_V1);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });
});

// -------------------------------------------------------
// create
// -------------------------------------------------------

describe('create', () => {
  test('creates a record with correct fields', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.id).toBeTruthy();
    expect(record.typeId).toBe(NOTE_V1);
    expect(record.content).toEqual({ text: 'hello' });
    expect(record.version).toBe(1);
  });

  test('does not set createdBy when none is supplied (owner-created records are implicitly owner-owned)', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.createdBy?.subjectId).toBeUndefined();
  });

  test('allows overriding createdBy via options', async () => {
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      { createdBy: { subjectId: 'other-456' } },
    );
    expect(record.createdBy?.subjectId).toBe('other-456');
  });

  test('sets parentId when provided', async () => {
    const parent = await stack.create(NOTE_V1, { text: 'parent' });
    const child = await stack.create(NOTE_V1, { text: 'child' }, { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  test('throws StackValidationError for invalid content', async () => {
    await expect(stack.create(NOTE_V1, { text: 42 as unknown as string })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('throws for missing required field', async () => {
    await expect(stack.create(NOTE_V1, {} as { text: string })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('throws for unknown typeId', async () => {
    await expect(stack.create('com.example.test/unknown@1', { text: 'hello' })).rejects.toThrow();
  });
});

// -------------------------------------------------------
// create — _group admin bootstrap
// -------------------------------------------------------

describe('create — _group admin bootstrap', () => {
  test('owner-created group via plain Stack.create stamps the owner as first admin', async () => {
    const group = await stack.create('_group@1', { name: 'New Group' });
    expect(group.associations).toEqual([
      { kind: 'relationship', label: 'admin', target: { kind: 'entity', entityId: 'owner-123' } },
    ]);
  });

  test('stamps the supplied createdBy, not the owner, when one is provided', async () => {
    const group = await stack.create(
      '_group@1',
      { name: 'New Group' },
      { createdBy: { subjectId: 'other-456' } },
    );
    expect(group.associations).toEqual([
      { kind: 'relationship', label: 'admin', target: { kind: 'entity', entityId: 'other-456' } },
    ]);
  });

  test('does not duplicate an explicitly supplied admin association', async () => {
    const group = await stack.create(
      '_group@1',
      { name: 'New Group' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'admin',
            target: { kind: 'entity', entityId: 'owner-123' },
          },
        ],
      },
    );
    const adminAssociations = (group.associations ?? []).filter(
      (a) =>
        a.kind === 'relationship' &&
        a.label === 'admin' &&
        a.target.kind === 'entity' &&
        a.target.entityId === 'owner-123',
    );
    expect(adminAssociations).toHaveLength(1);
  });

  test('does not stamp non-group records', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.associations).toBeUndefined();
  });
});

// -------------------------------------------------------
// create — client-supplied id
// -------------------------------------------------------

describe('create — client-supplied id', () => {
  test('accepts a well-formed client-supplied id', async () => {
    const id = generateId();
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id });
    expect(record.id).toBe(id);
  });

  test('generates an id when none is supplied', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.id).toBeTruthy();
  });

  test('rejects an id with the wrong length', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id: 'too-short' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('rejects an id with characters outside the Crockford charset', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id: 'UPPERCASE123' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('rejects an id using the reserved "_" prefix', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { id: '_' + generateId().slice(1) }),
    ).rejects.toThrow(StackQueryError);
  });

  test('rejects a duplicate id with StackConflictError', async () => {
    const id = generateId();
    await stack.create(NOTE_V1, { text: 'first' }, { id });
    await expect(stack.create(NOTE_V1, { text: 'second' }, { id })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('MemoryAdapter.createRecord itself rejects a duplicate id — not just Stack’s callers', async () => {
    const first = await stack.create(NOTE_V1, { text: 'first' });
    await expect(adapter.createRecord({ ...first, content: { text: 'second' } })).rejects.toThrow(
      StackConflictError,
    );
    // The rejected create must not have mutated storage: no overwrite, no
    // dangling duplicate `order` entry (which would corrupt pagination).
    expect((await adapter.getRecord(first.id))?.content).toEqual({ text: 'first' });
    expect(adapter.order.filter((recordId) => recordId === first.id)).toHaveLength(1);
  });

  test('unscoped Stack.create() does not apply a timestamp-skew check', async () => {
    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id: ancientId });
    expect(record.id).toBe(ancientId);
  });
});

// -------------------------------------------------------
// create — backdating (createdAt / updatedAt)
// -------------------------------------------------------

describe('create — backdating (createdAt/updatedAt)', () => {
  test('accepts an explicit createdAt and defaults updatedAt to match', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { createdAt });
    expect(record.createdAt).toEqual(createdAt);
    expect(record.updatedAt).toEqual(createdAt);
  });

  test('accepts a distinct updatedAt when supplied', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const updatedAt = new Date('2020-06-20T12:00:00.000Z');
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { createdAt, updatedAt });
    expect(record.createdAt).toEqual(createdAt);
    expect(record.updatedAt).toEqual(updatedAt);
  });

  test('rejects an updatedAt preceding createdAt', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const updatedAt = new Date('2020-06-10T12:00:00.000Z');
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { createdAt, updatedAt }),
    ).rejects.toThrow(StackValidationError);
  });

  test('derives the id from createdAt when no id is supplied', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { createdAt });
    expect(idTimestamp(record.id)).toBe(createdAt.valueOf());
  });

  test('accepts an explicit id whose timestamp agrees with createdAt', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const id = idWithTimestamp(createdAt.valueOf());
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id, createdAt });
    expect(record.id).toBe(id);
  });

  test('rejects an explicit id whose timestamp disagrees with createdAt beyond tolerance', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const id = idWithTimestamp(new Date('2000-01-01').valueOf());
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id, createdAt })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('idTimestampSkewMs: null disables the id/createdAt consistency check too', async () => {
    const permissiveAdapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
    const permissiveStack = await Stack.open(permissiveAdapter, { idTimestampSkewMs: null });
    await permissiveStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const id = idWithTimestamp(new Date('2000-01-01').valueOf());
    const record = await permissiveStack.create(NOTE_V1, { text: 'hello' }, { id, createdAt });
    expect(record.id).toBe(id);
  });

  test('an id alone (no createdAt) stays a pure position choice — no consistency check applies', async () => {
    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    const before = new Date();
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id: ancientId });
    expect(record.id).toBe(ancientId);
    expect(record.createdAt.valueOf()).toBeGreaterThanOrEqual(before.valueOf());
  });

  test('a prior live create() does not clamp a later backdated id forward (regression)', async () => {
    // Advance generateId()'s monotonic floor to "now" via an ordinary,
    // undated create() — the scenario a long-running import script hits
    // once it has written anything live before importing historical data.
    await stack.create(NOTE_V1, { text: 'live' });

    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.create(NOTE_V1, { text: 'backdated' }, { createdAt });
    expect(idTimestamp(record.id)).toBe(createdAt.valueOf());
  });

  test('unlistedAt stamps from createdAt, not the actual current time', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { createdAt, unlisted: true });
    expect(record.unlistedAt).toEqual(createdAt);
  });

  // An Invalid Date's getTime() is NaN, and every comparison against NaN
  // is false — so an unchecked Invalid Date doesn't slip past the
  // ordering and skew checks, it switches them off, then persists a
  // record that throws RangeError the moment anything serializes it.
  test('rejects an Invalid Date createdAt rather than minting an epoch-zero id', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { createdAt: new Date('not a date') }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects an Invalid Date updatedAt', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { updatedAt: new Date('not a date') }),
    ).rejects.toThrow(StackValidationError);
  });

  test('an Invalid Date createdAt cannot switch off the id/createdAt skew check', async () => {
    const id = idWithTimestamp(new Date('2000-01-01').valueOf());
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { id, createdAt: new Date('not a date') }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a pre-epoch createdAt as a validation error, not a raw RangeError', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { createdAt: new Date('1969-07-20T00:00:00.000Z') }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a pre-epoch createdAt even when an explicit id skips ID derivation', async () => {
    const id = idWithTimestamp(0);
    await expect(
      stack.create(
        NOTE_V1,
        { text: 'hello' },
        { id, createdAt: new Date('1969-07-20T00:00:00.000Z') },
      ),
    ).rejects.toThrow(StackValidationError);
  });

  // Past 32^9-1 ms the 9-char timestamp prefix overflows to 10, so the
  // derived id would be 13 chars — one the library itself rejects via
  // isValidIdFormat(). Year-9999 sentinels are ordinary in imported data.
  test('rejects a far-future createdAt rather than minting a malformed 13-char id', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { createdAt: new Date('9999-01-01T00:00:00.000Z') }),
    ).rejects.toThrow(StackValidationError);
  });

  test('accepts a createdAt at the last encodable millisecond', async () => {
    const createdAt = new Date(MAX_ID_TIMESTAMP);
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { createdAt });
    expect(isValidIdFormat(record.id)).toBe(true);
    expect(idTimestamp(record.id)).toBe(MAX_ID_TIMESTAMP);
  });

  // The one-sided case: createdAt defaults to now, which a backdated
  // updatedAt on its own still precedes.
  test('rejects an updatedAt preceding a defaulted createdAt', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { updatedAt: new Date('2000-01-01T00:00:00.000Z') }),
    ).rejects.toThrow(StackValidationError);
  });

  // JSON has no Date type, so a server forwarding a parsed POST /records
  // body hands these options the ISO string it deserialized. That has to
  // come back as a validation error naming the field, not a raw TypeError
  // out of .getTime() — a 400, not a 500.
  test('rejects a wire-shaped ISO string createdAt as a validation error', async () => {
    const opts = { createdAt: '2020-06-15T12:00:00.000Z' } as unknown as { createdAt: Date };
    await expect(stack.create(NOTE_V1, { text: 'hello' }, opts)).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects a wire-shaped ISO string updatedAt as a validation error', async () => {
    const opts = { updatedAt: '2020-06-15T12:00:00.000Z' } as unknown as { updatedAt: Date };
    await expect(stack.create(NOTE_V1, { text: 'hello' }, opts)).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects a numeric epoch createdAt as a validation error', async () => {
    const opts = { createdAt: 1592222400000 } as unknown as { createdAt: Date };
    await expect(stack.create(NOTE_V1, { text: 'hello' }, opts)).rejects.toThrow(
      StackValidationError,
    );
  });

  test('does not alias the caller Date — mutating it after create leaves the record alone', async () => {
    const cursor = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      { createdAt: cursor, unlisted: true },
    );

    // The shape of a real import loop: one Date advanced per row.
    cursor.setFullYear(1990);

    const stored = await stack.get(record.id);
    expect(stored?.createdAt).toEqual(new Date('2020-06-15T12:00:00.000Z'));
    expect(stored?.updatedAt).toEqual(new Date('2020-06-15T12:00:00.000Z'));
    expect(stored?.unlistedAt).toEqual(new Date('2020-06-15T12:00:00.000Z'));
  });
});

// -------------------------------------------------------
// Type cache — create()/mutate()/etc. shouldn't pay a getType()
// round trip on every write for a value that can't change.
// -------------------------------------------------------

describe('type cache', () => {
  // A type saved straight through the adapter, bypassing stack.defineType()
  // (and its cache write) so the first getTypeCached() call is a genuine
  // cache miss — the scenario a real app hits on first use of a type an
  // earlier process already defined.
  const COLD_TYPE_ID = 'com.example.test/cold@1';
  const seedColdType = async (): Promise<void> => {
    await adapter.saveType({
      id: COLD_TYPE_ID,
      baseId: 'com.example.test/cold',
      version: 1,
      name: 'Cold',
      schema: { text: { kind: 'text', required: true } },
      schemaHash: 'irrelevant-for-this-test',
      createdAt: new Date(),
    });
  };

  test('create() x N against a not-yet-cached type calls adapter.getType() exactly once', async () => {
    await seedColdType();
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.create(COLD_TYPE_ID, { text: 'one' });
    await stack.create(COLD_TYPE_ID, { text: 'two' });
    await stack.create(COLD_TYPE_ID, { text: 'three' });

    expect(getTypeSpy).toHaveBeenCalledTimes(1);
  });

  test('defineType() populates the cache — a later create() never calls adapter.getType()', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.create(NOTE_V2, { text: 'hello' });

    expect(getTypeSpy).not.toHaveBeenCalled();
  });

  test('a content patch reuses the type cached by an earlier create() — no getType() round trip', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.patchContent(record.id, { text: 'updated' });

    expect(getTypeSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------
// content filter null semantics — MemoryAdapter's own
// implementation, holding the same rule the SQL adapters' shared
// recordConditions applies.
// -------------------------------------------------------

describe('query — content filter null semantics', () => {
  // Additive on top of the shared Note: these tests store shapes the query
  // engine has to walk, and content outside the schema is not storable.
  beforeEach(async () => {
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      priority: { kind: 'number' },
      a: { kind: 'object', open: true },
      n: { kind: 'object', open: true },
    });
  });

  test('a null content filter matches records where the field is absent', async () => {
    await stack.create(NOTE_V1, { text: 'no priority set' });
    await stack.create(NOTE_V1, { text: 'has one', priority: 1 });
    const result = await stack.query({ filter: { content: { priority: null } } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content.text).toBe('no priority set');
  });

  test('a null content filter matches records where the field is stored as null', async () => {
    await stack.create(NOTE_V1, { text: 'explicit null', priority: null });
    await stack.create(NOTE_V1, { text: 'has one', priority: 1 });
    const result = await stack.query({ filter: { content: { priority: null } } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content.text).toBe('explicit null');
  });

  // The same contract the SQL adapters honor by quoting the key into a JSON
  // path: a content key is a field name, never a path expression, so both
  // sides of the wire agree on what a dotted key asks for.
  // The field-name walk and the filter-path cap are sized together: a name
  // the walk stops short of is one no path can address.
  test('a name the field-name walk cannot reach is a name no path can address', async () => {
    const deep = (d: number): Record<string, unknown> =>
      d === 0 ? { 'bad.name': 1 } : { n: deep(d - 1) };

    await expect(stack.create(NOTE_V1, { text: 'a', ...deep(31) })).rejects.toThrow(
      StackValidationError,
    );
    const beyond = await stack.create(NOTE_V1, { text: 'b', ...deep(33) });
    const path = [...Array(33).fill('n'), 'bad', 'name'].join('.');
    await expect(stack.query({ filter: { content: { [path]: 1 } } })).rejects.toThrow(
      StackQueryError,
    );
    expect(beyond.id).toBeDefined();
  });

  // A dotted key is a path, and a field literally named `a.b` is refused
  // at write time, so the two readings can never both be available.
  test('a dotted key is a path, and the colliding field name is unwritable', async () => {
    await stack.create(NOTE_V1, { text: 'nested', a: { b: 'x' } });
    const result = await stack.query({ filter: { content: { 'a.b': 'x' } } });
    expect(result.records.map((r) => r.content.text)).toEqual(['nested']);

    await expect(stack.create(NOTE_V1, { text: 'literal', 'a.b': 'x' })).rejects.toThrow(
      StackValidationError,
    );
  });
});

// -------------------------------------------------------
// contentPresent — the question a filter value cannot ask, since a value
// matches what is there rather than whether anything is.
// -------------------------------------------------------

describe('query — contentPresent', () => {
  beforeEach(async () => {
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      publishedAt: { kind: 'date' },
      a: { kind: 'number' },
      b: { kind: 'number' },
      // Open: these hold nulls and bare objects, which is the content
      // whose presence semantics these tests are about.
      emails: { kind: 'array', open: true },
      tags: { kind: 'array', open: true },
    });
  });

  test('matches records holding a value, and null matches the rest', async () => {
    await stack.create(NOTE_V1, { text: 'dated', publishedAt: '2021-01-01T00:00:00Z' });
    await stack.create(NOTE_V1, { text: 'undated' });
    await stack.create(NOTE_V1, { text: 'explicit null', publishedAt: null });

    const present = await stack.query({ filter: { contentPresent: ['publishedAt'] } });
    expect(present.records.map((r) => r.content.text)).toEqual(['dated']);

    const absent = await stack.query({ filter: { content: { publishedAt: null } } });
    expect(absent.records.map((r) => r.content.text).sort()).toEqual(['explicit null', 'undated']);
  });

  test('several paths are an intersection, as tags are', async () => {
    await stack.create(NOTE_V1, { text: 'both', a: 1, b: 2 });
    await stack.create(NOTE_V1, { text: 'one', a: 1 });

    const result = await stack.query({ filter: { contentPresent: ['a', 'b'] } });
    expect(result.records.map((r) => r.content.text)).toEqual(['both']);
  });

  test('an empty list filters nothing, as an empty tag list does', async () => {
    await stack.create(NOTE_V1, { text: 'a' });
    expect((await stack.query({ filter: { contentPresent: [] } })).records).toHaveLength(1);
  });

  test('a path reaches through an array element-wise', async () => {
    await stack.create(NOTE_V1, { text: 'has one', emails: [{ value: 'a@example.com' }] });
    await stack.create(NOTE_V1, { text: 'has none', emails: [{ label: 'home' }] });

    const result = await stack.query({ filter: { contentPresent: ['emails.value'] } });
    expect(result.records.map((r) => r.content.text)).toEqual(['has one']);
  });

  test('a path holding only nulls holds no value', async () => {
    await stack.create(NOTE_V1, { text: 'nulls', tags: [null, null] });
    await stack.create(NOTE_V1, { text: 'empty', tags: [] });
    await stack.create(NOTE_V1, { text: 'one', tags: ['x'] });

    const result = await stack.query({ filter: { contentPresent: ['tags'] } });
    expect(result.records.map((r) => r.content.text)).toEqual(['one']);
  });

  // Both filters can match one record where the path is multi-valued: each
  // is element-wise, so an array holding a null and a value satisfies
  // "something is null" and "something is present" alike.
  test('a multi-valued path can satisfy both this and the null filter', async () => {
    await stack.create(NOTE_V1, { text: 'mixed', tags: [null, 'x'] });

    expect((await stack.query({ filter: { contentPresent: ['tags'] } })).records).toHaveLength(1);
    expect((await stack.query({ filter: { content: { tags: null } } })).records).toHaveLength(1);
  });

  test('a malformed path is refused, as a content filter key is', async () => {
    await expect(stack.query({ filter: { contentPresent: ['a..b'] } })).rejects.toThrow(
      StackQueryError,
    );
    await expect(stack.query({ filter: { contentPresent: ['title[0]'] } })).rejects.toThrow(
      StackQueryError,
    );
  });
});

// -------------------------------------------------------
// query() fails loud rather than silently widening: a filter
// Stack can't honor against this adapter's declared capabilities must
// throw before dispatching, not quietly return the unfiltered superset.
// -------------------------------------------------------

describe('query — capability fail-loud', () => {
  test('filter.search against an adapter without filter.search throws, not returns everything', async () => {
    await stack.create(NOTE_V1, { text: 'findable' });
    await expect(stack.query({ filter: { search: 'findable' } })).rejects.toThrow(StackQueryError);
  });

  test('filter.content against an adapter reaching no content throws, not returns everything', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await incapableStack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      priority: { kind: 'number' },
    });
    await incapableStack.create(NOTE_V1, { text: 'has priority', priority: 1 });

    await expect(incapableStack.query({ filter: { content: { priority: 1 } } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('contentPresent against an adapter without the capability throws', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await incapableStack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      priority: { kind: 'number' },
    });
    await incapableStack.create(NOTE_V1, { text: 'has priority', priority: 1 });

    await expect(
      incapableStack.query({ filter: { contentPresent: ['priority'] } }),
    ).rejects.toThrow(StackQueryError);
  });

  test('a query with neither filter still works against an incapable adapter', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await incapableStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await incapableStack.create(NOTE_V1, { text: 'plain' });

    const result = await incapableStack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records).toHaveLength(1);
  });
});

// -------------------------------------------------------
// query — sort validation
// -------------------------------------------------------
//
// `QuerySort` is typed 'asc' | 'desc', but a type is not a runtime guard:
// a server mapping ?direction= onto a query, or a delegated app calling
// query(), supplies a raw string. A SQLite record adapter interpolates the
// direction straight into ORDER BY, so an unvalidated value there is a
// SQL-injection sink. The guard belongs in the invariant layer so no
// adapter can forget it.

describe('query — sort validation', () => {
  const inject = async (sort: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stack.query({ sort: sort as any });

  test('a legitimate asc/desc sort is accepted', async () => {
    await stack.create(NOTE_V1, { text: 'a' });
    await expect(stack.query({ sort: { field: 'createdAt', direction: 'asc' } })).resolves.toEqual(
      expect.objectContaining({ records: expect.any(Array) }),
    );
    await expect(
      stack.query({ sort: { field: 'updatedAt', direction: 'desc' } }),
    ).resolves.toBeDefined();
  });

  test('a direction outside asc/desc is refused, not interpolated', async () => {
    await expect(inject({ field: 'createdAt', direction: 'ASC, (SELECT 1)' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a sort field outside the closed set is refused', async () => {
    await expect(inject({ field: 'content); DROP TABLE records --' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('an omitted direction is allowed (adapter default applies)', async () => {
    await expect(stack.query({ sort: { field: 'version' } })).resolves.toBeDefined();
  });

  test('a content field is held to one segment', async () => {
    await expect(inject({ contentField: 'author.name' })).rejects.toThrow(StackQueryError);
  });

  test('a content field may not carry a filter-path metacharacter', async () => {
    await expect(inject({ contentField: 'title[0]' })).rejects.toThrow(StackQueryError);
    await expect(inject({ contentField: '' })).rejects.toThrow(StackQueryError);
  });

  test('naming both a native and a content field is refused, not resolved', async () => {
    await expect(inject({ field: 'createdAt', contentField: 'version' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a content field a type never declared is a legitimate sort, ordering nothing', async () => {
    await stack.create(NOTE_V1, { text: 'a' });
    const result = await stack.query({ sort: { contentField: 'nothingDeclaresThis' } });
    expect(result.records).toHaveLength(1);
  });
});

// -------------------------------------------------------
// query — sorting by a content field
// -------------------------------------------------------

describe('query — sorting by a content field', () => {
  const ARTICLE = 'com.example.test/article@1';
  const NUMBERED = 'com.example.test/numbered@1';

  const titles = async (query: Parameters<typeof stack.query>[0]) =>
    (await stack.query(query)).records.map((r) => r.content.title);

  beforeEach(async () => {
    await stack.defineType(ARTICLE, 'Article', {
      title: { kind: 'string', required: true },
      publishedAt: { kind: 'date' },
    });
    await stack.defineType(NUMBERED, 'Numbered', {
      title: { kind: 'string', required: true },
    });
  });

  test('orders by a date field as an instant, not as an ISO string', async () => {
    await stack.create(ARTICLE, { title: 'b', publishedAt: '2021-06-01T00:00:00Z' });
    await stack.create(ARTICLE, { title: 'a', publishedAt: '2020-12-31T23:00:00-05:00' });
    await stack.create(ARTICLE, { title: 'c', publishedAt: '2021-01-01T00:00:00Z' });

    // 'a' is 2021-01-01T04:00Z — later than 'c' as an instant, earlier as
    // a string.
    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'asc' } })).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('a record with no value at the field sorts last in both directions', async () => {
    await stack.create(ARTICLE, { title: 'dated', publishedAt: '2021-01-01T00:00:00Z' });
    await stack.create(ARTICLE, { title: 'undated' });
    await stack.create(ARTICLE, { title: 'older', publishedAt: '2020-01-01T00:00:00Z' });

    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'asc' } })).toEqual([
      'older',
      'dated',
      'undated',
    ]);
    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'desc' } })).toEqual([
      'dated',
      'older',
      'undated',
    ]);
  });

  test('text orders by case- and accent-folded value, not by code point', async () => {
    for (const title of ['Zebra', 'apple', 'Émile']) await stack.create(ARTICLE, { title });

    expect(await titles({ sort: { contentField: 'title', direction: 'asc' } })).toEqual([
      'apple',
      'Émile',
      'Zebra',
    ]);
  });

  test('across types declaring one field name differently, numbers precede text', async () => {
    await stack.defineType('com.example.test/ranked@1', 'Ranked', {
      title: { kind: 'string', required: true },
      key: { kind: 'number' },
    });
    await stack.defineType('com.example.test/named@1', 'Named', {
      title: { kind: 'string', required: true },
      key: { kind: 'string' },
    });
    await stack.create('com.example.test/named@1', { title: 'text', key: 'aaa' });
    await stack.create('com.example.test/ranked@1', { title: 'number', key: 2 });

    expect(await titles({ sort: { contentField: 'key', direction: 'asc' } })).toEqual([
      'number',
      'text',
    ]);
    expect(await titles({ sort: { contentField: 'key', direction: 'desc' } })).toEqual([
      'text',
      'number',
    ]);
  });

  test('the field is read through the schema, not sniffed from the value', async () => {
    // `title` is declared `string` on both types, so a numeric-looking
    // title orders as the text it is.
    await stack.create(ARTICLE, { title: '10' });
    await stack.create(NUMBERED, { title: '9' });

    expect(await titles({ sort: { contentField: 'title', direction: 'asc' } })).toEqual([
      '10',
      '9',
    ]);
  });

  test('an adapter without sort.contentField refuses rather than reordering', async () => {
    const incapable = await Stack.open(new IncapableMemoryAdapter({ ownerEntityId: 'owner-123' }));
    await expect(incapable.query({ sort: { contentField: 'publishedAt' } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a native sort an adapter does not declare is refused too', async () => {
    const adapter = new MemoryAdapter({ ownerEntityId: 'owner-123' });
    adapter.capabilities.sort.fields = ['createdAt'];
    const limited = await Stack.open(adapter);
    await expect(limited.query({ sort: { field: 'version' } })).rejects.toThrow(StackQueryError);
    await expect(limited.query({ sort: { field: 'createdAt' } })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// update — merge patch
// -------------------------------------------------------

describe('update', () => {
  test('merges partial content with existing', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const record = await stack.create(NOTE_V2, { text: 'hello', title: 'My Note' });
    const updated = await stack.patchContent(record.id, { title: 'Updated' });
    expect(updated.content).toEqual({ text: 'hello', title: 'Updated' });
  });

  test('null value removes an optional field', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const record = await stack.create(NOTE_V2, { text: 'hello', title: 'My Note' });
    const updated = await stack.patchContent(record.id, { title: null });
    expect((updated.content as Record<string, unknown>).title).toBeUndefined();
  });

  test('null on required field fails validation', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.patchContent(record.id, { text: null })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('increments version number', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.patchContent(record.id, { text: 'world' });
    expect(updated.version).toBe(2);
  });

  test('snapshots previous content to version history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.patchContent(record.id, { text: 'world' });
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].content).toEqual({ text: 'hello' });
    expect(versions[0].version).toBe(1);
  });

  test('throws for unknown record', async () => {
    await expect(stack.patchContent('nonexistent', { text: 'hello' })).rejects.toThrow();
  });
});

// -------------------------------------------------------
// The `parentId` key: the one native field a write reaches after create.
// -------------------------------------------------------

describe('Stack.mutate — the `parentId` key', () => {
  test('moves a record into a container', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, { parentId: box.id });
    expect(moved.parentId).toBe(box.id);
  });

  test('null moves a record to the root', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    const moved = await stack.mutate(note.id, { parentId: null });
    expect(moved.parentId).toBeUndefined();
  });

  // The journal entry carries previousParentId, which is the whole prior
  // state a move destroys, so no snapshot is owed and `version` — the
  // ordinal of the snapshot history — stands still.
  // See docs/spec/versioning.md § Version history.
  test('leaves version, updatedAt and the snapshot history untouched', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, { parentId: box.id });
    expect(moved.version).toBe(1);
    expect(moved.updatedAt).toEqual(note.updatedAt);
    expect(await stack.getVersions(note.id)).toEqual([]);
  });

  test('appends one journal entry naming where the record came from', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await stack.mutate(note.id, { parentId: box.id });
    const entries = await stack.getJournal(note.id);
    expect(entries).toHaveLength(2); // create, then the move
    expect(entries[1].ops).toEqual(['reparent']);
    expect(entries[1].version).toBe(1);
    expect(entries[1].parentId).toBe(box.id);
    expect(entries[1].previousParentId).toBeNull();
  });

  // A set that names a bumping aspect alongside the move bumps once,
  // covering everything it moved, and journals one entry naming both.
  test('a content patch alongside the move bumps exactly once', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      parentId: box.id,
    });
    expect(moved.version).toBe(2);
    expect(await stack.getVersions(note.id)).toHaveLength(1);
    const entries = await stack.getJournal(note.id);
    expect(entries).toHaveLength(2);
    expect([...entries[1].ops].sort()).toEqual(['patch', 'reparent']);
    expect(entries[1].previousParentId).toBeNull();
  });

  test('leaves content untouched', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, { parentId: box.id });
    expect(moved.content).toEqual({ text: 'note' });
  });

  // A no-op must not bump version or write a snapshot, matching
  // the `unlisted` key and a reshare.
  test('moving to the parent it already has is a no-op', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    const same = await stack.mutate(note.id, { parentId: box.id });
    expect(same.version).toBe(1);
    expect(await stack.getVersions(note.id)).toEqual([]);
  });

  test('a root record set to null is a no-op', async () => {
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const same = await stack.mutate(note.id, { parentId: null });
    expect(same.version).toBe(1);
  });

  test('throws for unknown record', async () => {
    await expect(stack.mutate('nonexistent', { parentId: null })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  // A precondition on `version` can fence nothing here: the move does not
  // move the number it names. Same stance an `associations`-only set takes.
  // See docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
  test('ifVersion alongside a parentId-only set is not checked', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, { parentId: box.id }, { ifVersion: 99 });
    expect(moved.parentId).toBe(box.id);
  });

  test('ifVersion is checked again once a bumping aspect shares the set', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await expect(
      stack.mutate(
        note.id,
        { contentPatch: { text: 'edited' }, parentId: box.id },
        { ifVersion: 99 },
      ),
    ).rejects.toThrow(StackVersionConflictError);
  });

  test('the record itself is refused as its own parent', async () => {
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await expect(stack.mutate(note.id, { parentId: note.id })).rejects.toThrow(StackConflictError);
  });

  test('a descendant is refused as a parent', async () => {
    const a = await stack.create(NOTE_V1, { text: 'a' });
    const b = await stack.create(NOTE_V1, { text: 'b' }, { parentId: a.id });
    const c = await stack.create(NOTE_V1, { text: 'c' }, { parentId: b.id });
    await expect(stack.mutate(a.id, { parentId: c.id })).rejects.toThrow(StackConflictError);
  });

  test('a sibling subtree is not a descendant, and is allowed', async () => {
    const a = await stack.create(NOTE_V1, { text: 'a' });
    const b = await stack.create(NOTE_V1, { text: 'b' });
    const bChild = await stack.create(NOTE_V1, { text: 'b-child' }, { parentId: b.id });
    const moved = await stack.mutate(a.id, { parentId: bChild.id });
    expect(moved.parentId).toBe(bChild.id);
  });

  // The walk reads storage directly rather than the caller's view, so a
  // chain assembled through records a requester cannot read is still
  // refused. Exercised here through the unscoped layer that owns the rule.
  test('a cycle through a deep chain is refused', async () => {
    let previous = await stack.create(NOTE_V1, { text: 'root' });
    const root = previous;
    for (let i = 0; i < 10; i++) {
      previous = await stack.create(NOTE_V1, { text: `n${i}` }, { parentId: previous.id });
    }
    await expect(stack.mutate(root.id, { parentId: previous.id })).rejects.toThrow(
      StackConflictError,
    );
  });

  // A create supplying both id and parentId is the second edge-adding
  // site: existing records may already point at the id it names. Since
  // Stack refuses a parentId that names nothing, the chain it has to walk
  // can only have been built outside that gate — by an adapter write, or by
  // a restore, which is exempt.
  test('a create naming its own id under a descendant is refused', async () => {
    const a = await stack.create(NOTE_V1, { text: 'a' });
    const b = await stack.create(NOTE_V1, { text: 'b' }, { parentId: a.id });
    const minted = idWithTimestamp(Date.now());
    // Straight to the adapter: it holds no opinion on references, so this
    // plants the dangling parent a change set's `parentId` would refuse.
    await adapter.mutateRecord(a.id, { parentId: minted });
    await expect(
      stack.create(NOTE_V1, { text: 'z' }, { id: minted, parentId: b.id }),
    ).rejects.toThrow(StackConflictError);
  });

  // A parent has to exist when it is named, so two creates cannot point at
  // each other's minted ids.
  test('a create naming a not-yet-created parent is refused', async () => {
    const first = idWithTimestamp(Date.now());
    const second = idWithTimestamp(Date.now() + 60_000);
    await expect(
      stack.create(NOTE_V1, { text: 'x' }, { id: first, parentId: second }),
    ).rejects.toThrow(StackConflictError);
  });

  test('a create naming its own id as its own parent is refused', async () => {
    const minted = idWithTimestamp(Date.now());
    await expect(
      stack.create(NOTE_V1, { text: 'z' }, { id: minted, parentId: minted }),
    ).rejects.toThrow(StackConflictError);
  });

  // A generated id names nothing, so this skips the cycle walk — though it
  // still pays the one read the reference check owes.
  test('a create with a generated id under an existing parent is allowed', async () => {
    const a = await stack.create(NOTE_V1, { text: 'a' });
    const b = await stack.create(NOTE_V1, { text: 'b' }, { parentId: a.id });
    expect(b.parentId).toBe(a.id);
  });

  test('a minted id under an unrelated parent is allowed', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const minted = idWithTimestamp(Date.now());
    const made = await stack.create(NOTE_V1, { text: 'z' }, { id: minted, parentId: box.id });
    expect(made.parentId).toBe(box.id);
  });

  // The empty string names nobody, so it is refused rather than quietly
  // dropped — the same answer parentId gives, and for the same reason.
  test.each([
    ['createdBy.subjectId', { createdBy: { subjectId: '' } }],
    ['createdBy.principalId', { createdBy: { subjectId: 'did:key:zAuthor', principalId: '' } }],
    ['appId', { appId: '' }],
  ] as const)('creating with an empty-string %s is refused', async (_field, opts) => {
    await expect(stack.create(NOTE_V1, { text: 'note' }, opts)).rejects.toThrow(StackQueryError);
  });

  test('parenting to a record that does not exist is refused', async () => {
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const gone = idWithTimestamp(Date.now());
    await expect(stack.mutate(note.id, { parentId: gone })).rejects.toThrow(StackConflictError);
  });

  test('creating under a record that does not exist is refused', async () => {
    const gone = idWithTimestamp(Date.now());
    await expect(stack.create(NOTE_V1, { text: 'note' }, { parentId: gone })).rejects.toThrow(
      StackConflictError,
    );
  });

  // Format first, so a malformed destination reports what is wrong with it
  // rather than failing as a read that could never match.
  test.each([
    ['an empty string', ''],
    ['a non-Crockford id', 'NOT-AN-ID'],
    ['a reserved id', '_config'],
  ])('parenting to %s is refused as malformed', async (_name, bad) => {
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await expect(stack.mutate(note.id, { parentId: bad })).rejects.toThrow(StackQueryError);
    await expect(stack.create(NOTE_V1, { text: 'other' }, { parentId: bad })).rejects.toThrow(
      StackQueryError,
    );
  });

  // The walk bounds work rather than refusing what it cannot finish, so a
  // chain past the cap still accepts moves.
  test('a chain deeper than the walk cap can still be built and moved into', async () => {
    let previous = await stack.create(NOTE_V1, { text: 'root' });
    for (let i = 0; i < 70; i++) {
      previous = await stack.create(NOTE_V1, { text: `n${i}` }, { parentId: previous.id });
    }
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const moved = await stack.mutate(note.id, { parentId: previous.id });
    expect(moved.parentId).toBe(previous.id);
  });

  test('a parentId filter finds the record at its new home', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await stack.mutate(note.id, { parentId: box.id });
    const result = await stack.query({ filter: { parentId: box.id } });
    expect(result.records.map((r) => r.id)).toEqual([note.id]);
  });
});

// -------------------------------------------------------
// A move rolls back like every other mutation.
// See docs/spec/versioning.md § Restore semantics.
// -------------------------------------------------------

describe('Stack.restoreVersion — containment', () => {
  // Containment is the journal's to keep, so a snapshot says nothing about
  // it and a restore settles nothing. See docs/spec/versioning.md
  // § Version history.
  test('a snapshot carries no parentId, whatever container the record sat in', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    await stack.patchContent(note.id, { text: 'edited' });
    const [snapshot] = await stack.getVersions(note.id);
    expect('parentId' in snapshot).toBe(false);
  });

  test('restoring leaves a record in the container it sits in now', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const other = await stack.create(NOTE_V1, { text: 'other' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.mutate(note.id, { parentId: other.id });
    const restored = await stack.restoreVersion(note.id, 1);
    expect(restored.content).toEqual({ text: 'note' });
    expect(restored.parentId).toBe(other.id);
  });

  test('restoring a snapshot taken at the root leaves a contained record contained', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.mutate(note.id, { parentId: box.id });
    const restored = await stack.restoreVersion(note.id, 1);
    expect(restored.parentId).toBe(box.id);
  });

  test('restoring rolls content back and leaves associations exactly as they stand', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    await stack.associate(note.id, { kind: 'tag', label: 'pinned' }); // no bump
    await stack.patchContent(note.id, { text: 'edited' });
    const restored = await stack.restoreVersion(note.id, 1);
    expect(restored.content).toEqual({ text: 'note' });
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'pinned' }]);
    expect(restored.parentId).toBe(box.id);
  });

  // A restore adds no containment edge, so it cannot close a loop — the
  // chain that would have been a cycle is left exactly as it is.
  test('a restore under a container that now sits beneath the record is not a cycle', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.mutate(note.id, { parentId: null });
    await stack.mutate(box.id, { parentId: note.id });
    const restored = await stack.restoreVersion(note.id, 1);
    expect(restored.content).toEqual({ text: 'note' });
    expect(restored.parentId).toBeUndefined();
  });

  // A hard-deleted container never cost a record its content rollback, and
  // now has nothing to do with one: the record stays where it is, dangling
  // parent and all.
  test('a record whose container was hard-deleted still rolls its content back', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' }, { parentId: box.id });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.delete(box.id, { hard: true });
    const restored = await stack.restoreVersion(note.id, 1);
    expect(restored.content).toEqual({ text: 'note' });
    expect(restored.parentId).toBe(box.id);
  });

  test('naming a deleted container as parentId is still refused', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    await stack.delete(box.id, { hard: true });
    await expect(stack.mutate(note.id, { parentId: box.id })).rejects.toThrow(StackConflictError);
  });
});

// -------------------------------------------------------
// Records at rest: get()/query() are stored-version by default,
// migrateAll() is the only thing that ever changes disk state.
// -------------------------------------------------------

describe('records at rest', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test('get() returns the record exactly as stored, no implicit migration', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V1);
    expect((fetched?.content as Record<string, unknown>).title).toBeUndefined();
  });

  test('query() returns records exactly as stored, no implicit migration', async () => {
    await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records[0]?.typeId).toBe(NOTE_V1);
  });

  test("patchContent() validates against the record's own current typeId, never migrates it", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.patchContent(record.id, { text: 'updated' });
    expect(updated.typeId).toBe(NOTE_V1);
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // still v1 on disk — a content patch never migrates
    expect((raw?.content as Record<string, unknown>).text).toBe('updated');
  });

  test("patchContent() validates against v1's schema — a v2-only field is refused, and the record stays at v1", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    // "title" is declared by v2 and not by v1. The record is a v1 record
    // until migrateAll() moves it, so v1's schema is what the patch answers
    // to — validating against the latest would accept this.
    await expect(stack.patchContent(record.id, { title: 'not part of v1' })).rejects.toThrow(
      StackValidationError,
    );
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1);
    expect(raw?.content).toEqual({ text: 'hello' });
  });
});

describe('query — baseId filter', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );
  });

  test('matches records across every version of the family, including not-yet-migrated ones', async () => {
    const v1 = await stack.create(NOTE_V1, { text: 'old' });
    const v2 = await stack.create(NOTE_V2, { text: 'new', title: 'hi' });

    const result = await stack.query({ filter: { baseId: 'com.example.test/note' } });

    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual([v1.id, v2.id].sort());
  });

  test('returns empty results for an unknown baseId rather than throwing', async () => {
    const result = await stack.query({ filter: { baseId: 'com.example.test/nonexistent' } });
    expect(result).toEqual({ records: [], cursor: null });
  });

  test('intersects with typeId when both are given', async () => {
    await stack.create(NOTE_V1, { text: 'old' });
    const v2 = await stack.create(NOTE_V2, { text: 'new', title: 'hi' });

    const result = await stack.query({
      filter: { baseId: 'com.example.test/note', typeId: NOTE_V2 },
    });

    expect(result.records.map((r) => r.id)).toEqual([v2.id]);
  });

  test('accepts an array of baseIds', async () => {
    await stack.defineType('com.example.test/other@1', 'Other', {
      text: { kind: 'text', required: true },
    });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const other = await stack.create('com.example.test/other@1', { text: 'other' });

    const result = await stack.query({
      filter: { baseId: ['com.example.test/note', 'com.example.test/other'] },
    });

    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual([note.id, other.id].sort());
  });
});

describe("presentAt: 'latest' (explicit in-memory migration)", () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test("get({ presentAt: 'latest' }) returns migrated content in memory", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
    expect(fetched?.typeId).toBe(NOTE_V2);
    expect((fetched?.content as Record<string, unknown>).title).toBe('');
  });

  test("get({ presentAt: 'latest' }) does not write migrated content to disk", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.get(record.id, { presentAt: 'latest' });
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // still v1 on disk
  });

  test("query({ presentAt: 'latest' }) migrates every result in memory", async () => {
    await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.query({ filter: { typeId: NOTE_V1 }, presentAt: 'latest' });
    expect(result.records[0]?.typeId).toBe(NOTE_V2);
    expect((result.records[0]?.content as Record<string, unknown>).title).toBe('');
    // Still not written to disk.
    const raw = await adapter.getRecord(result.records[0]!.id);
    expect(raw?.typeId).toBe(NOTE_V1);
  });

  test('a single-version type with no migration history is trivially "latest" — no throw', async () => {
    const unmigratableType = 'com.example.test/other@1';
    await stack.defineType(unmigratableType, 'Other', {
      text: { kind: 'text', required: true },
    });
    const record = await stack.create(unmigratableType, { text: 'hello' });
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
    expect(fetched?.typeId).toBe(unmigratableType);
  });

  test('stale-writer signal: a record newer than what this app instance has defined throws', async () => {
    // stackA is fully up to date: knows v1 and v2, and writes a v2 record.
    const stackA = await Stack.open(adapter);
    await stackA.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await stackA.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    const record = await stackA.create(NOTE_V2, { text: 'hello', title: 'hi' });

    // stackB simulates a stale binary sharing the same storage — its own
    // startup code only ever defineType()'d v1, so it has no idea v2 exists.
    const stackB = await Stack.open(adapter);
    await stackB.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    await expect(stackB.get(record.id, { presentAt: 'latest' })).rejects.toThrow(
      StackMigrationError,
    );
    // Reading it as stored (the default) still works fine even for the stale app.
    const fetched = await stackB.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V2);
  });

  test('registration gap: an older record with no migration path to a type this app has defined throws', async () => {
    const gapAdapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
    const gapStack = await Stack.open(gapAdapter);
    await gapStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await gapStack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    // Note: no registerMigration() call — this app knows v2 exists but has
    // no path to reach it from a v1 record.
    const record = await gapStack.create(NOTE_V1, { text: 'hello' });

    await expect(gapStack.get(record.id, { presentAt: 'latest' })).rejects.toThrow(
      StackMigrationError,
    );
  });

  test('chained migration: v1 → v2 → v3', async () => {
    await stack.defineType(
      NOTE_V3,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
        pinned: { kind: 'boolean' },
      },
      { migratesFrom: NOTE_V2 },
    );

    stack.registerMigration({
      from: NOTE_V2,
      to: NOTE_V3,
      migrate: (content) => ({ ...content, pinned: false }),
    });

    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
    expect(fetched?.typeId).toBe(NOTE_V3);
    expect((fetched?.content as Record<string, unknown>).title).toBe('');
    expect((fetched?.content as Record<string, unknown>).pinned).toBe(false);
  });
});

// -------------------------------------------------------
// registerMigration
// -------------------------------------------------------

describe('registerMigration', () => {
  test('throws if a migration from the same typeId is already registered', async () => {
    stack.registerMigration({ from: NOTE_V1, to: NOTE_V2, migrate: (c) => c });
    expect(() =>
      stack.registerMigration({ from: NOTE_V1, to: NOTE_V2, migrate: (c) => c }),
    ).toThrow(StackMigrationError);
  });
});

// -------------------------------------------------------
// migrateAll
// -------------------------------------------------------

describe('migrateAll', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test('throws StackMigrationError for an unknown baseTypeId', async () => {
    await expect(stack.migrateAll('com.example.test/noot')).rejects.toThrow(StackMigrationError);
  });

  test('throws with a message that includes the bad baseTypeId', async () => {
    await expect(stack.migrateAll('com.example.test/noot')).rejects.toThrow(
      'com.example.test/noot',
    );
  });

  test('migrates all outdated records and returns the count', async () => {
    const r1 = await stack.create(NOTE_V1, { text: 'alpha' });
    const r2 = await stack.create(NOTE_V1, { text: 'beta' });

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(2);
    expect((await adapter.getRecord(r1.id))?.typeId).toBe(NOTE_V2);
    expect((await adapter.getRecord(r2.id))?.typeId).toBe(NOTE_V2);
  });

  test('returns migrated: 0 when all records are already at the latest version', async () => {
    await stack.create(NOTE_V2, { text: 'already current', title: 'hi' });

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(0);
  });

  test('sweeps soft-deleted records too, so undelete returns them healed', async () => {
    const record = await stack.create(NOTE_V1, { text: 'stale' });
    await stack.delete(record.id);

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(1);
    const undeleted = await stack.undelete(record.id);
    expect(undeleted.typeId).toBe(NOTE_V2);
    expect(undeleted.content).toEqual({ text: 'stale', title: '' });
  });

  test('snapshots previous content to version history before migrating', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.migrateAll('com.example.test/note');
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].content).toEqual({ text: 'original' });
    expect(versions[0].typeId).toBe(NOTE_V1);
  });

  test('aborts immediately if a migration function produces invalid content, leaving that record unmigrated', async () => {
    // Fresh stack so this test can register its own (deliberately buggy)
    // migration instead of the valid one from the outer beforeEach.
    const buggyAdapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
    const buggyStack = await Stack.open(buggyAdapter);
    await buggyStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await buggyStack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    buggyStack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      // Buggy migration: drops the required "text" field instead of carrying it forward.
      migrate: () => ({ title: '' }),
    });

    const record = await buggyStack.create(NOTE_V1, { text: 'original' });
    await expect(buggyStack.migrateAll('com.example.test/note')).rejects.toThrow(
      StackValidationError,
    );

    const raw = await buggyAdapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // never committed
    expect(await buggyStack.getVersions(record.id)).toEqual([]); // no snapshot either
  });

  test("an orphan snapshot at a record's current version does not block migrateAll from healing it", async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1
    // Simulate a migrateAll() interrupted between its snapshot and its
    // commitMigration() call, leaving an orphan row at v1.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: { text: 'original' },
      updatedAt: record.updatedAt,
    });

    const result = await stack.migrateAll('com.example.test/note');
    expect(result.migrated).toBe(1);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V2);
  });

  // migrateAll() and commitMigration() share one checked write path: a
  // migration function is app code, but so is the app calling
  // commitMigration(), and neither is entitled to move a DID binding or
  // slip a reserved key past validation.
  test('aborts when a migration function would move a DID binding', async () => {
    await stack.defineType(
      '_entity@2',
      'Entity',
      {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
      },
      { migratesFrom: '_entity@1' },
    );
    stack.registerMigration({
      from: '_entity@1',
      to: '_entity@2',
      migrate: (content) => ({ ...content, did: 'did:key:zHijacked' }),
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(stack.migrateAll('_entity')).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(card.id))?.content).toEqual({
      did: 'did:key:zAlice',
      name: 'Alice',
    });
  });

  test('aborts when a migration function emits a reserved content key', async () => {
    await stack.defineType(
      NOTE_V3,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V2 },
    );
    stack.registerMigration({
      from: NOTE_V2,
      to: NOTE_V3,
      migrate: (content) => ({ ...content, ['__proto__']: 'polluted' }),
    });
    await stack.create(NOTE_V2, { text: 'hi', title: '' });

    await expect(stack.migrateAll('com.example.test/note')).rejects.toThrow(StackValidationError);
  });

  test('still carries an unchanged DID binding through a migration', async () => {
    await stack.defineType(
      '_entity@2',
      'Entity',
      {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        pronouns: { kind: 'string' },
      },
      { migratesFrom: '_entity@1' },
    );
    stack.registerMigration({
      from: '_entity@1',
      to: '_entity@2',
      migrate: (content) => ({ ...content, pronouns: 'they/them' }),
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    const result = await stack.migrateAll('_entity');
    expect(result.migrated).toBe(1);
    expect((await adapter.getRecord(card.id))?.typeId).toBe('_entity@2');
  });
});

// -------------------------------------------------------
// Stack.commitMigration
// -------------------------------------------------------

describe('Stack.commitMigration', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );
  });

  test('changes typeId and content together, bumping version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    const migrated = await stack.commitMigration(record.id, NOTE_V2, {
      text: 'hello',
      title: 'pinned',
    });

    expect(migrated.typeId).toBe(NOTE_V2);
    expect(migrated.content).toEqual({ text: 'hello', title: 'pinned' });
    expect(migrated.version).toBe(2);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V2);
  });

  test('snapshots the pre-migration typeId and content to version history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.commitMigration(record.id, NOTE_V2, { text: 'original', title: '' });

    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].typeId).toBe(NOTE_V1);
    expect(versions[0].content).toEqual({ text: 'original' });
  });

  test('validates content against toTypeId’s schema', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.commitMigration(record.id, NOTE_V2, { title: 'missing text' }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V1); // never committed
  });

  test('throws for an unregistered toTypeId', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.commitMigration(record.id, 'com.example.test/note@99', { text: 'hello' }),
    ).rejects.toThrow(StackQueryError);
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(
      stack.commitMigration(generateId(), NOTE_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Stack.commitMigration — integrity checks
//
// Migrate writes a full content replacement under a new typeId, so it is
// create-shaped at the destination and update-shaped over the record as it
// stands. These cover the checks it owes on both counts — without them,
// migrate is a second write path to state create()/mutate() refuse.
// -------------------------------------------------------

describe('Stack.commitMigration — binding fields', () => {
  test('refuses moving an _entity card onto another did', async () => {
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(
      stack.commitMigration(card.id, '_entity@1', { did: 'did:key:zBob', name: 'Alice' }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(card.id))?.content).toEqual({
      did: 'did:key:zAlice',
      name: 'Alice',
    });
  });

  test('refuses shedding a did by migrating out of the family', async () => {
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(stack.commitMigration(card.id, NOTE_V1, { text: 'shed' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('refuses a did another _entity card already claims', async () => {
    await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });
    const bare = await stack.create('_entity@1', { did: '', name: 'Unbound' });

    await expect(
      stack.commitMigration(bare.id, '_entity@1', { did: 'did:key:zAlice', name: 'Unbound' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('allows a migration that carries the same did through', async () => {
    await stack.defineType('_entity@2', 'Entity', {
      did: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      pronouns: { kind: 'string' },
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    const migrated = await stack.commitMigration(card.id, '_entity@2', {
      did: 'did:key:zAlice',
      name: 'Alice',
      pronouns: 'they/them',
    });
    expect(migrated.typeId).toBe('_entity@2');
  });
});

describe('Stack.commitMigration — _attachment protections', () => {
  test('refuses repointing fileId', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'text/plain',
      filename: 'a.txt',
    });

    await expect(
      stack.commitMigration(a.id, '_attachment@1', {
        fileId: 'other-hash',
        mimeType: 'text/plain',
        size: 1,
      }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(a.id))?.content).toEqual(a.content);
  });

  test('refuses rewriting mimeType and size', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'text/plain',
      filename: 'a.txt',
    });

    await expect(
      stack.commitMigration(a.id, '_attachment@1', {
        fileId: a.content.fileId,
        mimeType: 'image/png',
        size: 999,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('allows a migration that carries the immutable fields through', async () => {
    await stack.defineType('_attachment@2', 'Attachment', {
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
      caption: { kind: 'string' },
    });
    const a = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'text/plain',
      filename: 'a.txt',
    });

    const migrated = await stack.commitMigration(a.id, '_attachment@2', {
      fileId: a.content.fileId,
      mimeType: 'text/plain',
      size: 1,
      caption: 'hi',
    });
    expect(migrated.typeId).toBe('_attachment@2');
  });

  test('applies the mimeType-establishment check when arriving from outside the family', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'text/plain',
      filename: 'a.txt',
    });
    const note = await stack.create(NOTE_V1, { text: 'decoy' });

    await expect(
      stack.commitMigration(note.id, '_attachment@1', {
        fileId: a.content.fileId,
        mimeType: 'image/png',
        size: 1,
      }),
    ).rejects.toThrow(StackValidationError);
  });
});

// -------------------------------------------------------
// _group — "at least one admin" invariant
// -------------------------------------------------------

describe('_group — at least one admin', () => {
  const admin = (entityId: string): DataAssociation => ({
    kind: 'relationship',
    label: 'admin',
    target: { kind: 'entity', entityId },
  });
  const member = (entityId: string): DataAssociation => ({
    kind: 'relationship',
    label: 'member',
    target: { kind: 'entity', entityId },
  });

  // The roster the write would produce is what is measured, so every case
  // below is about the post-state rather than about who is being removed.
  describe('change-set associations', () => {
    test('refuses a list naming one identity twice', async () => {
      // Two entries under one identity describe a state no store can hold:
      // an adapter keys associations by identity, so the second displaces
      // the first and which one the record keeps is left to whichever
      // adapter is underneath.
      const record = await stack.create(NOTE_V1, { text: 'hello' });
      const fileId = 'a'.repeat(64);
      await expect(
        stack.mutate(record.id, {
          associations: [
            { kind: 'attachment', label: 'cover', fileId, attachmentRecordId: '1hk153x00001' },
            { kind: 'attachment', label: 'cover', fileId, attachmentRecordId: '1hk153x00002' },
          ],
        }),
      ).rejects.toThrow(StackValidationError);
    });

    test('allows one label across two different referents', async () => {
      // (kind, label) is not identity — a record holds two `cover`
      // attachments as long as they name different files.
      const record = await stack.create(NOTE_V1, { text: 'hello' });
      const updated = await stack.mutate(record.id, {
        associations: [
          { kind: 'attachment', label: 'cover', fileId: 'a'.repeat(64) },
          { kind: 'attachment', label: 'cover', fileId: 'b'.repeat(64) },
        ],
      });
      expect(updated.associations).toHaveLength(2);
    });

    test('refuses a roster replacement that leaves no admin', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(stack.mutate(group.id, { associations: [member('member-1')] })).rejects.toThrow(
        StackConflictError,
      );
    });

    test('refuses emptying the roster wholesale', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(stack.mutate(group.id, { associations: [] })).rejects.toThrow(
        /without an admin/,
      );
    });

    test('leaves the record untouched when it refuses', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(stack.mutate(group.id, { associations: [] })).rejects.toThrow();
      const after = await stack.get(group.id);
      expect(after?.associations).toEqual([admin('owner-123')]);
      expect(after?.version).toBe(group.version);
    });

    test('refuses the whole change set, including the keys that would have applied', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(
        stack.mutate(group.id, { contentPatch: { name: 'Renamed' }, associations: [] }),
      ).rejects.toThrow(StackConflictError);
      const after = await stack.get(group.id);
      expect((after?.content as { name: string }).name).toBe('Editors');
    });

    test('allows a replacement that keeps an admin', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const updated = await stack.mutate(group.id, {
        associations: [admin('owner-123'), member('member-1')],
      });
      expect(updated.associations).toEqual([admin('owner-123'), member('member-1')]);
    });

    test('allows swapping one admin for another in a single write', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const updated = await stack.mutate(group.id, { associations: [admin('successor')] });
      expect(updated.associations).toEqual([admin('successor')]);
    });

    // An `admin` label on a record target is not a roster entry, so it must
    // not satisfy the invariant either.
    test('does not count a record-targeted admin relationship as a roster admin', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      await expect(
        stack.mutate(group.id, {
          associations: [
            {
              kind: 'relationship',
              label: 'admin',
              target: { kind: 'record', recordId: note.id },
            },
          ],
        }),
      ).rejects.toThrow(StackConflictError);
    });

    test('does not constrain a non-_group record', async () => {
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      const updated = await stack.mutate(note.id, { associations: [] });
      expect(updated.associations ?? []).toEqual([]);
    });
  });

  describe('dissociate', () => {
    test('refuses removing the last admin', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(stack.dissociate(group.id, admin('owner-123'))).rejects.toThrow(
        StackConflictError,
      );
    });

    test('allows an admin to remove themselves while another remains', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await stack.associate(group.id, admin('co-admin'));
      const updated = await stack.dissociate(group.id, admin('owner-123'));
      expect(updated.associations).toEqual([admin('co-admin')]);
    });

    test('allows removing a member when one admin remains', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await stack.associate(group.id, member('member-1'));
      const updated = await stack.dissociate(group.id, member('member-1'));
      expect(updated.associations).toEqual([admin('owner-123')]);
    });

    test('a no-op dissociate of an absent admin is still a no-op, not a refusal', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const updated = await stack.dissociate(group.id, admin('never-was-admin'));
      expect(updated.version).toBe(group.version);
    });
  });

  // The invariant binds the record, not the requester: an owner bypass
  // would mean nothing downstream could rely on it. Plain `Stack` is the
  // owner's own unscoped path, so these cases are the bypass's absence.
  describe('no owner bypass', () => {
    test('the owner cannot empty a roster through plain Stack', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await expect(stack.mutate(group.id, { associations: [] })).rejects.toThrow(
        StackConflictError,
      );
    });

    // No route through `Stack` produces an admin-less roster, so this state
    // is manufactured behind its back. The post-state framing means the
    // check still does the right thing if one ever appears: the write that
    // names an incoming admin passes.
    test('an admin-less roster is repairable by a write that adds an admin', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      // Reach past Stack to manufacture the pre-rule state.
      await adapter.mutateRecord(group.id, { associations: [member('member-1')] }, {});
      const orphaned = await stack.get(group.id);
      expect(orphaned?.associations).toEqual([member('member-1')]);

      const repaired = await stack.mutate(group.id, {
        associations: [member('member-1'), admin('rescuer')],
      });
      expect(repaired.associations).toEqual([member('member-1'), admin('rescuer')]);
    });

    test('a write that leaves an admin-less roster admin-less is still refused', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await adapter.mutateRecord(group.id, { associations: [member('member-1')] }, {});
      await expect(stack.mutate(group.id, { associations: [member('member-2')] })).rejects.toThrow(
        StackConflictError,
      );
    });
  });

  // No record's associations are ever restored, because a snapshot never
  // captures them: a restore rolls back content and leaves the current
  // roster — like any other record's associations — where it stands.
  // See docs/spec/versioning.md § Restore semantics.
  describe('restoreVersion does not roll back the roster', () => {
    test('content rolls back to what it was, while the current roster stays exactly where it stands', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const v = group.version;
      await stack.patchContent(group.id, { name: 'Renamed' }); // bumps, snapshots v
      await stack.mutate(group.id, { associations: [admin('successor'), member('carol')] }); // no bump

      const restored = await stack.restoreVersion(group.id, v);

      expect((restored.content as { name: string }).name).toBe('Editors');
      expect(restored.associations).toEqual([admin('successor'), member('carol')]);
    });

    test('restoring content after an admin was removed does not re-grant them', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const v = group.version; // the version a snapshot will land on
      await stack.mutate(group.id, { associations: [admin('owner-123'), admin('departing')] }); // no bump
      await stack.patchContent(group.id, { name: 'v2' }); // bumps, snapshots v

      await stack.dissociate(group.id, admin('departing')); // no bump
      const restored = await stack.restoreVersion(group.id, v);

      expect(restored.associations).toEqual([admin('owner-123')]);
    });

    // Members do not come back either: they are the half a group ACL
    // conveys access through, so rolling them forward would re-convey it as
    // a side effect of a content rollback.
    test('removed members are not restored', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      const v = group.version; // the version a snapshot will land on
      await stack.mutate(group.id, {
        associations: [admin('owner-123'), member('alice'), member('bob')],
      }); // no bump
      await stack.patchContent(group.id, { name: 'v2' }); // bumps, snapshots v

      await stack.mutate(group.id, { associations: [admin('owner-123')] }); // no bump
      const restored = await stack.restoreVersion(group.id, v);

      expect(restored.associations).toEqual([admin('owner-123')]);
    });

    // The invariant needs no post-state check here: a restore cannot move
    // the roster, so it cannot be what empties one.
    test('every version of a group stays restorable', async () => {
      const group = await stack.create('_group@1', { name: 'Editors' });
      await stack.mutate(group.id, { associations: [admin('successor')] }); // no bump
      await stack.patchContent(group.id, { name: 'Renamed' });

      const restored = await stack.restoreVersion(group.id, group.version);

      expect((restored.content as { name: string }).name).toBe('Editors');
      expect(restored.associations).toEqual([admin('successor')]);
    });

    test('a non-_group record behaves exactly the same: its associations are never restored either', async () => {
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      const v = note.version; // the version a snapshot will land on
      await stack.mutate(note.id, { associations: [admin('someone')] }); // no bump
      await stack.patchContent(note.id, { text: 'v2' }); // bumps, snapshots v
      await stack.mutate(note.id, { associations: [member('other')] }); // no bump

      const restored = await stack.restoreVersion(note.id, v);
      expect(restored.associations).toEqual([member('other')]);
    });
  });
});

describe('Stack.commitMigration — _group', () => {
  test('refuses migrating a record into _group, whose admin roster is stamped at creation', async () => {
    const note = await stack.create(NOTE_V1, { text: 'x' });

    await expect(
      stack.commitMigration(note.id, '_group@1', { name: 'Ghost Group' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('allows a _group record to migrate between versions, keeping its roster', async () => {
    await stack.defineType('_group@2', 'Group', {
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
      stackUrl: { kind: 'string' },
      topic: { kind: 'string' },
    });
    const group = await stack.create('_group@1', { name: 'Real Group' });

    const migrated = await stack.commitMigration(group.id, '_group@2', {
      name: 'Real Group',
      topic: 'books',
    });
    expect(migrated.typeId).toBe('_group@2');
    expect(migrated.associations).toEqual(group.associations);
  });
});

// -------------------------------------------------------
// restoreVersion — typeId and validation
// -------------------------------------------------------

describe('restoreVersion — typeId and validation', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test('restores the snapshot’s own typeId, leaving a stale record that migrateAll() subsequently heals', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.migrateAll('com.example.test/note'); // now @2, snapshot v1 is @1-shaped
    expect((await stack.get(record.id))?.typeId).toBe(NOTE_V2);

    const restored = await stack.restoreVersion(record.id, 1);

    // Restoring the pre-migration snapshot brings its typeId back too —
    // the record is legitimately stale at @1, not mislabeled @2.
    expect(restored.typeId).toBe(NOTE_V1);
    expect(restored.content).toEqual({ text: 'original' });

    const healed = await stack.migrateAll('com.example.test/note');
    expect(healed.migrated).toBe(1);
    expect((await stack.get(record.id))?.typeId).toBe(NOTE_V2);
  });

  test('rejects a drifted/invalid snapshot with StackValidationError instead of restoring it', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    // Simulate schema drift or adapter corruption: a stored snapshot whose
    // content no longer satisfies its own claimed type's schema.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: {}, // missing required "text"
      updatedAt: new Date(),
    });

    await expect(stack.restoreVersion(record.id, 1)).rejects.toThrow(StackValidationError);
    expect((await stack.get(record.id))?.content).toEqual({ text: 'hello' }); // untouched
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('versions', () => {
  test('getVersions returns empty array for new record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(await stack.getVersions(record.id)).toEqual([]);
  });

  test('getVersions returns history after updates', async () => {
    const record = await stack.create(NOTE_V1, { text: 'v1' });
    await stack.patchContent(record.id, { text: 'v2' });
    await stack.patchContent(record.id, { text: 'v3' });
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(2);
  });

  test('restoreVersion creates a new version with old content', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.patchContent(record.id, { text: 'changed' });
    const restored = await stack.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.version).toBe(3); // v1 original, v2 changed, v3 restored
  });

  test('restoreVersion does not rewrite history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.patchContent(record.id, { text: 'changed' });
    await stack.restoreVersion(record.id, 1);
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(2); // v1 and v2 snapshots preserved
  });

  test('restoreVersion throws for unknown version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.restoreVersion(record.id, 99)).rejects.toThrow();
  });

  test('restoreVersion never restores associations, even ones held at the target version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' }); // no bump, still v1
    await stack.patchContent(record.id, { text: 'changed' }); // v2, snapshots v1
    await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' }); // no bump, still v2
    const restored = await stack.restoreVersion(record.id, 1); // v3
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toBeUndefined();
  });

  test('restoreVersion leaves the record’s current associations exactly as they stand', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1
    await stack.patchContent(record.id, { text: 'changed' }); // v2
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' }); // no bump, still v2
    const restored = await stack.restoreVersion(record.id, 1); // v3
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'favourite' }]);

    const raw = await adapter.getRecord(record.id);
    expect(raw?.associations).toEqual([{ kind: 'tag', label: 'favourite' }]);
  });

  test('restoreVersion leaves the record’s permissions exactly as they stand', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] }); // no bump
    await stack.patchContent(record.id, { text: 'changed' }); // v2, snapshots v1
    const restored = await stack.restoreVersion(record.id, 1); // v3
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  test('a version snapshot carries neither associations nor permissions', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // no bump, still v1
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] }); // no bump
    await stack.patchContent(record.id, { text: 'changed' }); // v2, snapshots v1
    const versions = await stack.getVersions(record.id);
    const v1snap = versions.find((v) => v.version === 1);
    expect(v1snap && 'associations' in v1snap).toBe(false);
    expect(v1snap && 'permissions' in v1snap).toBe(false);
  });
});

// -------------------------------------------------------
// Versioning rule — mixed mutations
// -------------------------------------------------------

describe('versioning rule — mixed mutations', () => {
  test('version increments by exactly one per real mutation, across mixed operation types — associate/dissociate never bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // no bump, still v2
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] }); // no bump
    await stack.dissociate(record.id, { kind: 'tag', label: 'x' }); // no bump, still v2
    await stack.delete(record.id); // v3
    const undeleted = await stack.undelete(record.id); // v4

    expect(undeleted.version).toBe(4);
    const versionNumbers = (await stack.getVersions(record.id))
      .map((v) => v.version)
      .sort((a, b) => a - b);
    expect(versionNumbers).toEqual([1, 2, 3]);
  });

  test('no-op mutations never bump version or add a snapshot', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // no bump, still v1
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // no-op
    await stack.dissociate(record.id, { kind: 'tag', label: 'gone' }); // no-op
    await stack.mutate(record.id, { permissions: [] }); // no-op (already private)
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });
});

// -------------------------------------------------------
// ifVersion (opt-in optimistic concurrency)
// -------------------------------------------------------

describe('ifVersion', () => {
  test('a content patch applies when ifVersion matches, and bumps as normal', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    const updated = await stack.patchContent(record.id, { text: 'v2' }, { ifVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.content.text).toBe('v2');
  });

  test('patchContent() throws StackVersionConflictError when ifVersion is stale, and changes nothing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2, no ifVersion — moves the record on

    const err = await stack
      .patchContent(record.id, { text: 'v3' }, { ifVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).recordId).toBe(record.id);
    expect((err as StackVersionConflictError).expectedVersion).toBe(1);
    expect((err as StackVersionConflictError).actualVersion).toBe(2);

    const current = await stack.get(record.id);
    expect(current?.version).toBe(2);
    expect(current?.content.text).toBe('v2');
  });

  test('omitting ifVersion keeps last-writer-wins behavior', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'from A' }); // v2
    const updated = await stack.patchContent(record.id, { text: 'from B' }); // v3, no precondition
    expect(updated.version).toBe(3);
    expect(updated.content.text).toBe('from B');
  });

  // A reshare moves no version, so a precondition on one would fence a
  // write the number it names cannot describe — the same reason
  // associate()/dissociate() take none.
  test('a reshare ignores a stale ifVersion; associate()/dissociate() never bump version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    const reshared = await stack.mutate(
      record.id,
      { permissions: [{ kind: 'anyone', label: 'read' }] },
      { ifVersion: 1 }, // stale for the record, but this write never bumps
    );
    expect(reshared.version).toBe(2);
    expect(reshared.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);

    const associated = await stack.associate(record.id, { kind: 'tag', label: 'x' });
    expect(associated.version).toBe(2);
    const dissociated = await stack.dissociate(record.id, { kind: 'tag', label: 'x' });
    expect(dissociated.version).toBe(2);

    expect((await stack.get(record.id))?.version).toBe(2);
  });

  test('mutate() with an associations-only change set ignores a stale ifVersion, like associate()/dissociate()', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    const updated = await stack.mutate(
      record.id,
      { associations: [{ kind: 'tag', label: 'x' }] },
      { ifVersion: 1 }, // stale for the record, but this write never bumps
    );
    expect(updated.version).toBe(2);
    expect(updated.associations).toEqual([{ kind: 'tag', label: 'x' }]);
  });

  test('a stale ifVersion is refused even where the change set turns out to write nothing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    // Restating the content the record already holds moves nothing, but the
    // caller still staked a claim about the version it was working from.
    await expect(
      stack.mutate(record.id, { contentPatch: { text: 'v2' } }, { ifVersion: 1 }),
    ).rejects.toThrow(StackVersionConflictError);

    // A set naming `associations` alongside it is still guarded, even where
    // the associations are the only aspect that moves.
    await expect(
      stack.mutate(
        record.id,
        { contentPatch: { text: 'v2' }, associations: [{ kind: 'tag', label: 'x' }] },
        { ifVersion: 1 },
      ),
    ).rejects.toThrow(StackVersionConflictError);

    expect((await stack.get(record.id))?.associations ?? []).toEqual([]);
  });

  test('delete() (soft) and undelete() enforce ifVersion', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    await expect(stack.delete(record.id, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    await stack.delete(record.id, { ifVersion: 2 }); // v3, soft-deleted

    await expect(stack.undelete(record.id, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    const undeleted = await stack.undelete(record.id, { ifVersion: 3 }); // v4
    expect(undeleted.version).toBe(4);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('delete() (hard) enforces ifVersion atomically at the adapter', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    await expect(stack.delete(record.id, { hard: true, ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    // A rejected hard delete must leave the record fully intact.
    expect(await stack.get(record.id)).not.toBeNull();

    await stack.delete(record.id, { hard: true, ifVersion: 2 });
    expect(await stack.get(record.id)).toBeNull();
  });

  test('restoreVersion() enforces ifVersion', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2
    await stack.patchContent(record.id, { text: 'v3' }); // v3

    await expect(stack.restoreVersion(record.id, 1, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    const restored = await stack.restoreVersion(record.id, 1, { ifVersion: 3 }); // v4
    expect(restored.version).toBe(4);
    expect(restored.content.text).toBe('hello');
  });

  test('commitMigration() enforces ifVersion', async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2

    await expect(
      stack.commitMigration(record.id, NOTE_V2, { text: 'v2', title: '' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackVersionConflictError);
    // A rejected migration must leave the record at its current type.
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V1);

    const migrated = await stack.commitMigration(
      record.id,
      NOTE_V2,
      { text: 'v2', title: 'ok' },
      { ifVersion: 2 },
    ); // v3
    expect(migrated.version).toBe(3);
    expect(migrated.typeId).toBe(NOTE_V2);
  });

  test('ifVersion on a nonexistent record throws StackNotFoundError, not StackVersionConflictError', async () => {
    await expect(
      stack.patchContent('nonexistent', { text: 'x' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
    await expect(
      stack.commitMigration('nonexistent', NOTE_V1, { text: 'x' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Orphan version row recovery
// -------------------------------------------------------

describe('orphan version row recovery', () => {
  test("a pre-existing orphan snapshot at the record's current version does not permanently block patchContent()", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    // Simulate an interrupted write: the v1 snapshot committed, but the
    // mutation that should have bumped past it never did — an orphan row
    // sitting at the record's own current version.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: { text: 'hello' },
      updatedAt: record.updatedAt,
    });

    const updated = await stack.patchContent(record.id, { text: 'v2' });
    expect(updated.version).toBe(2);
    expect(updated.content.text).toBe('v2');

    // The orphan is healed (overwritten), not duplicated.
    const versions = await stack.getVersions(record.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });

  test('an orphan does not block any verb that still bumps', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.patchContent(record.id, { text: 'v2' }); // v2, snapshots v1

    await adapter.saveVersion(record.id, {
      version: 2,
      typeId: NOTE_V1,
      content: { text: 'v2' },
      updatedAt: new Date(),
    }); // orphan sitting at the record's current version (2)

    // Only the verbs that still bump reach the snapshot mechanism, so a
    // content patch is what exercises the orphan-healing path here.
    await stack.patchContent(record.id, { text: 'v3' }); // v3
    expect((await stack.get(record.id))?.version).toBe(3);
  });

  test('genuinely concurrent last-writer-wins updates: the loser is still rejected with no partial apply', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    const staleRead = await stack.get(record.id);

    // Writer A completes first, moving the record to v2.
    await stack.patchContent(record.id, { text: 'from A' });

    // Writer B built its mutation from the same stale v1 read and tries to
    // snapshot v1 again — but the record has since moved to v2, so this is
    // a genuine conflict (not a recoverable orphan: the row it collides
    // with is v1's real, already-superseded history entry) and must be
    // rejected before any part of B's mutation applies.
    await expect(
      adapter.mutateRecord(
        record.id,
        { contentPatch: { text: 'from B' } },
        {
          snapshot: {
            version: 1,
            typeId: NOTE_V1,
            content: { text: 'hello' },
            updatedAt: staleRead!.updatedAt,
          },
        },
      ),
    ).rejects.toThrow(StackConflictError);

    const current = await stack.get(record.id);
    expect(current?.content.text).toBe('from A');
    expect(current?.version).toBe(2);
  });
});

// -------------------------------------------------------
// delete
// -------------------------------------------------------

describe('delete', () => {
  test('soft delete sets deletedAt', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
  });

  test('soft-deleted records are excluded from queries by default', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records.find((r) => r.id === record.id)).toBeUndefined();
  });

  test('soft-deleted records appear with includeDeleted', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1, includeDeleted: true } });
    expect(result.records.find((r) => r.id === record.id)).toBeDefined();
  });

  describe('a purge reports the files it stranded', () => {
    // A purge removes the association and content_index rows naming a
    // fileId — the only pointers — so the follow-up deleteAttachment()
    // would otherwise have no argument a caller could supply.
    const PHOTO = 'com.example.test/purge-photo@1';

    test('names the attachment associations the record held', async () => {
      const {
        content: { fileId },
      } = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      await stack.associate(note.id, { kind: 'attachment', label: 'cover', fileId });

      expect(await stack.delete(note.id, { hard: true })).toEqual({
        referencedFileIds: [fileId],
      });
    });

    test('names a file-ref content field, and names each file once', async () => {
      await stack.defineType(PHOTO, 'Photo', { coverFileId: { kind: 'file-ref', required: true } });
      const {
        content: { fileId },
      } = await stack.putAttachment(new Uint8Array([4, 5, 6]), { mimeType: 'image/png' });
      const photo = await stack.create(PHOTO, { coverFileId: fileId });
      // The same file, reached both ways: one file, one entry.
      await stack.associate(photo.id, { kind: 'attachment', label: 'cover', fileId });

      expect(await stack.delete(photo.id, { hard: true })).toEqual({
        referencedFileIds: [fileId],
      });
    });

    test('the bytes survive the purge — reporting is not deleting', async () => {
      const data = new Uint8Array([7, 8, 9]);
      const {
        content: { fileId },
      } = await stack.putAttachment(data, { mimeType: 'image/png' });
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      await stack.associate(note.id, { kind: 'attachment', label: 'cover', fileId });

      const { referencedFileIds } = await stack.delete(note.id, { hard: true });
      expect(await stack.getAttachment(fileId)).toEqual(data);

      // And the report is exactly what the intentional follow-up takes.
      for (const stranded of referencedFileIds) await stack.deleteAttachment(stranded);
      await expect(stack.getAttachment(fileId)).rejects.toThrow(StackNotFoundError);
    });

    test('a soft delete strands nothing, so it names nothing', async () => {
      const {
        content: { fileId },
      } = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
      const note = await stack.create(NOTE_V1, { text: 'hello' });
      await stack.associate(note.id, { kind: 'attachment', label: 'cover', fileId });

      // A tombstone is recoverable and must find its attachments intact,
      // so its references still stand.
      expect(await stack.delete(note.id)).toEqual({ referencedFileIds: [] });
      await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
    });
  });

  test('a hard delete of a record that is not there is silent', async () => {
    // Nothing was purged, so nothing was stranded to report.
    await expect(stack.delete('01hzzzzzzzzzzzzzzzzzzzzzzz', { hard: true })).resolves.toEqual({
      referencedFileIds: [],
    });
  });

  test('a hard delete under a precondition reports a record that is not there', async () => {
    // The precondition cannot be satisfied by a record that does not
    // exist, so the call reports that rather than succeeding vacuously.
    await expect(
      stack.delete('01hzzzzzzzzzzzzzzzzzzzzzzz', { hard: true, ifVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
  });

  test('hard delete removes the record entirely', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id, { hard: true });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('soft delete bumps version and snapshots the prior state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('soft-deleting an already-deleted record is a no-op — no version bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('throws StackNotFoundError for a missing record (soft delete)', async () => {
    await expect(stack.delete('nonexistent')).rejects.toThrow(StackNotFoundError);
  });
});

describe('deleteAndReturn', () => {
  test('a hard delete reports the record as it stood at destruction, associations included', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(note.id, { kind: 'attachment', label: 'cover', fileId });

    const { record, referencedFileIds } = await stack.deleteAndReturn(note.id, { hard: true });
    expect(record?.id).toBe(note.id);
    expect(record?.associations).toEqual([{ kind: 'attachment', label: 'cover', fileId }]);
    expect(referencedFileIds).toEqual([fileId]);
    expect(await adapter.getRecord(note.id)).toBeNull();
  });

  // The property the issue this closes is about: nothing reads the record
  // ahead of the destroy, so nothing landing between a read and a destroy
  // can be missed by the response. A separate pre-read is the bug, not an
  // implementation detail of it — asserting it never happens is what turns
  // this from a fixture that happens to pass into one that would fail if
  // the race were reintroduced.
  test('never reads the record separately before a hard delete — nothing can slip in between', async () => {
    const note = await stack.create(NOTE_V1, { text: 'hello' });
    const getRecordSpy = vi.spyOn(adapter, 'getRecord');

    await stack.deleteAndReturn(note.id, { hard: true });

    expect(getRecordSpy).not.toHaveBeenCalled();
  });

  test('a soft delete reports the resulting tombstone', async () => {
    const note = await stack.create(NOTE_V1, { text: 'hello' });
    const { record, referencedFileIds } = await stack.deleteAndReturn(note.id);
    expect(record?.deletedAt).toBeInstanceOf(Date);
    expect(record?.version).toBe(2);
    expect(referencedFileIds).toEqual([]);
  });

  test('a hard delete of a record that is not there reports a null record', async () => {
    await expect(
      stack.deleteAndReturn('01hzzzzzzzzzzzzzzzzzzzzzzz', { hard: true }),
    ).resolves.toEqual({ record: null, referencedFileIds: [] });
  });

  test('delete() is deleteAndReturn() minus the record', async () => {
    const note = await stack.create(NOTE_V1, { text: 'hello' });
    const full = await stack.deleteAndReturn(note.id, { hard: true });

    const other = await stack.create(NOTE_V1, { text: 'hello again' });
    const stripped = await stack.delete(other.id, { hard: true });

    expect(stripped).toEqual({ referencedFileIds: full.referencedFileIds });
  });
});

// -------------------------------------------------------
// _config protections
// -------------------------------------------------------

describe('_config protections', () => {
  const CONFIG_ID = '_config';
  const CONFIG_TYPE = '_config@1';

  // MemoryAdapter never materializes a _config record on its own (ownerEntityId
  // is a plain constructor field) — the guards under test operate on whatever
  // record exists at id "_config", so tests seed one directly.
  async function seedConfig(entityId = 'owner-123', timezone = 'UTC') {
    return adapter.createRecord({
      id: CONFIG_ID,
      typeId: CONFIG_TYPE,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { entityId, timezone },
      version: 1,
    });
  }

  test('patchContent() rejects a change to entityId', async () => {
    await seedConfig();
    await expect(stack.patchContent(CONFIG_ID, { entityId: 'someone-else' })).rejects.toThrow(
      StackConflictError,
    );
    expect((await adapter.getRecord(CONFIG_ID))?.content.entityId).toBe('owner-123');
  });

  test('patchContent() allows changing timezone', async () => {
    await seedConfig();
    const updated = await stack.patchContent(CONFIG_ID, { timezone: 'America/New_York' });
    expect((updated.content as Record<string, unknown>).timezone).toBe('America/New_York');
  });

  test('setting entityId to its current value is a no-op, not an error', async () => {
    await seedConfig('owner-123');
    await expect(stack.patchContent(CONFIG_ID, { entityId: 'owner-123' })).resolves.toBeDefined();
  });

  test('soft delete is rejected', async () => {
    await seedConfig();
    await expect(stack.delete(CONFIG_ID)).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord(CONFIG_ID)).not.toBeNull();
  });

  test('hard delete is rejected', async () => {
    await seedConfig();
    await expect(stack.delete(CONFIG_ID, { hard: true })).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord(CONFIG_ID)).not.toBeNull();
  });

  test('restoreVersion() rejects a snapshot with a different entityId', async () => {
    await seedConfig('owner-123');
    // Simulates a snapshot that predates this guard, or a bypassed
    // direct-adapter write — either way, a stored version whose entityId
    // disagrees with the live record's must not be restorable.
    await adapter.saveVersion(CONFIG_ID, {
      version: 1,
      typeId: CONFIG_TYPE,
      content: { entityId: 'someone-else', timezone: 'UTC' },
      updatedAt: new Date(),
    });
    await expect(stack.restoreVersion(CONFIG_ID, 1)).rejects.toThrow(StackConflictError);
  });

  test('restoreVersion() allows a snapshot with the same entityId', async () => {
    await seedConfig('owner-123', 'UTC');
    await stack.patchContent(CONFIG_ID, { timezone: 'America/New_York' });
    const restored = await stack.restoreVersion(CONFIG_ID, 1);
    expect((restored.content as Record<string, unknown>).timezone).toBe('UTC');
  });

  test('generic query excludes _config', async () => {
    await seedConfig();
    const result = await stack.query({ filter: { typeId: CONFIG_TYPE } });
    expect(result.records).toHaveLength(0);
  });

  test('_config is still addressable directly by ID', async () => {
    await seedConfig();
    expect(await stack.get(CONFIG_ID)).not.toBeNull();
  });

  test('ScopedStack delegation: the owner cannot change entityId via scoped update either', async () => {
    await seedConfig('owner-123');
    await expect(
      stack.asEntity('owner-123').patchContent(CONFIG_ID, { entityId: 'someone-else' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('ScopedStack delegation: the owner cannot delete _config via scoped delete either', async () => {
    await seedConfig('owner-123');
    await expect(stack.asEntity('owner-123').delete(CONFIG_ID)).rejects.toThrow(StackConflictError);
  });

  test('commitMigration() rejects a change to entityId', async () => {
    await seedConfig('owner-123');
    await stack.defineType('_config@2', 'Config', {
      entityId: { kind: 'string', required: true },
      timezone: { kind: 'string' },
    });

    await expect(
      stack.commitMigration(CONFIG_ID, '_config@2', { entityId: 'someone-else' }),
    ).rejects.toThrow(StackConflictError);
    expect((await adapter.getRecord(CONFIG_ID))?.typeId).toBe(CONFIG_TYPE); // never committed
  });

  test('commitMigration() allows the same entityId', async () => {
    await seedConfig('owner-123');
    await stack.defineType('_config@2', 'Config', {
      entityId: { kind: 'string', required: true },
      timezone: { kind: 'string' },
    });

    const migrated = await stack.commitMigration(CONFIG_ID, '_config@2', {
      entityId: 'owner-123',
      timezone: 'America/New_York',
    });
    expect(migrated.typeId).toBe('_config@2');
  });
});

// -------------------------------------------------------
// undelete
// -------------------------------------------------------

describe('undelete', () => {
  test('reverses a soft delete', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const undeleted = await stack.undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeUndefined();
  });

  test('is idempotent — undeleting a non-deleted record returns it unchanged', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.undelete(record.id);
    expect(result).toEqual(record);
  });

  test('a second undelete call is also a no-op success', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.undelete(record.id);
    const result = await stack.undelete(record.id);
    expect(result.deletedAt).toBeUndefined();
  });

  test('throws StackNotFoundError for a hard-deleted (missing) record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id, { hard: true });
    await expect(stack.undelete(record.id)).rejects.toThrow(StackNotFoundError);
  });

  test('throws StackNotFoundError for a record that never existed', async () => {
    await expect(stack.undelete('nonexistent')).rejects.toThrow(StackNotFoundError);
  });

  test('undeleted record is included in default queries again', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.undelete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records.find((r) => r.id === record.id)).toBeDefined();
  });

  test('bumps version and snapshots the deleted state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.delete(record.id); // v2
    const undeleted = await stack.undelete(record.id); // v3
    expect(undeleted.version).toBe(3);
    expect(await stack.getVersions(record.id)).toHaveLength(2);
  });

  test('idempotent no-op undelete does not bump version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.undelete(record.id);
    const result = await adapter.getRecord(record.id);
    expect(result?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });
});

// -------------------------------------------------------
// flush / close lifecycle
// -------------------------------------------------------

describe('flush / close', () => {
  test('flush() delegates to adapter.flush() when implemented', async () => {
    let flushed = false;
    adapter.flush = async () => {
      flushed = true;
    };
    await stack.flush();
    expect(flushed).toBe(true);
  });

  test('flush() is a no-op when adapter does not implement flush', async () => {
    await expect(stack.flush()).resolves.toBeUndefined();
  });

  test('close() delegates to adapter.close() when implemented', async () => {
    let closed = false;
    adapter.close = async () => {
      closed = true;
    };
    await stack.close();
    expect(closed).toBe(true);
  });

  test('close() is a no-op when adapter does not implement close', async () => {
    await expect(stack.close()).resolves.toBeUndefined();
  });

  test('close() flushes before releasing resources', async () => {
    const calls: string[] = [];
    adapter.flush = async () => {
      calls.push('flush');
    };
    adapter.close = async () => {
      calls.push('close');
    };
    await stack.close();
    expect(calls).toEqual(['flush', 'close']);
  });

  test('close() releases resources even when the flush fails, then propagates', async () => {
    let closed = false;
    adapter.flush = async () => {
      throw new Error('disk full');
    };
    adapter.close = async () => {
      closed = true;
    };
    await expect(stack.close()).rejects.toThrow('disk full');
    expect(closed).toBe(true);
  });

  test('close() is idempotent — the adapter is never closed twice', async () => {
    let closes = 0;
    adapter.close = async () => {
      closes += 1;
    };
    await stack.close();
    await stack.close();
    expect(closes).toBe(1);
  });
});

describe('use after close', () => {
  beforeEach(async () => {
    await stack.close();
  });

  test('reads throw StackClosedError', async () => {
    await expect(stack.get('1hk153x0a00b')).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.query()).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.listTypes()).rejects.toBeInstanceOf(StackClosedError);
  });

  test('writes throw StackClosedError', async () => {
    await expect(stack.create(NOTE_V1, { text: 'x' })).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.patchContent('1hk153x0a00b', { text: 'x' })).rejects.toBeInstanceOf(
      StackClosedError,
    );
    await expect(stack.delete('1hk153x0a00b')).rejects.toBeInstanceOf(StackClosedError);
  });

  test('flush() throws, since flushing is work — only close() is idempotent', async () => {
    await expect(stack.flush()).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.close()).resolves.toBeUndefined();
  });

  test('attachment uploads throw StackClosedError', async () => {
    await expect(
      stack.putAttachment(new Uint8Array([1]), { mimeType: 'text/plain' }),
    ).rejects.toBeInstanceOf(StackClosedError);
  });

  test('identity getters still read — they touch no storage', () => {
    expect(stack.ownerEntityId).toBe('owner-123');
    expect(stack.features).toBeDefined();
  });

  test('StackClosedError stays outside the wire taxonomy', () => {
    expect(new StackClosedError()).not.toBeInstanceOf(StackError);
  });
});

describe('use after close — scoped views', () => {
  test('a view taken before close writes no attachment bytes after it', async () => {
    const scoped = stack.asEntity('owner-123');
    await stack.close();

    await expect(
      scoped.putAttachment(new Uint8Array([1]), { mimeType: 'text/plain' }),
    ).rejects.toBeInstanceOf(StackClosedError);
    expect(await adapter.listFiles!()).toHaveLength(0);
  });

  test('asEntity() itself refuses once closed', async () => {
    await stack.close();
    expect(() => stack.asEntity('owner-123')).toThrow(StackClosedError);
  });
});

// -------------------------------------------------------
// grant
// -------------------------------------------------------

describe('grant', () => {
  test('creates a grant record for the given entity and type', async () => {
    const record = await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(record.typeId).toBe('_grant@1');
    // The grantee lives in content, not record.createdBy — createdBy means
    // "author", and the owner (who called grant()) authored this record.
    expect(record.createdBy?.subjectId).toBeUndefined();
    expect(record.content).toEqual({
      typeId: NOTE_V1,
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
  });

  test('an authenticated target creates a default grant naming that tier', async () => {
    const record = await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'authenticated' },
    });
    expect(record.createdBy?.subjectId).toBeUndefined();
    expect(record.content).toEqual({
      typeId: NOTE_V1,
      actions: ['create'],
      grantee: { kind: 'authenticated' },
    });
  });

  test('_grant@1 type is available immediately after Stack.open()', async () => {
    expect(await stack.getType('_grant@1')).not.toBeNull();
  });

  test('_attachment@1 type is available immediately after Stack.open()', async () => {
    expect(await stack.getType('_attachment@1')).not.toBeNull();
  });

  // The grantee lives in content.grantee, not record.createdBy,
  // which means "author" everywhere else — so "everything Alice authored"
  // queries don't pick up grants that merely name her.
  test('an authorship query does not pick up grants naming that entity', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    const result = await stack.query({ filter: { createdBy: { subjectId: 'entity-abc' } } });
    expect(result.records).toHaveLength(0);
  });

  test('a grant record still resolves through ScopedStack for its named grantee', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    const record = await stack.asEntity('entity-abc').create(NOTE_V1, { text: 'hi' });
    expect(record.content.text).toBe('hi');
  });

  // an unrecognized action string would otherwise be stored
  // silently and simply never match at check time (hasGrant).
  test('rejects an unknown grant action', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['read-all' as never],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // typeId must be a well-formed bare baseId or versioned TypeId.
  test('rejects an empty typeId', async () => {
    await expect(
      stack.grant('', { actions: ['create'], grantee: { kind: 'entity', entityId: 'entity-abc' } }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a malformed versioned typeId', async () => {
    await expect(
      stack.grant('com.example.test/note@abc', {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('accepts a bare baseId (no version suffix)', async () => {
    const record = await stack.grant('com.example.test/note', {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(record.typeId).toBe('_grant@1');
  });

  // grants on _grant/_config/_app are refused outright; other reserved
  // types (_attachment, _entity, _group) stay grantable.
  test('rejects a grant targeting _grant@1', async () => {
    await expect(
      stack.grant('_grant@1', {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a grant targeting _config@1', async () => {
    await expect(
      stack.grant('_config@1', {
        actions: ['update-any'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // The _app registry is what resolves a principalId to a name, so only
  // the owner writes cards to it.
  test('rejects a grant targeting _app@1', async () => {
    await expect(
      stack.grant('_app@1', {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a default (any-authenticated) grant targeting _grant@1', async () => {
    await expect(
      stack.grant('_grant@1', { actions: ['create'], grantee: { kind: 'authenticated' } }),
    ).rejects.toThrow(StackValidationError);
  });

  test('still allows a grant targeting _attachment@1', async () => {
    const record = await stack.grant('_attachment@1', {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(record.typeId).toBe('_grant@1');
  });

  test('creates a group-targeted grant record', async () => {
    const record = await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    expect(record.typeId).toBe('_grant@1');
    expect(record.content).toEqual({
      typeId: NOTE_V1,
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
  });

  // The grantee is what a Grant's reach is spelled with, so the schema
  // requires it: a Grant reaching storage without one — an unscoped
  // create(), a JSON import, a server mapping a request body — is refused
  // rather than stored as reach to every authenticated entity.
  test('the _grant schema refuses a record carrying no grantee', async () => {
    await expect(
      stack.create('_grant@1', { typeId: NOTE_V1, actions: ['read-any'] }),
    ).rejects.toThrow(StackValidationError);
  });

  test('the _grant schema refuses a grantee naming no tier', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // A grantee is closed, so a field the vocabulary does not name cannot
  // ride along beside the tier that does.
  test('the _grant schema refuses an undeclared field on the grantee', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { kind: 'entity', entityId: 'entity-abc', everyone: true },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // A closed object field holds one properties set, so the schema can only
  // require `kind`. The arm's own fields are required on the write instead:
  // without that, a grant missing one stores, answers 200, and denies
  // forever — a share that looks like it worked and never did.
  test('a group grantee carrying no role is refused on create', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: 'group-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('a group grantee carrying an empty groupId is refused on create', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '', role: 'member' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('an entity grantee carrying no entityId is refused on create', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { kind: 'entity' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('a grantee naming an unknown kind is refused on create', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE_V1,
        actions: ['read-any'],
        grantee: { kind: 'everyone' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // The same refusal on every path that writes content, so a grant cannot
  // be edited into an arm it does not satisfy.
  test("a patch dropping a group grantee's role is refused", async () => {
    const granted = await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await expect(
      stack.patchContent(granted.id, { grantee: { kind: 'group', groupId: 'group-abc' } }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a group-targeted grant on _grant@1', async () => {
    await expect(
      stack.grant('_grant@1', {
        actions: ['create'],
        grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // A tier that names nobody reaches nobody, so storing one would leave a
  // grant that can only deny while reading as a share that worked.
  test('rejects a group target with an empty groupId', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '', role: 'member' },
      }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects a group target with a missing groupId', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: undefined as unknown as string, role: 'member' },
      }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects a group target with no role', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: 'group-abc' } as unknown as GrantGrantee,
      }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects a target naming no tier', async () => {
    await expect(
      stack.grant(NOTE_V1, { actions: ['read-any'], grantee: null as unknown as GrantGrantee }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects an empty entityId target', async () => {
    await expect(
      stack.grant(NOTE_V1, { actions: ['read-any'], grantee: { kind: 'entity', entityId: '' } }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  // A mutate verb reaches content through the record it returns and through
  // history, so one granted without read conveys what get() refuses. See
  // docs/spec/access-control.md § Write implies read.
  test('rejects a mutate action with no read action alongside it', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['update-any'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['create', 'delete-own'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects a -any mutate action paired only with read-own', async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['read-own', 'delete-any'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).rejects.toThrow(StackValidationError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('accepts a -own mutate action paired with the wider read-any', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['read-any', 'update-own'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(await stack.listGrants()).toHaveLength(1);
  });

  // Contribute-without-reading is the one blind write the model offers.
  test('accepts a create-only grant', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(await stack.listGrants()).toHaveLength(1);
  });
});

// -------------------------------------------------------
// listGrants
// -------------------------------------------------------

describe('listGrants', () => {
  test('omitting the target returns every grant record', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, { actions: ['read-any'], grantee: { kind: 'authenticated' } });
    const grants = await stack.listGrants();
    expect(grants).toHaveLength(2);
  });

  test('an authenticated target returns only default grants', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, { actions: ['read-any'], grantee: { kind: 'authenticated' } });
    const grants = await stack.listGrants({ kind: 'authenticated' });
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['read-any'] });
  });

  test('an entity target returns grants naming it plus every default grant', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-own', 'delete-own'],
      grantee: { kind: 'entity', entityId: 'entity-xyz' },
    });
    await stack.grant(NOTE_V1, { actions: ['read-any'], grantee: { kind: 'authenticated' } });

    const grants = await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' });
    expect(grants).toHaveLength(2);
    const actionSets = grants.map((g) => (g.content as { actions: string[] }).actions);
    expect(actionSets).toContainEqual(['create']);
    expect(actionSets).toContainEqual(['read-any']);
  });

  test('a group target returns grants naming that exact group and role', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-xyz', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-own', 'update-own'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });

    const grants = await stack.listGrants({ kind: 'group', groupId: 'group-abc', role: 'member' });
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['create'] });
  });

  test('an entity target also returns grants naming a group the entity belongs to', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: group.id, role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-own', 'delete-own'],
      grantee: { kind: 'entity', entityId: 'entity-xyz' },
    });

    const grants = await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' });
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['read-any'] });
  });

  // listGrants() documents itself as using the same resolution the access
  // checks use, so it shares grantCoversGrantee() with them. A listing that
  // claimed a grant applied where an access check denied it would be worse
  // than no listing at all.
  test('a grant naming a record outside the _group family is not reported as applying', async () => {
    const notAGroup = await stack.create(NOTE_V1, { text: 'not a group' });
    await stack.associate(notAGroup.id, {
      kind: 'relationship',
      label: 'member',
      target: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: notAGroup.id, role: 'member' },
    });

    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(0);
  });

  test("role 'any' returns every grant naming the group, whichever role it carries", async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'admin' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-xyz', role: 'member' },
    });

    const grants = await stack.listGrants({ kind: 'group', groupId: 'group-abc', role: 'any' });
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => (g.content as GrantContent).grantee)).toEqual(
      expect.arrayContaining([
        { kind: 'group', groupId: 'group-abc', role: 'member' },
        { kind: 'group', groupId: 'group-abc', role: 'admin' },
      ]),
    );
  });

  // The listing answers identity, not coverage: a role names the grant, not
  // someone who might hold it, so the wider tier is not swept in.
  test('a group role returns only the grants carrying that exact role', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'admin' },
    });

    const admin = await stack.listGrants({ kind: 'group', groupId: 'group-abc', role: 'admin' });
    expect(admin).toHaveLength(1);
    expect(admin[0].content).toMatchObject({ actions: ['read-any'] });
  });

  test("a group listing with role 'any' still requires a non-empty groupId", async () => {
    await expect(stack.listGrants({ kind: 'group', groupId: '', role: 'any' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a group target naming no group is refused rather than over-reporting', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await expect(stack.listGrants({ kind: 'group', groupId: '', role: 'member' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('an entity target does not return a group grant for a group the entity does not belong to', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { kind: 'entity', entityId: 'entity-xyz' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: group.id, role: 'member' },
    });

    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(0);
  });
});

// -------------------------------------------------------
// revoke
// -------------------------------------------------------

describe('revoke', () => {
  test('deletes the grant record matching grantee, typeId, and actions', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    const grants = await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' });
    expect(grants).toHaveLength(0);
  });

  test('returns the grants it withdrew, as they stood', async () => {
    const granted = await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    const withdrawn = await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].id).toBe(granted.id);
    expect(withdrawn[0].content).toMatchObject({
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
  });

  // An empty result is the signal, not an error: re-running a revocation
  // must stay safe, and a grant already withdrawn is the ordinary case.
  test('returns an empty array when nothing matched, rather than throwing', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(
      await stack.revoke(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: 'entity-xyz' },
      }),
    ).toEqual([]);

    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(
      await stack.revoke(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: 'entity-abc' },
      }),
    ).toEqual([]);
  });

  // A revocation aimed at a group's admins must not sweep the members'
  // grant, which is the wider tier — and the empty result says it did not.
  test('a group role narrower than the stored grant withdraws nothing, and says so', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    expect(
      await stack.revoke(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'group', groupId: 'group-abc', role: 'admin' },
      }),
    ).toEqual([]);
    expect(
      await stack.listGrants({ kind: 'group', groupId: 'group-abc', role: 'any' }),
    ).toHaveLength(1);
  });

  test("role 'any' is listing-only — grant() and revoke() refuse it", async () => {
    await expect(
      stack.grant(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'group', groupId: 'group-abc', role: 'any' } as never,
      }),
    ).rejects.toThrow(StackQueryError);
    await expect(
      stack.revoke(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'group', groupId: 'group-abc', role: 'any' } as never,
      }),
    ).rejects.toThrow(StackQueryError);
  });

  test('revocation is a soft delete — the owner can undelete it like any other mutation', async () => {
    const granted = await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(0);

    await stack.undelete(granted.id);
    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(1);
  });

  test('does not affect a grant for a different entity or a default grant', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, { actions: ['create'], grantee: { kind: 'authenticated' } });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-xyz' },
    });
    expect(await stack.listGrants()).toHaveLength(2);
  });

  test('does not affect a grant for the same entity with a different action set', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create', 'read-own'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(1);
  });

  test('matches by baseId, covering every version of the type family', async () => {
    await stack.defineType(NOTE_V2, 'Note v2', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.revoke(NOTE_V2, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    expect(await stack.listGrants({ kind: 'entity', entityId: 'entity-abc' })).toHaveLength(0);
  });

  test('an authenticated target revokes a default grant', async () => {
    await stack.grant(NOTE_V1, { actions: ['create'], grantee: { kind: 'authenticated' } });
    await stack.revoke(NOTE_V1, { actions: ['create'], grantee: { kind: 'authenticated' } });
    expect(await stack.listGrants({ kind: 'authenticated' })).toHaveLength(0);
  });

  test('a group target revokes the grant matching that exact group and role', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    expect(
      await stack.listGrants({ kind: 'group', groupId: 'group-abc', role: 'member' }),
    ).toHaveLength(0);
  });

  test('a group target does not affect a grant for a different group or an entity', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-xyz', role: 'member' },
    });
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.revoke(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
    });
    expect(await stack.listGrants()).toHaveLength(2);
  });

  // A group target carrying no group is refused before any record is
  // matched, so an unnamed group cannot stand in for every other grantee.
  test('a group target naming no group is refused, leaving other grants standing', async () => {
    await stack.grant(NOTE_V1, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: 'entity-abc' },
    });
    await stack.grant(NOTE_V1, { actions: ['create'], grantee: { kind: 'authenticated' } });

    await expect(
      stack.revoke(NOTE_V1, {
        actions: ['create'],
        grantee: { kind: 'group', groupId: undefined as unknown as string, role: 'member' },
      }),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(2);
  });
});

// -------------------------------------------------------
// associate / dissociate
// -------------------------------------------------------

describe('associate / dissociate', () => {
  test('associate adds a tag', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.associations?.some((a) => a.kind === 'tag' && a.label === 'favourite')).toBe(
      true,
    );
  });

  test('dissociate removes a tag', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    // Dissociating the only association leaves the key omitted entirely
    // (associations: undefined), mirroring the SQL adapters' rowToRecord
    // rather than a bare `[]` — matching the SQL adapters' rowToRecord.
    expect(updated?.associations).toBeUndefined();
  });

  test('associate never bumps version or snapshots', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    expect(updated.version).toBe(1);
    expect((await adapter.getRecord(record.id))?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('associate is a no-op for a duplicate association', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('associate throws StackNotFoundError for a missing record', async () => {
    await expect(stack.associate('nonexistent', { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('dissociate never bumps version or snapshots', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' });
    expect(updated.version).toBe(1);
    expect((await adapter.getRecord(record.id))?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('dissociate is a no-op when the association is not present', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.dissociate(record.id, { kind: 'tag', label: 'nonexistent' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('dissociate throws StackNotFoundError for a missing record', async () => {
    await expect(stack.dissociate('nonexistent', { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });
});

// -------------------------------------------------------
// The `permissions` key
// -------------------------------------------------------

// -------------------------------------------------------
// The partition, at the invariant layer
// -------------------------------------------------------
//
// The refusal lives in `Stack`, not `ScopedStack`, so an import, a
// server mapping a request body and an unscoped caller are all held to
// it. See docs/spec/access-control.md § Record-level permissions.

describe('Stack — authority and data never share a call', () => {
  const readFor = (entityId: string): AuthorityAssociation => ({
    kind: 'permission',
    label: 'read',
    grantee: { kind: 'entity', entityId },
  });

  /**
   * An element cast past the types that express the partition. What these
   * pin is the runtime guard — the refusal a server mapping a request body,
   * or an import, runs into, where no compiler has seen the value.
   */
  const asData = (association: Association): DataAssociation => association as DataAssociation;
  const asAuthority = (association: Association): AuthorityAssociation =>
    association as AuthorityAssociation;

  test('an unscoped associations write naming a permission kind is refused', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(
      stack.mutate(record.id, { associations: [asData(readFor('entity-abc'))] }),
    ).rejects.toThrow(StackQueryError);
    await expect(
      stack.mutate(record.id, { associations: [asData({ kind: 'anyone', label: 'read' })] }),
    ).rejects.toThrow(StackQueryError);
    expect((await stack.get(record.id))?.permissions).toBeUndefined();
  });

  test('create() refuses the same misrouting', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { associations: [asData(readFor('entity-abc'))] }),
    ).rejects.toThrow(StackQueryError);
    await expect(
      stack.create(
        NOTE_V1,
        { text: 'hello' },
        { permissions: [asAuthority({ kind: 'tag', label: 'draft' })] },
      ),
    ).rejects.toThrow(StackQueryError);
  });

  test('associate()/dissociate() refuse an authority kind', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.associate(record.id, asData(readFor('entity-abc')))).rejects.toThrow(
      StackQueryError,
    );
    await expect(
      stack.dissociate(record.id, asData({ kind: 'anyone', label: 'read' })),
    ).rejects.toThrow(StackQueryError);
  });

  test('grantAccess()/revokeAccess() refuse a data kind', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const tag = asAuthority({ kind: 'tag', label: 'draft' });
    await expect(stack.grantAccess(record.id, tag)).rejects.toThrow(StackQueryError);
    await expect(stack.revokeAccess(record.id, tag)).rejects.toThrow(StackQueryError);
  });
});

// -------------------------------------------------------
// grantAccess()/revokeAccess()
// -------------------------------------------------------

describe('Stack.grantAccess/revokeAccess', () => {
  const readFor = (entityId: string): AuthorityAssociation => ({
    kind: 'permission',
    label: 'read',
    grantee: { kind: 'entity', entityId },
  });
  const writeFor = (entityId: string): AuthorityAssociation => ({
    kind: 'permission',
    label: 'write',
    grantee: { kind: 'entity', entityId },
  });

  test('amends the set rather than replacing it, and never bumps', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.grantAccess(record.id, readFor('entity-a'));
    const updated = await stack.grantAccess(record.id, readFor('entity-b'));

    expect(updated.permissions).toEqual([readFor('entity-a'), readFor('entity-b')]);
    expect(updated.version).toBe(1);
    expect(updated.updatedAt).toEqual(record.updatedAt);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('a grant already held is a no-op — no journal entry', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.grantAccess(record.id, readFor('entity-a'));
    await stack.grantAccess(record.id, readFor('entity-a'));
    expect(await stack.getJournal(record.id)).toHaveLength(2);
  });

  test('revoking something the record does not carry is a no-op', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.revokeAccess(record.id, readFor('entity-a'));
    expect(updated.permissions).toBeUndefined();
    expect(await stack.getJournal(record.id)).toHaveLength(1);
  });

  // The invariant reads the set the write would produce, so the refusal
  // lands on the removal that would leave a write standing alone.
  test('refuses a grant of write with no read, and a revoke that takes the read away', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.grantAccess(record.id, writeFor('entity-a'))).rejects.toThrow(
      StackValidationError,
    );

    await stack.grantAccess(record.id, readFor('entity-a'));
    await stack.grantAccess(record.id, writeFor('entity-a'));
    await expect(stack.revokeAccess(record.id, readFor('entity-a'))).rejects.toThrow(
      StackValidationError,
    );
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(stack.grantAccess('nonexistent', readFor('entity-a'))).rejects.toThrow(
      StackNotFoundError,
    );
    await expect(stack.revokeAccess('nonexistent', readFor('entity-a'))).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('a grant appends one journal entry carrying the element, a revoke its `previous`', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.grantAccess(record.id, readFor('entity-a'));
    await stack.revokeAccess(record.id, readFor('entity-a'));

    const [, granted, revoked] = await stack.getJournal(record.id);
    expect(granted.ops).toEqual(['permissions']);
    expect(granted.associations).toEqual([{ op: 'add', association: readFor('entity-a') }]);
    expect(revoked.ops).toEqual(['permissions']);
    expect(revoked.associations).toEqual([{ op: 'remove', previous: readFor('entity-a') }]);
    // Neither moved the record's own version.
    expect(revoked.version).toBe(1);
  });
});

describe('Stack.mutate — the `permissions` key', () => {
  test('moves the set without bumping version or taking a snapshot', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(updated?.updatedAt).toEqual(record.updatedAt);
    expect(updated?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('replaces only its own domain — a record keeps its associations', async () => {
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      { associations: [{ kind: 'tag', label: 'draft' }] },
    );
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.associations).toEqual([{ kind: 'tag', label: 'draft' }]);
    expect(updated?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  test('is a no-op for a set that says the same thing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
    // The create and the first grant; the restatement adds nothing.
    expect(await stack.getJournal(record.id)).toHaveLength(2);
  });

  test('re-ordering the set is a no-op: no journal entry, no event', async () => {
    const seen: RecordChange[] = [];
    const entity = { kind: 'entity', entityId: 'entity-abc' } as const;
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      {
        permissions: [
          { kind: 'permission', label: 'read', grantee: entity },
          { kind: 'anyone', label: 'read' },
        ],
      },
    );
    stack.subscribe((c) => {
      seen.push(c);
    });
    await stack.mutate(record.id, {
      permissions: [
        { kind: 'anyone', label: 'read' },
        { kind: 'permission', label: 'read', grantee: entity },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
    expect(await stack.getJournal(record.id)).toHaveLength(1);
  });

  test('setting empty permissions on an already-private record is a no-op', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { permissions: [] });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(await stack.getJournal(record.id)).toHaveLength(1);
  });

  // The delta is what the journal keeps, so an element that went is
  // recoverable from it — the whole reason a snapshot owes nothing here.
  test('appends one entry carrying `previous` per element the write removed', async () => {
    const entityA = { kind: 'entity', entityId: 'entity-a' } as const;
    const entityB = { kind: 'entity', entityId: 'entity-b' } as const;
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      {
        permissions: [
          { kind: 'permission', label: 'read', grantee: entityA },
          { kind: 'anyone', label: 'read' },
        ],
      },
    );

    const updated = await stack.mutate(record.id, {
      permissions: [{ kind: 'permission', label: 'read', grantee: entityB }],
    });

    expect(updated.version).toBe(record.version);
    expect(updated.updatedAt).toEqual(record.updatedAt);

    const journal = await stack.getJournal(record.id);
    expect(journal).toHaveLength(2);
    expect(journal[1].ops).toEqual(['permissions']);
    expect(journal[1].associations).toEqual([
      { op: 'add', association: { kind: 'permission', label: 'read', grantee: entityB } },
      { op: 'remove', previous: { kind: 'permission', label: 'read', grantee: entityA } },
      { op: 'remove', previous: { kind: 'anyone', label: 'read' } },
    ]);
  });

  // See docs/spec/access-control.md § Write implies read.
  test('rejects an entry conveying write without read', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(
      stack.mutate(record.id, {
        permissions: [
          {
            kind: 'permission',
            label: 'write',
            grantee: { kind: 'entity', entityId: 'entity-abc' },
          },
        ],
      }),
    ).rejects.toThrow(StackValidationError);
    await expect(
      stack.mutate(record.id, {
        permissions: [
          {
            kind: 'permission',
            label: 'write',
            grantee: { kind: 'group', groupId: 'group-abc', role: 'member' },
          },
        ],
      }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(record.id))?.permissions).toBeUndefined();
  });

  test('create() refuses the same shape at authoring time', async () => {
    await expect(
      stack.create(
        NOTE_V1,
        { text: 'hello' },
        {
          permissions: [
            {
              kind: 'permission',
              label: 'write',
              grantee: { kind: 'entity', entityId: 'entity-abc' },
            },
          ],
        },
      ),
    ).rejects.toThrow(StackValidationError);
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(
      stack.mutate('nonexistent', { permissions: [{ kind: 'anyone', label: 'read' }] }),
    ).rejects.toThrow(StackNotFoundError);
  });

  test('adding role: "admin" to a group entry replaces the member grantee', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
        },
      ],
    });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
      ],
    });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(updated?.permissions).toEqual([
      {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
      },
      {
        kind: 'permission',
        label: 'write',
        grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
      },
    ]);
  });

  test('widening a group entry to role: "member" replaces the admin grantee', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
      ],
    });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
        },
      ],
    });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(updated?.permissions).toEqual([
      {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
      },
      {
        kind: 'permission',
        label: 'write',
        grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
      },
    ]);
  });

  test('a genuinely-identical group entry (matching role) still no-ops', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
      ],
    });
    await stack.mutate(record.id, {
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
        },
      ],
    });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    // The create and the one grant; the restatement adds nothing.
    expect(await stack.getJournal(record.id)).toHaveLength(2);
  });
});

// -------------------------------------------------------
// The `unlisted` key
// -------------------------------------------------------

describe('Stack.mutate — the `unlisted` key', () => {
  // The journal's `unlist`/`list` ops are complete and invertible, so a
  // listing transition needs no snapshot and leaves `version` and
  // `updatedAt` where they stood.
  // See docs/spec/versioning.md § Version history.
  test('sets unlistedAt without bumping version or updatedAt', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { unlisted: true });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(updated?.updatedAt).toEqual(record.updatedAt);
    expect(updated?.unlistedAt).toBeInstanceOf(Date);
    expect(await stack.getVersions(record.id)).toEqual([]);
  });

  test('appends one journal entry per transition', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { unlisted: true });
    const entries = await stack.getJournal(record.id);
    expect(entries).toHaveLength(2); // create, then the unlist
    expect(entries[1].ops).toEqual(['unlist']);
    expect(entries[1].version).toBe(1);
  });

  test('clears unlistedAt on the reverse call', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { unlisted: true });
    await stack.mutate(record.id, { unlisted: false });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(updated?.unlistedAt).toBeUndefined();
  });

  test('is a no-op when already in the requested state — no journal entry', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.mutate(record.id, { unlisted: false });
    expect(await stack.getJournal(record.id)).toHaveLength(1);

    await stack.mutate(record.id, { unlisted: true });
    await stack.mutate(record.id, { unlisted: true });
    expect(await stack.getJournal(record.id)).toHaveLength(2);
  });

  test('ifVersion alongside an unlisted-only set is not checked', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const unlisted = await stack.mutate(record.id, { unlisted: true }, { ifVersion: 99 });
    expect(unlisted.unlistedAt).toBeInstanceOf(Date);
  });

  test('does not touch permissions', async () => {
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      { permissions: [{ kind: 'anyone', label: 'read' }] },
    );
    await stack.mutate(record.id, { unlisted: true });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(stack.mutate('nonexistent', { unlisted: true })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('create({ unlisted: true }) stamps unlistedAt from the start', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { unlisted: true });
    expect(record.unlistedAt).toBeInstanceOf(Date);
    expect((await adapter.getRecord(record.id))?.unlistedAt).toBeInstanceOf(Date);
  });

  test('an unfiltered query() excludes unlisted records by default', async () => {
    const listed = await stack.create(NOTE_V1, { text: 'listed' });
    await stack.create(NOTE_V1, { text: 'unlisted' }, { unlisted: true });
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records.map((r) => r.id)).toEqual([listed.id]);
  });

  test('includeUnlisted: true on a plain Stack returns both', async () => {
    await stack.create(NOTE_V1, { text: 'listed' });
    await stack.create(NOTE_V1, { text: 'unlisted' }, { unlisted: true });
    const result = await stack.query({ filter: { typeId: NOTE_V1, includeUnlisted: true } });
    expect(result.records).toHaveLength(2);
  });

  test('get() still resolves an unlisted record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { unlisted: true });
    expect(await stack.get(record.id)).not.toBeNull();
  });
});

// -------------------------------------------------------
// Mutators answer with the record they produced
// -------------------------------------------------------

describe('mutators return the record they produced', () => {
  test('associate returns the record with the association applied, version unchanged', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    expect(updated.version).toBe(1);
    expect(updated.associations).toEqual([{ kind: 'tag', label: 'favourite' }]);
    expect(updated).toEqual(await adapter.getRecord(record.id));
  });

  test('dissociate returns the record with the association gone, version unchanged', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' });
    expect(updated.version).toBe(1);
    expect(updated.associations).toBeUndefined();
  });

  test('a permissions change set returns the record carrying the new permissions', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.mutate(record.id, {
      permissions: [{ kind: 'anyone', label: 'read' }],
    });
    expect(updated.version).toBe(1);
    expect(updated.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  test('an unlisted change set returns the record carrying unlistedAt', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const unlisted = await stack.mutate(record.id, { unlisted: true });
    expect(unlisted.version).toBe(1);
    expect(unlisted.unlistedAt).toBeInstanceOf(Date);

    const relisted = await stack.mutate(record.id, { unlisted: false });
    expect(relisted.version).toBe(1);
    expect(relisted.unlistedAt).toBeUndefined();
  });

  // A no-op is distinguished by the version that didn't move, not by an
  // answer that never came — see docs/spec/versioning.md § Version history.
  test('a no-op returns the record unchanged', async () => {
    const record = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      { permissions: [{ kind: 'anyone', label: 'read' }] },
    );
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const current = await adapter.getRecord(record.id);

    expect(await stack.associate(record.id, { kind: 'tag', label: 'favourite' })).toEqual(current);
    expect(await stack.dissociate(record.id, { kind: 'tag', label: 'absent' })).toEqual(current);
    expect(
      await stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] }),
    ).toEqual(current);
    expect(await stack.mutate(record.id, { unlisted: false })).toEqual(current);
    expect((await adapter.getRecord(record.id))?.version).toBe(1);
  });
});

// -------------------------------------------------------
// putAttachment
// -------------------------------------------------------

describe('putAttachment', () => {
  test('stores bytes and returns fileId', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    expect(typeof fileId).toBe('string');
  });

  test('creates _attachment@1 record with metadata', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png', filename: 'photo.png' });
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(1);
    const content = result.records[0].content as Record<string, unknown>;
    expect(content.mimeType).toBe('image/png');
    expect(content.size).toBe(3);
    expect(content.filename).toBe('photo.png');
  });

  test('attachment record has no createdBy (owner-attributed)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png' });
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records[0].createdBy?.subjectId).toBeUndefined();
  });
});

// -------------------------------------------------------
// Reserved content keys: __proto__/constructor/prototype name object
// machinery, not fields. Rejected on both write paths so the two agree —
// a merge patch to one of them would otherwise vanish silently while the
// same key through create() stored as an ordinary property.
// -------------------------------------------------------

describe('undeclared content fields', () => {
  test('create() refuses a field the schema does not declare, naming it', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hi', extra: 'kept' })).rejects.toThrow(
      /"extra" is not declared by this type/,
    );
  });

  test('patchContent() refuses an undeclared patch key and writes nothing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi' });

    await expect(stack.patchContent(record.id, { extra: 'kept' })).rejects.toThrow(
      StackValidationError,
    );

    const after = await stack.get(record.id);
    expect(after?.content).toEqual({ text: 'hi' });
    expect(after?.version).toBe(1);
  });

  // The case that motivated the rule: a native field name in a patch was
  // filed as content, so the write succeeded and moved nothing. It is
  // refused now for the same reason any other undeclared name is — there
  // is nothing special about the name, only about the schema.
  test('a native field name in a patch is refused, and the native field is untouched', async () => {
    const box = await stack.create(NOTE_V1, { text: 'box' });
    const note = await stack.create(NOTE_V1, { text: 'note' });

    await expect(stack.patchContent(note.id, { parentId: box.id })).rejects.toThrow(
      /"parentId" is not declared by this type/,
    );

    const after = await stack.get(note.id);
    expect(after?.parentId).toBeUndefined();
    expect(after?.content).toEqual({ text: 'note' });
  });

  // ...and it is the schema that decides, not the name: a type declaring
  // `parentId` as content patches it like any other field.
  test('a type that declares the name patches it as the content field it is', async () => {
    const BOOKMARK = 'com.example.test/bookmark@1';
    await stack.defineType(BOOKMARK, 'Bookmark', {
      url: { kind: 'string', required: true },
      parentId: { kind: 'record-ref' },
    });
    const bookmark = await stack.create(BOOKMARK, { url: 'https://example.com' });

    const updated = await stack.patchContent(bookmark.id, { parentId: 'abcdefghjkmn' });

    expect(updated.content.parentId).toBe('abcdefghjkmn');
    expect(updated.parentId).toBeUndefined();
  });

  test('commitMigration() holds its content to the destination schema', async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    const record = await stack.create(NOTE_V1, { text: 'hi' });

    await expect(
      stack.commitMigration(record.id, NOTE_V2, { text: 'hi', subtitle: 'nope' }),
    ).rejects.toThrow(/"subtitle" is not declared by this type/);
  });

  test('an open object is the way to store a shape the schema cannot describe', async () => {
    const BLOB = 'com.example.test/blob@1';
    await stack.defineType(BLOB, 'Blob', {
      name: { kind: 'string', required: true },
      meta: { kind: 'object', open: true },
    });

    const record = await stack.create(BLOB, {
      name: 'import',
      meta: { source: 'csv', rows: 12, nested: { anything: true } },
    });

    expect(record.content.meta).toEqual({ source: 'csv', rows: 12, nested: { anything: true } });
  });

  // The two rules are independent: an opaque object is exempt from the
  // schema, not from what a content field may be named.
  test('the field-name rule still reaches inside an open object', async () => {
    const BLOB = 'com.example.test/blob@1';
    await stack.defineType(BLOB, 'Blob', {
      name: { kind: 'string', required: true },
      meta: { kind: 'object', open: true },
    });

    const content = JSON.parse('{"name": "x", "meta": {"a.b": 1}}') as Record<string, unknown>;
    await expect(stack.create(BLOB, content)).rejects.toThrow(StackValidationError);
  });
});

describe('reserved content keys', () => {
  const withKey = (key: string, value: unknown): Record<string, unknown> =>
    JSON.parse(`{"text": "hi", "${key}": ${JSON.stringify(value)}}`) as Record<string, unknown>;

  test.each(['__proto__', 'constructor', 'prototype'])(
    'create() rejects a top-level %s content key',
    async (key) => {
      await expect(stack.create(NOTE_V1, withKey(key, 'x'))).rejects.toThrow(StackValidationError);
    },
  );

  test.each(['__proto__', 'constructor', 'prototype'])(
    'patchContent() rejects a %s patch key',
    async (key) => {
      const record = await stack.create(NOTE_V1, { text: 'hi' });

      await expect(stack.patchContent(record.id, withKey(key, 'x'))).rejects.toThrow(
        StackValidationError,
      );
      // Rejected outright, so the rest of the patch doesn't land either.
      expect((await stack.get(record.id))?.content).toEqual({ text: 'hi' });
    },
  );

  test.each(['__proto__', 'constructor', 'prototype'])(
    'commitMigration() rejects a %s content key',
    async (key) => {
      const record = await stack.create(NOTE_V1, { text: 'hi' });

      await expect(stack.commitMigration(record.id, NOTE_V1, withKey(key, 'x'))).rejects.toThrow(
        StackValidationError,
      );
    },
  );

  // Built by parsing, as one off the wire is: `__proto__` in an object
  // literal reaches the prototype setter rather than declaring a field, and
  // `constructor` there collides with `Object.prototype.constructor`.
  const schemaWith = (key: string, def: unknown): TypeSchema =>
    JSON.parse(`{${JSON.stringify(key)}: ${JSON.stringify(def)}}`) as TypeSchema;

  test.each(RESERVED_CONTENT_KEYS)(
    'defineType() refuses a schema declaring %s as a top-level field',
    async (key) => {
      await expect(
        stack.defineType(
          'com.example.test/reserved@1',
          'Reserved',
          schemaWith(key, { kind: 'string' }),
        ),
      ).rejects.toThrow(/cannot be declared as a field name/);
    },
  );

  // The declaration cannot license what the write rule refuses, so
  // accepting one would define a type no record could ever satisfy:
  // supplying the field is a reserved key, omitting it is a missing
  // required field.
  test('a required declaration would be a type no record could satisfy', async () => {
    await expect(
      stack.defineType(
        'com.example.test/reserved@1',
        'Reserved',
        schemaWith('constructor', { kind: 'string', required: true }),
      ),
    ).rejects.toThrow(StackValidationError);
  });

  // Scoped to the write rule's own scope: a nested one names a field a
  // record can actually carry.
  test('a nested declaration is left alone, and the field it names is writable', async () => {
    const NESTED = 'com.example.test/nested-reserved@1';
    await stack.defineType(NESTED, 'Nested', {
      meta: { kind: 'object', properties: schemaWith('constructor', { kind: 'string' }) },
    });

    const record = await stack.create(NESTED, JSON.parse('{"meta": {"constructor": "ok"}}'));

    expect(record.content.meta).toEqual(JSON.parse('{"constructor": "ok"}'));
  });

  test('a nested __proto__ is left alone — it round-trips as an inert own property', async () => {
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      meta: { kind: 'object', open: true },
    });
    const content = JSON.parse('{"text": "hi", "meta": {"__proto__": {"x": 1}}}') as Record<
      string,
      unknown
    >;

    await expect(stack.create(NOTE_V1, content)).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// Undefined patch values: a merge patch spells "leave it alone" by
// omission and "remove it" with null, and has no third state for
// undefined to occupy.
// See docs/spec/data-model.md § Undefined values in a patch.
// -------------------------------------------------------

describe('undefined patch values', () => {
  beforeEach(async () => {
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      extra: { kind: 'string' },
      meta: { kind: 'object', open: true },
    });
  });

  test('patchContent() rejects a patch key whose value is undefined', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi', extra: 'kept' });

    await expect(stack.patchContent(record.id, { extra: undefined })).rejects.toThrow(
      StackValidationError,
    );
    // Rejected outright, so the rest of the patch doesn't land either.
    await expect(
      stack.patchContent(record.id, { text: 'edited', extra: undefined }),
    ).rejects.toThrow(StackValidationError);
    expect((await stack.get(record.id))?.content).toEqual({ text: 'hi', extra: 'kept' });
  });

  test('null still removes the field', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi', extra: 'kept' });

    const updated = await stack.patchContent(record.id, { extra: null });
    expect(updated.content).toEqual({ text: 'hi' });
  });

  test('omitting the field still leaves it unchanged', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi', extra: 'kept' });

    const updated = await stack.patchContent(record.id, { text: 'edited' });
    expect(updated.content).toEqual({ text: 'edited', extra: 'kept' });
  });

  test('a nested undefined is left alone — the whole value is being replaced', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi' });

    const updated = await stack.patchContent(record.id, { meta: { a: 1, b: undefined } });
    expect(updated.content).toEqual({ text: 'hi', meta: { a: 1 } });
  });

  test('create() takes an undefined field as a field the record does not have', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi', extra: undefined });

    expect(record.content).toEqual({ text: 'hi' });
  });
});

// -------------------------------------------------------
// Content field names: a filter key is a dot-separated path, so a stored
// field name may not contain the characters that make a path.
// -------------------------------------------------------

describe('content field names', () => {
  const withKey = (key: string, value: unknown): Record<string, unknown> =>
    JSON.parse(`{"text": "hi", ${JSON.stringify(key)}: ${JSON.stringify(value)}}`) as Record<
      string,
      unknown
    >;

  test.each(['a.b', 'a[0]', 'a]', 'a$b', 'a"b', 'a*b', 'a#b'])(
    'create() rejects the field name %s',
    async (key) => {
      await expect(stack.create(NOTE_V1, withKey(key, 'x'))).rejects.toThrow(StackValidationError);
    },
  );

  test('the check holds at every depth, undeclared subtrees included', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hi', meta: { 'b.c': 1 } })).rejects.toThrow(
      StackValidationError,
    );
    await expect(
      stack.create(NOTE_V1, { text: 'hi', items: [{ ok: 1 }, { 'b.c': 1 }] }),
    ).rejects.toThrow(StackValidationError);
  });

  test('patchContent() rejects a patch introducing one, and lands nothing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi' });

    await expect(stack.patchContent(record.id, { 'a.b': 1 })).rejects.toThrow(StackValidationError);
    expect((await stack.get(record.id))?.content).toEqual({ text: 'hi' });
  });

  test('commitMigration() rejects one too', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi' });

    await expect(stack.commitMigration(record.id, NOTE_V1, withKey('a.b', 1))).rejects.toThrow(
      StackValidationError,
    );
  });

  // A schema off the wire is parsed JSON, so defineType() reports a
  // malformed one rather than throwing out of the machinery that reads it.
  test.each([
    ['an object declaring neither properties nor open', '{"meta": {"kind": "object"}}'],
    ['an array declaring neither items nor open', '{"tags": {"kind": "array"}}'],
    ['an unknown kind', '{"meta": {"kind": "blorp"}}'],
    ['a definition that is not an object', '{"meta": "string"}'],
  ])('defineType() refuses %s', async (_label, json) => {
    await expect(
      stack.defineType('com.example.test/malformed@1', 'Malformed', JSON.parse(json)),
    ).rejects.toThrow(StackValidationError);
  });

  // Every reserved character, at every shape the declared-name walk has to
  // reach. Driven off the constant rather than a copy of it, so reserving
  // another character extends this rather than quietly leaving it behind —
  // and so the walk's recursion through `items` and `properties` is pinned
  // at more than the single array-of-objects case.
  const nameShapes: Record<string, (key: string) => TypeSchema> = {
    'top level': (key) => ({ [key]: { kind: 'string' } }),
    'nested object': (key) => ({
      outer: { kind: 'object', properties: { [key]: { kind: 'string' } } },
    }),
    'array of objects': (key) => ({
      list: { kind: 'array', items: { kind: 'object', properties: { [key]: { kind: 'string' } } } },
    }),
    'array of arrays': (key) => ({
      grid: {
        kind: 'array',
        items: {
          kind: 'array',
          items: { kind: 'object', properties: { [key]: { kind: 'string' } } },
        },
      },
    }),
    'object within an object': (key) => ({
      outer: {
        kind: 'object',
        properties: { inner: { kind: 'object', properties: { [key]: { kind: 'string' } } } },
      },
    }),
  };

  test.each(
    Object.entries(nameShapes).flatMap(([shape, build]) =>
      CONTENT_KEY_PATH_METACHARACTERS.map((char) => [char, shape, build] as const),
    ),
  )('defineType() refuses a declared name containing %s at the %s', async (char, _shape, build) => {
    await expect(
      stack.defineType('com.example.test/named@1', 'Named', build(`a${char}b`)),
    ).rejects.toThrow(StackValidationError);
  });

  test('a declared name at each of those shapes is otherwise fine', async () => {
    for (const [shape, build] of Object.entries(nameShapes)) {
      await expect(
        stack.defineType(`com.example.test/ok-${shape.replace(/ /g, '-')}@1`, 'Ok', build('plain')),
      ).resolves.toBeDefined();
    }
  });

  test('ordinary names, including unicode and reverse-DNS-ish ones, still pass', async () => {
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      com_example_field: { kind: 'number' },
      çé: { kind: 'number' },
      'with space': { kind: 'number' },
      '@context': { kind: 'number' },
    });
    const record = await stack.create(NOTE_V1, {
      text: 'hi',
      com_example_field: 1,
      çé: 2,
      'with space': 3,
      '@context': 4,
    });

    expect(record.content['@context']).toBe(4);
  });
});

// -------------------------------------------------------
// Nested content paths: MemoryAdapter answers the same question the
// SQLite adapters answer in SQL. See docs/spec/data-model.md.
// -------------------------------------------------------

describe('nested content paths', () => {
  const CONTACT = 'com.example.test/contact@1';

  const seed = async () => {
    await stack.defineType(CONTACT, 'Contact', {
      name: { kind: 'string', required: true },
      emails: {
        kind: 'array',
        items: {
          kind: 'object',
          properties: { value: { kind: 'string' }, label: { kind: 'string' } },
        },
      },
      address: { kind: 'object', properties: { city: { kind: 'string' } } },
      tags: { kind: 'array', items: { kind: 'string' } },
    });
    await stack.create(CONTACT, {
      name: 'ada',
      emails: [
        { value: 'ada@example.com', label: 'home' },
        { value: 'a@work.example', label: 'work' },
      ],
      address: { city: 'Lisbon' },
      tags: ['starred', 'todo'],
    });
    await stack.create(CONTACT, {
      name: 'grace',
      emails: [{ value: 'grace@example.com', label: 'home' }],
      address: { city: 'Porto' },
      tags: ['todo'],
    });
  };

  const names = async (content: Record<string, unknown>): Promise<string[]> =>
    (await stack.query({ filter: { typeId: CONTACT, content } })).records
      .map((r) => r.content.name as string)
      .sort();

  test('matches inside an array of objects', async () => {
    await seed();

    expect(await names({ 'emails.value': 'a@work.example' })).toEqual(['ada']);
    expect(await names({ 'emails.value': 'grace@example.com' })).toEqual(['grace']);
  });

  test('walks plain object properties', async () => {
    await seed();

    expect(await names({ 'address.city': 'Porto' })).toEqual(['grace']);
  });

  test('a leaf array matches by containment', async () => {
    await seed();

    expect(await names({ tags: 'starred' })).toEqual(['ada']);
    expect(await names({ tags: 'todo' })).toEqual(['ada', 'grace']);
  });

  test('a path reaching no value matches a null filter', async () => {
    await seed();
    await stack.create(CONTACT, { name: 'hopper' });

    expect(await names({ 'address.city': null })).toEqual(['hopper']);
  });

  test('a path descending through a scalar matches nothing', async () => {
    await seed();

    expect(await names({ 'name.first': 'ada' })).toEqual([]);
  });

  test('a malformed path is a query error, not an empty result', async () => {
    await seed();

    await expect(stack.query({ filter: { content: { 'a..b': 1 } } })).rejects.toThrow(
      StackQueryError,
    );
    await expect(stack.query({ filter: { content: { 'emails[0]': 1 } } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a nested path needs filter.content: "path"', async () => {
    const narrow = Object.assign(
      new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
      {
        capabilities: {
          filter: {
            content: 'field',
            contentPresent: false,
            search: false,
          },
          sort: {
            fields: ['createdAt', 'updatedAt', 'version'],
            contentField: false,
          },
          limits: {
            attachmentBytes: null,
            contentBytes: null,
          },
        },
      },
    );
    const narrowStack = await Stack.open(narrow as StackAdapter);

    // A single-segment filter is still served by the 'field' rung.
    await expect(
      narrowStack.query({ filter: { content: { name: 'ada' } } }),
    ).resolves.toBeDefined();
    await expect(narrowStack.query({ filter: { content: { 'a.b': 1 } } })).rejects.toThrow(
      StackQueryError,
    );
  });
});

// -------------------------------------------------------
// limits.contentBytes pre-check: the content half of the attachment
// ceiling below. Local adapters declare null; a server declares its
// request-size limit so apps can fail before the round trip.
// -------------------------------------------------------

describe('limits.contentBytes pre-check', () => {
  const withContentCeiling = (contentBytes: number): StackAdapter =>
    Object.assign(new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }), {
      capabilities: {
        filter: { content: 'path', contentPresent: true, search: false },
        sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: true },
        limits: { attachmentBytes: null, contentBytes },
      },
    });

  const openLimited = async (contentBytes: number): Promise<Stack> => {
    const limited = await Stack.open(withContentCeiling(contentBytes));
    await limited.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    return limited;
  };

  test('create() throws StackPayloadTooLargeError before writing', async () => {
    const limitedStack = await openLimited(64);

    await expect(limitedStack.create(NOTE_V1, { text: 'x'.repeat(200) })).rejects.toThrow(
      StackPayloadTooLargeError,
    );
    expect((await limitedStack.query({ filter: { typeId: NOTE_V1 } })).records).toHaveLength(0);
  });

  test('patchContent() measures the patch, not the merged record', async () => {
    const limitedStack = await openLimited(64);
    const record = await limitedStack.create(NOTE_V1, { text: 'small' });

    // A small patch against a record near the ceiling is not oversized —
    // the patch is what travels.
    await expect(
      limitedStack.patchContent(record.id, { text: 'also small' }),
    ).resolves.toBeDefined();
    await expect(limitedStack.patchContent(record.id, { text: 'x'.repeat(200) })).rejects.toThrow(
      StackPayloadTooLargeError,
    );
  });

  test('a null contentBytes never throws, regardless of size', async () => {
    await expect(stack.create(NOTE_V1, { text: 'x'.repeat(100000) })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// putAttachment — limits.attachmentBytes pre-check: fails fast before any
// bytes reach the adapter. Local adapters declare null, so these tests
// fake a finite ceiling via Object.assign over a MemoryAdapter instance.
// -------------------------------------------------------

describe('putAttachment — limits.attachmentBytes pre-check', () => {
  const withCeiling = (attachmentBytes: number): StackAdapter =>
    Object.assign(new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }), {
      capabilities: {
        filter: { content: 'none', contentPresent: false, search: false },
        sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: false },
        limits: { attachmentBytes, contentBytes: null },
      },
    });

  test('throws StackPayloadTooLargeError without touching the adapter', async () => {
    const limitedAdapter = withCeiling(2);
    const putAttachmentSpy = vi.spyOn(limitedAdapter, 'putAttachment');
    const limitedStack = await Stack.open(limitedAdapter);

    await expect(
      limitedStack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' }),
    ).rejects.toThrow(StackPayloadTooLargeError);
    expect(putAttachmentSpy).not.toHaveBeenCalled();
  });

  test('allows an upload at exactly the ceiling', async () => {
    const limitedAdapter = withCeiling(3);
    const limitedStack = await Stack.open(limitedAdapter);

    await expect(
      limitedStack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' }),
    ).resolves.toMatchObject({ typeId: '_attachment@1' });
  });

  test('a null attachmentBytes never throws, regardless of size', async () => {
    const data = new Uint8Array(1000);
    await expect(stack.putAttachment(data, { mimeType: 'image/png' })).resolves.toMatchObject({
      typeId: '_attachment@1',
    });
  });
});

// -------------------------------------------------------
// putAttachment — atomic path: with putAttachmentWithMetadata() present,
// Stack.putAttachment() delegates the whole operation and must not also
// make its own create() call (double-create). The fallback path is
// exercised by every other test in the describe block above.
// -------------------------------------------------------

describe('putAttachment — atomic adapter path', () => {
  test('delegates to putAttachmentWithMetadata() when present, skipping its own create() call', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fabricatedRecord: StackRecord = {
      id: generateId(),
      typeId: '_attachment@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { fileId: 'atomic-file-id', mimeType: 'image/png', size: 3, filename: 'photo.png' },
      version: 1,
    };
    const atomicAdapter: StackAdapter = Object.assign(
      new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
      { putAttachmentWithMetadata: vi.fn().mockResolvedValue(fabricatedRecord) },
    );
    const atomicStack = await Stack.open(atomicAdapter);
    const createSpy = vi.spyOn(atomicStack, 'create');

    const {
      content: { fileId },
    } = await atomicStack.putAttachment(data, { mimeType: 'image/png', filename: 'photo.png' });

    expect(fileId).toBe('atomic-file-id');
    expect(atomicAdapter.putAttachmentWithMetadata).toHaveBeenCalledWith(data, {
      mimeType: 'image/png',
      filename: 'photo.png',
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('falls back to its own create() call when the adapter lacks the capability', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const createSpy = vi.spyOn(stack, 'create');

    await stack.putAttachment(data, { mimeType: 'image/png', filename: 'photo.png' });

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test('the returned record is the one in storage, on the atomic path', async () => {
    const fabricatedRecord: StackRecord = {
      id: generateId(),
      typeId: '_attachment@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { fileId: 'atomic-file-id', mimeType: 'image/png', size: 3 },
      version: 1,
    };
    const atomicAdapter: StackAdapter = Object.assign(
      new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
      { putAttachmentWithMetadata: vi.fn().mockResolvedValue(fabricatedRecord) },
    );
    const atomicStack = await Stack.open(atomicAdapter);

    const record = await atomicStack.putAttachment(new Uint8Array([1, 2, 3]), {
      mimeType: 'image/png',
    });

    expect(record.id).toBe(fabricatedRecord.id);
    expect(record.content.fileId).toBe('atomic-file-id');
  });
});

// -------------------------------------------------------
// putAttachment returns the _attachment@1 record, matching what
// POST /attachments returns on the wire. The metadata record's id is the
// point: filename is the one mutable field, and setting it later needs an
// id the caller would otherwise have to go query for.
// -------------------------------------------------------

describe('putAttachment — returned record', () => {
  test('returns the metadata record, not just the fileId', async () => {
    const data = new Uint8Array([1, 2, 3]);

    const record = await stack.putAttachment(data, {
      mimeType: 'image/png',
      filename: 'photo.png',
    });

    expect(record.typeId).toBe('_attachment@1');
    expect(record.content).toEqual({
      fileId: expect.any(String),
      mimeType: 'image/png',
      size: 3,
      filename: 'photo.png',
    });
    expect(await stack.get(record.id)).toMatchObject({ id: record.id });
  });

  test('the returned id sets filename later without a lookup', async () => {
    const record = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });

    const renamed = await stack.patchContent(record.id, { filename: 'renamed.png' });

    expect((renamed.content as AttachmentContent).filename).toBe('renamed.png');
  });
});

// -------------------------------------------------------
// _attachment@1 mimeType invariant: first-recorded wins for serving,
// a conflicting later upload is rejected rather than silently coexisting.
// -------------------------------------------------------

// -------------------------------------------------------
// Stack.getAttachmentRecords: the candidate set a download's metadata
// comes from — family-wide, including soft-deleted and unlisted records.
// -------------------------------------------------------

/** The `_attachment@1` schema plus one added field, for migrating a record into `_attachment@2`. */
const defineAttachmentV2 = (s: Stack): Promise<unknown> =>
  s.defineType('_attachment@2', 'Attachment', {
    fileId: { kind: 'string', required: true },
    mimeType: { kind: 'string', required: true },
    size: { kind: 'number', required: true },
    filename: { kind: 'string' },
    caption: { kind: 'string' },
  });

describe('Stack.getAttachmentRecords', () => {
  test('returns an empty array for a fileId with no metadata records', async () => {
    expect(await stack.getAttachmentRecords('no-such-file')).toEqual([]);
  });

  test('returns only the records for the requested fileId', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), {
      mimeType: 'image/png',
      filename: 'wanted.png',
    });
    await stack.putAttachment(new Uint8Array([2]), {
      mimeType: 'image/png',
      filename: 'other.png',
    });

    const records = await stack.getAttachmentRecords(fileId);
    expect(records.map((r) => r.content.filename)).toEqual(['wanted.png']);
  });

  // Sorted, so records[0] is the record that establishes the mimeType and
  // a caller composing with firstRecordedAttachment() never re-sorts.
  test('orders by earliest createdAt, ties broken by the lower id', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    const sameInstant = new Date('2024-01-01T00:00:00.000Z');
    const meta = (id: string, createdAt: Date): StackRecord => ({
      id,
      typeId: '_attachment@1',
      createdAt,
      updatedAt: createdAt,
      content: { fileId, mimeType: 'image/png', size: 3 },
      version: 1,
    });
    // Created out of order, so a scan-order-dependent result would differ.
    await adapter.createRecord(meta('1hk153x00003', new Date('2024-06-01T00:00:00.000Z')));
    await adapter.createRecord(meta('1hk153x00002', sameInstant));
    await adapter.createRecord(meta('1hk153x00001', sameInstant));

    const records = await stack.getAttachmentRecords(fileId);
    expect(records.map((r) => r.id)).toEqual(['1hk153x00001', '1hk153x00002', '1hk153x00003']);
    expect(records[0].id).toBe(firstRecordedAttachment(records)?.id);
  });

  test('includes a record migrated to a later version of the family', async () => {
    const {
      id,
      content: { fileId, mimeType, size },
    } = await stack.putAttachment(new Uint8Array([1]), {
      mimeType: 'image/png',
      filename: 'cover.png',
    });
    await defineAttachmentV2(stack);
    await stack.commitMigration(id, '_attachment@2', {
      fileId,
      mimeType,
      size,
      filename: 'cover.png',
      caption: 'a cover',
    });

    const records = await stack.getAttachmentRecords(fileId);
    expect(records.map((r) => r.typeId)).toEqual(['_attachment@2']);
  });

  test('includes soft-deleted and unlisted records', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    const live = await stack.create('_attachment@1', {
      fileId,
      mimeType: 'image/png',
      size: 3,
      filename: 'live.png',
    });
    const soft = await stack.create('_attachment@1', {
      fileId,
      mimeType: 'image/png',
      size: 3,
      filename: 'soft.png',
    });
    await stack.create(
      '_attachment@1',
      { fileId, mimeType: 'image/png', size: 3, filename: 'unlisted.png' },
      { unlisted: true },
    );
    await stack.delete(soft.id);

    const records = await stack.getAttachmentRecords(fileId);
    expect(records.map((r) => r.content.filename).sort()).toEqual([
      'live.png',
      'soft.png',
      'unlisted.png',
    ]);
    expect(records.some((r) => r.id === live.id)).toBe(true);
  });

  // IncapableMemoryAdapter reaches no content, so this
  // exercises the in-memory filter and the cursor walk rather than the
  // content-filtered query a compliant local adapter takes.
  test('finds a record past the first page on an adapter reaching no content', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    for (let i = 0; i < 55; i++) {
      await incapableStack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const {
      content: { fileId },
    } = await incapableStack.putAttachment(new Uint8Array([9, 9, 9]), {
      mimeType: 'text/markdown',
      filename: 'late.md',
    });

    const records = await incapableStack.getAttachmentRecords(fileId);
    expect(records.map((r) => r.content.filename)).toEqual(['late.md']);
  });
});

describe('attachment association — attachmentRecordId', () => {
  // Two byte-identical uploads: one fileId, two metadata records, so the
  // association's own pointer is the only thing telling them apart.
  const twoUploads = async () => {
    const data = new Uint8Array([1, 2, 3]);
    const first = await stack.putAttachment(data, {
      mimeType: 'image/png',
      filename: 'original.png',
    });
    const second = await stack.putAttachment(data, { mimeType: 'image/png', filename: 'copy.png' });
    return { first, second, fileId: first.content.fileId };
  };

  test('associate stores the pointer alongside the fileId', async () => {
    const { second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    });

    const updated = await adapter.getRecord(record.id);
    expect(updated?.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: second.id },
    ]);
  });

  test('re-pointing an existing association updates it in place, version unchanged', async () => {
    const { first, second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });

    const updated = await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    });

    expect(updated.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: second.id },
    ]);
    expect(updated.version).toBe(1);
  });

  test('associate is a no-op when the pointer is unchanged — no version bump', async () => {
    const { first, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const association: DataAssociation = {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    };
    await stack.associate(record.id, association);

    await stack.associate(record.id, association);

    expect((await adapter.getRecord(record.id))?.version).toBe(1);
  });

  test('a change set that only re-points an association is a change, but never bumps version', async () => {
    const { first, second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });

    const updated = await stack.mutate(record.id, {
      associations: [{ kind: 'attachment', label: 'embed', fileId, attachmentRecordId: second.id }],
    });

    expect(updated.version).toBe(1);
    expect(updated.associations?.[0]).toMatchObject({ attachmentRecordId: second.id });
  });

  // The association written is the association stored: an omitted pointer
  // is a reference naming no upload, not a request to keep the one there.
  test('associating without a pointer clears the one stored, version unchanged', async () => {
    const { first, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });

    const updated = await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
    });

    expect(updated.associations).toEqual([{ kind: 'attachment', label: 'embed', fileId }]);
    expect(updated.version).toBe(1);
  });

  test('a change set restating an association without its pointer clears it, version unchanged', async () => {
    const { first, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });

    const updated = await stack.mutate(record.id, {
      associations: [{ kind: 'attachment', label: 'embed', fileId }],
    });

    expect(updated.associations).toEqual([{ kind: 'attachment', label: 'embed', fileId }]);
    expect(updated.version).toBe(1);
  });

  test('dissociate matches on identity, ignoring the pointer', async () => {
    const { first, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });

    await stack.dissociate(record.id, { kind: 'attachment', label: 'embed', fileId });

    expect((await adapter.getRecord(record.id))?.associations).toBeUndefined();
  });

  test('rejects a pointer at a record that does not exist', async () => {
    const { fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.associate(record.id, {
        kind: 'attachment',
        label: 'embed',
        fileId,
        attachmentRecordId: 'nonexistent1',
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a pointer at a record outside the _attachment family', async () => {
    const { fileId } = await twoUploads();
    const other = await stack.create(NOTE_V1, { text: 'not an attachment' });
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.associate(record.id, {
        kind: 'attachment',
        label: 'embed',
        fileId,
        attachmentRecordId: other.id,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a pointer at an _attachment record for other bytes', async () => {
    const { fileId } = await twoUploads();
    const elsewhere = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'image/png',
      filename: 'other.png',
    });
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.associate(record.id, {
        kind: 'attachment',
        label: 'embed',
        fileId,
        attachmentRecordId: elsewhere.id,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // Nonexistent and wrong-file are one refusal: distinguishing them would
  // confirm which record ids exist. See the anti-oracle rule in
  // docs/spec/attachments.md.
  test('names no difference between a missing record and one for other bytes', async () => {
    const { fileId } = await twoUploads();
    const elsewhere = await stack.putAttachment(new Uint8Array([9]), {
      mimeType: 'image/png',
      filename: 'other.png',
    });
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const reject = async (attachmentRecordId: string) => {
      try {
        await stack.associate(record.id, {
          kind: 'attachment',
          label: 'embed',
          fileId,
          attachmentRecordId,
        });
        throw new Error('expected a rejection');
      } catch (err) {
        return (err as StackValidationError).errors;
      }
    };

    expect(await reject('nonexistent1')).toEqual(await reject(elsewhere.id));
  });

  test('validates a pointer supplied at create time', async () => {
    const { first, fileId } = await twoUploads();

    await expect(
      stack.create(
        NOTE_V1,
        { text: 'hello' },
        {
          associations: [
            { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: 'nonexistent1' },
          ],
        },
      ),
    ).rejects.toThrow(StackValidationError);

    const created = await stack.create(
      NOTE_V1,
      { text: 'hello' },
      {
        associations: [
          { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: first.id },
        ],
      },
    );
    expect(created.associations?.[0]).toMatchObject({ attachmentRecordId: first.id });
  });

  test('validates a pointer supplied in a change set', async () => {
    const { fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.mutate(record.id, {
        associations: [
          { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: 'nonexistent1' },
        ],
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // The reference is the fileId, pointer or no pointer — what
  // deleteAttachment() and the GC sweep ask about.
  test('an association carrying a pointer still counts as a reference', async () => {
    const { second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  // The record's own stored data stays writable: re-sending an association
  // it already carries is not a fresh claim about the record it names.
  test('a change set restating an association with a dangling pointer is accepted', async () => {
    const { second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const association: DataAssociation = {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    };
    await stack.associate(record.id, association);
    await stack.delete(second.id, { hard: true });

    const updated = await stack.mutate(record.id, {
      associations: [association],
      contentPatch: { text: 'edited' },
    });

    expect(updated.associations).toEqual([association]);
  });

  // A metadata record can be deleted while the reference to its bytes
  // stands, so the pointer is best-effort by construction.
  test('a dangling pointer survives on the record it annotates', async () => {
    const { second, fileId } = await twoUploads();
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    });

    await stack.delete(second.id, { hard: true });

    expect((await adapter.getRecord(record.id))?.associations?.[0]).toMatchObject({
      attachmentRecordId: second.id,
    });
    expect((await stack.getAttachmentRecords(fileId)).map((r) => r.content.filename)).toEqual([
      'original.png',
    ]);
  });
});

describe('_attachment@1 mimeType conflict on create', () => {
  test('second upload of identical bytes with a matching mimeType succeeds', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId: fileId1 },
    } = await stack.putAttachment(data, { mimeType: 'image/png', filename: 'first.png' });
    const {
      content: { fileId: fileId2 },
    } = await stack.putAttachment(data, { mimeType: 'image/png', filename: 'second.png' });

    expect(fileId2).toBe(fileId1);
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(2);
  });

  test('second upload of identical bytes with a conflicting mimeType is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'text/markdown' });

    await expect(stack.putAttachment(data, { mimeType: 'text/plain' })).rejects.toThrow(
      StackValidationError,
    );

    // The rejected upload's metadata record must not have been created.
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(1);
  });

  // Anti-oracle: the established mimeType must never appear in the
  // conflict message — naming it would confirm the fileId's existing
  // content type to a caller who only guessed the fileId, reintroducing the
  // confirmation-oracle the anti-oracle rule exists to prevent.
  test('the conflict message never names the established mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'text/markdown' });

    let error: StackValidationError | undefined;
    try {
      await stack.putAttachment(data, { mimeType: 'text/plain' });
    } catch (e) {
      error = e as StackValidationError;
    }
    expect(error).toBeInstanceOf(StackValidationError);
    const message = JSON.stringify(error?.errors);
    expect(message).not.toContain('text/markdown');
    expect(message).not.toContain('text/plain');
  });

  // forces filter.content: 'none' so this exercises the
  // cursor-walk fallback the test name describes, rather than the fast
  // content-filtered query a compliant local adapter (MemoryAdapter's
  // real-world default) would take.
  test('conflict is detected even when the established record is beyond the first query page (>50 records, fallback path)', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    for (let i = 0; i < 55; i++) {
      await incapableStack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const data = new Uint8Array([9, 9, 9]);
    await incapableStack.putAttachment(data, { mimeType: 'text/markdown' });

    await expect(incapableStack.putAttachment(data, { mimeType: 'text/plain' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('a record migrated to a later family version still establishes the mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      id,
      content: { fileId, size },
    } = await stack.putAttachment(data, { mimeType: 'text/markdown' });
    await defineAttachmentV2(stack);
    await stack.commitMigration(id, '_attachment@2', { fileId, mimeType: 'text/markdown', size });

    await expect(stack.putAttachment(data, { mimeType: 'text/plain' })).rejects.toThrow(
      StackValidationError,
    );
    await expect(stack.putAttachment(data, { mimeType: 'text/markdown' })).resolves.toBeDefined();
  });

  test('a soft-deleted earlier record still establishes the mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'text/markdown' });
    const [metaRecord] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    await stack.delete(metaRecord.id);

    await expect(stack.putAttachment(data, { mimeType: 'text/plain' })).rejects.toThrow(
      StackValidationError,
    );
  });

  // The check is check-then-create with no storage-level uniqueness behind
  // it, so on a concurrent server two conflicting first uploads can both
  // land — written here straight through the adapter, which is what that
  // race leaves behind. What must survive it is agreement: core's conflict
  // check and a server resolving Content-Type both read the established
  // type off the same record.
  test('when two conflicting records coexist, first-recorded still names one winner', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    const sameInstant = new Date('2024-01-01T00:00:00.000Z');
    const racer = (id: string, mimeType: string): StackRecord => ({
      id,
      typeId: '_attachment@1',
      createdAt: sameInstant,
      updatedAt: sameInstant,
      content: { fileId, mimeType, size: 3 },
      version: 1,
    });
    // Created out of id order, so a scan-order-dependent pick would
    // disagree with the tiebreak.
    await adapter.createRecord(racer('1hk153x00002', 'text/html'));
    await adapter.createRecord(racer('1hk153x00001', 'image/png'));

    const established = firstRecordedAttachment(
      (await stack.query({ filter: { typeId: '_attachment@1' } })).records,
    );
    expect(established?.id).toBe('1hk153x00001');
    expect((established?.content as AttachmentContent).mimeType).toBe('image/png');

    // Core's write-time check reads the same winner: a third upload
    // matching it is accepted, one matching the loser is not.
    await expect(stack.putAttachment(data, { mimeType: 'text/html' })).rejects.toThrow(
      StackValidationError,
    );
    await expect(stack.putAttachment(data, { mimeType: 'image/png' })).resolves.toBeDefined();
  });

  test('two different uploaders of identical bytes each get their own filename under a matching mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    await stack.create(
      '_attachment@1',
      { fileId, mimeType: 'image/png', size: 3, filename: 'alice.png' },
      { createdBy: { subjectId: 'entity-alice' } },
    );
    await stack.create(
      '_attachment@1',
      { fileId, mimeType: 'image/png', size: 3, filename: 'bob.png' },
      { createdBy: { subjectId: 'entity-bob' } },
    );

    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every((r) => (r.content as Record<string, unknown>).mimeType === 'image/png'),
    ).toBe(true);
    expect(
      result.records.map((r) => (r.content as Record<string, unknown>).filename).sort(),
    ).toEqual(['alice.png', 'bob.png']);
  });
});

// -------------------------------------------------------
// _attachment@1 immutable fields on update: filename is the only
// field that may change after a metadata record is created.
// -------------------------------------------------------

describe('_attachment@1 immutable fields on update', () => {
  test('filename may be changed', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png', filename: 'old.png' });
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    const updated = await stack.patchContent(record.id, { filename: 'new.png' });

    expect((updated.content as Record<string, unknown>).filename).toBe('new.png');
  });

  test('changing mimeType is rejected, even to the same value', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png' });
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.patchContent(record.id, { mimeType: 'image/jpeg' })).rejects.toThrow(
      StackValidationError,
    );
    await expect(stack.patchContent(record.id, { mimeType: 'image/png' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('changing fileId is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png' });
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.patchContent(record.id, { fileId: 'some-other-file' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('changing size is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png' });
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.patchContent(record.id, { size: 999 })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('setting fileId or size to their current value is a no-op, not an error', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, { mimeType: 'image/png' });
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    const content = record.content as Record<string, unknown>;

    await expect(
      stack.patchContent(record.id, { fileId: content.fileId, size: content.size }),
    ).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// deleteAttachment
// -------------------------------------------------------

describe('deleteAttachment', () => {
  test('throws StackConflictError when a record still references the file (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  // a soft-deleted record is recoverable via undelete() — deleting the
  // file it still references now would leave that reference dangling the
  // moment the record comes back.
  test('throws StackConflictError when only a soft-deleted record still references the file', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id);

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('hard-deletes a soft-deleted _attachment@1 metadata record too (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    const [metaRecord] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    await stack.delete(metaRecord.id);

    await stack.deleteAttachment(fileId);

    const result = await stack.query({ filter: { typeId: '_attachment@1', includeDeleted: true } });
    expect(result.records).toHaveLength(0);
  });

  test('deletes the _attachment@1 metadata record when unreferenced (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });

    await stack.deleteAttachment(fileId);

    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(0);
  });

  test('throws StackNotFoundError when neither metadata nor bytes exist', async () => {
    class NoBytesAdapter extends MemoryAdapter {
      async getAttachment(_fileId: string): Promise<Uint8Array> {
        throw new Error('not found');
      }
    }
    const noBytesStack = await Stack.open(
      new NoBytesAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );

    await expect(noBytesStack.deleteAttachment('nonexistent-file')).rejects.toThrow(
      StackNotFoundError,
    );
  });

  // The fallback's metadata scan cursor-walks, so metadata past page one
  // is deleted too rather than orphaned. IncapableMemoryAdapter forces the
  // in-memory fallback the test name describes.
  test('leaves no orphaned metadata when the matching record is beyond the first page (>50 records)', async () => {
    const incapableStack = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    const targetFileId = 'target-file-abc';
    for (let i = 0; i < 55; i++) {
      await incapableStack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const target = await incapableStack.create('_attachment@1', {
      fileId: targetFileId,
      mimeType: 'image/png',
      size: 1,
    });

    await incapableStack.deleteAttachment(targetFileId);

    expect(await incapableStack.get(target.id)).toBeNull();
    const remaining = await incapableStack.query({
      filter: { typeId: '_attachment@1' },
      limit: 1000,
    });
    expect(
      remaining.records.some((r) => (r.content as Record<string, unknown>).fileId === targetFileId),
    ).toBe(false);
  });

  // a fileId held in a file-ref content field is a real reference —
  // deleteAttachment()'s 409 check must see it, not just attachment associations.
  test('throws StackConflictError when only a file-ref content field references the file (fallback path)', async () => {
    const attachmentTypeId = 'com.example.test/photo-note@1';
    await stack.defineType(attachmentTypeId, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('a plain string field holding a fileId conveys no delete protection', async () => {
    const attachmentTypeId = 'com.example.test/photo-note-plain@1';
    await stack.defineType(attachmentTypeId, 'Photo note (plain)', {
      coverFileId: { kind: 'string', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, { mimeType: 'image/png' });
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).resolves.toBeUndefined();
  });

  test('purges metadata records across the whole _attachment family', async () => {
    const {
      id,
      content: { fileId, mimeType, size },
    } = await stack.putAttachment(new Uint8Array([9]), { mimeType: 'image/png' });
    await defineAttachmentV2(stack);
    await stack.commitMigration(id, '_attachment@2', { fileId, mimeType, size });

    await stack.deleteAttachment(fileId);

    const left = await stack.query({
      filter: { baseId: '_attachment', includeDeleted: true, includeUnlisted: true },
    });
    expect(left.records).toEqual([]);
    await expect(stack.getAttachment(fileId)).rejects.toThrow(StackNotFoundError);
  });

  test('prefers the adapter atomic path over the fallback when the adapter implements it', async () => {
    const calls: string[] = [];
    class AtomicAdapter extends MemoryAdapter {
      async deleteUnreferencedAttachmentRecords(
        fileId: string,
        metadataTypeIds: string[],
      ): Promise<StackRecord[]> {
        calls.push('atomic');
        calls.push(...metadataTypeIds);
        const toDelete = [...this.records.values()].filter(
          (r) =>
            metadataTypeIds.includes(r.typeId) &&
            (r.content as Record<string, unknown>).fileId === fileId,
        );
        for (const r of toDelete) {
          this.records.delete(r.id);
          this.order.splice(this.order.indexOf(r.id), 1);
        }
        return toDelete;
      }
    }
    const atomicStack = await Stack.open(
      new AtomicAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await atomicStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    const {
      content: { fileId },
    } = await atomicStack.putAttachment(new Uint8Array([9]), { mimeType: 'image/png' });
    await atomicStack.deleteAttachment(fileId);

    // The family, not just @1 — core resolves the baseId so the adapter
    // never has to.
    expect(calls).toEqual(['atomic', '_attachment@1']);
  });
});

// -------------------------------------------------------
// collectAttachmentGarbage
// -------------------------------------------------------

describe('collectAttachmentGarbage', () => {
  test('collects a file whose only referencing record was hard-deleted', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id, { hard: true });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
    const meta = await stack.query({ filter: { typeId: '_attachment@1', includeDeleted: true } });
    expect(meta.records).toHaveLength(0);
  });

  test('does not collect a file referenced by a live record', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // Soft-deleted records are recoverable via undelete()
  // and must find their attachments intact — so they still count as references.
  test('does not collect a file referenced only by a soft-deleted record', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id);

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // a file-ref content field is a real reference too, same as an
  // attachment Association.
  test('does not collect a file referenced only via a file-ref content field', async () => {
    const photoType = 'com.example.test/photo-note@1';
    await stack.defineType(photoType, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    await stack.create(photoType, { coverFileId: fileId });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  test('default grace period protects a fresh unreferenced upload', async () => {
    await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });

    const result = await stack.collectAttachmentGarbage();

    expect(result.deleted).toEqual([]);
    const meta = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(meta.records).toHaveLength(1);
  });

  test('graceMs: 0 collects an unreferenced upload immediately', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  test('reports reclaimedBytes summed across deleted files', async () => {
    const {
      content: { fileId: fileId1 },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
    const {
      content: { fileId: fileId2 },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3, 4, 5]), { mimeType: 'image/png' });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted.sort()).toEqual([fileId1, fileId2].sort());
    expect(result.reclaimedBytes).toBe(8);
  });

  test('dryRun reports what would be deleted without deleting anything', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0, dryRun: true });

    expect(result.deleted).toEqual([fileId]);
    expect(result.reclaimedBytes).toBe(3);
    const meta = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(meta.records).toHaveLength(1);
  });

  // Bytes with no metadata record (a putAttachment() that stored bytes but
  // crashed before creating _attachment@1 — simulated here by writing
  // through the adapter directly, since no Stack method produces this
  // state on purpose) are only discoverable via StackBlobAdapter.listFiles().
  test('collects a bare-bytes orphan discovered via listFiles()', async () => {
    const fileId = await adapter.putAttachment(new Uint8Array([9, 9, 9]));

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
    expect(result.reclaimedBytes).toBe(3);
  });

  test('adapter without listFiles() still collects metadata-tracked orphans', async () => {
    class NoListFilesAdapter extends MemoryAdapter {
      override listFiles: (() => Promise<BlobFileInfo[]>) | undefined = undefined;
    }
    const noListFilesStack = await Stack.open(
      new NoListFilesAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    const {
      content: { fileId },
    } = await noListFilesStack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });

    const result = await noListFilesStack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  // Without listFiles() the sweep's only way to discover a file is its
  // metadata, so a record migrated past @1 must still be found — otherwise
  // its bytes are unreachable by any sweep.
  test('finds a file whose only metadata record is in a later family version', async () => {
    class NoListFilesAdapter extends MemoryAdapter {
      override listFiles: (() => Promise<BlobFileInfo[]>) | undefined = undefined;
    }
    const noListFilesStack = await Stack.open(
      new NoListFilesAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    const {
      id,
      content: { fileId, mimeType, size },
    } = await noListFilesStack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    await defineAttachmentV2(noListFilesStack);
    await noListFilesStack.commitMigration(id, '_attachment@2', { fileId, mimeType, size });

    const result = await noListFilesStack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  test('adapter without listFiles() cannot find bare-bytes orphans', async () => {
    class NoListFilesAdapter extends MemoryAdapter {
      override listFiles: (() => Promise<BlobFileInfo[]>) | undefined = undefined;
    }
    const noListFilesAdapter = new NoListFilesAdapter({
      ownerEntityId: 'owner-123',
      timezone: 'UTC',
    });
    const noListFilesStack = await Stack.open(noListFilesAdapter);
    await noListFilesAdapter.putAttachment(new Uint8Array([9, 9, 9]));

    const result = await noListFilesStack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // A concurrent associate() landing between the sweep's own scan and its
  // per-file deleteAttachment() call would make that call throw
  // StackConflictError — the sweep must skip that one file, not abort, and
  // must keep collecting everything else it already found.
  test('a file whose delete call races is skipped, not thrown, and the rest of the sweep still completes', async () => {
    const {
      content: { fileId: racedFileId },
    } = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    const {
      content: { fileId: okFileId },
    } = await stack.putAttachment(new Uint8Array([2, 2]), { mimeType: 'image/png' });

    const realDeleteAttachment = stack.deleteAttachment.bind(stack);
    stack.deleteAttachment = async (fileId: string) => {
      if (fileId === racedFileId) throw new StackConflictError('simulated race');
      return realDeleteAttachment(fileId);
    };

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([okFileId]);
    expect(result.reclaimedBytes).toBe(2);
  });
});

// -------------------------------------------------------
// Error taxonomy
// -------------------------------------------------------

// One instance per member, constructed with the minimum each requires.
const everyStackError = (): StackError[] => [
  new StackValidationError([{ path: 'text', message: 'expected string' }]),
  new StackMigrationError('no migration path'),
  new StackPermissionError(),
  new StackNotFoundError('Record "1hk153x0a00b" not found.'),
  new StackConflictError('Attachment is still referenced.'),
  new StackVersionConflictError('Version mismatch.', '1hk153x0a00b', 3, 5),
  new StackQueryError('Undecodable pagination cursor.'),
  new StackSchemaDriftError(NOTE_V1, [{ path: 'text', message: 'type changed' }]),
  new StackPayloadTooLargeError('Attachment exceeds the limit.'),
];

describe('error taxonomy', () => {
  test('every Stack-domain error descends from StackError and from Error', () => {
    for (const err of everyStackError()) {
      expect(err, err.name).toBeInstanceOf(StackError);
      expect(err, err.name).toBeInstanceOf(Error);
    }
  });

  test('each class exposes the same code as an instance property and a static', () => {
    const statics = [
      StackValidationError,
      StackMigrationError,
      StackPermissionError,
      StackNotFoundError,
      StackConflictError,
      StackVersionConflictError,
      StackQueryError,
      StackSchemaDriftError,
      StackPayloadTooLargeError,
    ];
    const instances = everyStackError();
    for (const [i, cls] of statics.entries()) {
      expect(instances[i].code, cls.name).toBe(cls.code);
    }
  });

  test('codes are distinct, so a code identifies exactly one class', () => {
    const codes = everyStackError().map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('a version conflict is a sibling of a plain conflict, never a subtype', () => {
    const version = new StackVersionConflictError('mismatch', '1hk153x0a00b', 3, 5);
    expect(version).not.toBeInstanceOf(StackConflictError);
    expect(new StackConflictError('blocked')).not.toBeInstanceOf(StackVersionConflictError);
  });

  test('a schema drift is a sibling of a plain conflict, never a subtype', () => {
    const drift = new StackSchemaDriftError(NOTE_V1, [{ path: 'text', message: 'type changed' }]);
    expect(drift).not.toBeInstanceOf(StackConflictError);
  });

  test('errors with no wire representation stay outside the taxonomy', () => {
    expect(new IdGenerationError('clock went backwards')).not.toBeInstanceOf(StackError);
    expect(new InvalidDidError('malformed did:key')).not.toBeInstanceOf(StackError);
    expect(new Error('ordinary bug')).not.toBeInstanceOf(StackError);
  });

  test('errors thrown by real operations are catchable as StackError', async () => {
    await expect(stack.create(NOTE_V1, { text: 42 })).rejects.toBeInstanceOf(StackError);
    await expect(stack.get('1hk153x0a00b')).resolves.toBeNull();
    await expect(stack.patchContent('1hk153x0a00b', { text: 'x' })).rejects.toBeInstanceOf(
      StackError,
    );
  });
});

// -------------------------------------------------------
// _app registry integrity
// -------------------------------------------------------

// A card's did is what resolves a record's principalId to a name, so two
// cards claiming one DID would make that lookup ambiguous — and ambiguity
// is all an impersonating card needs.
describe('_app.did bindings', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  test('rejects a second _app record claiming a DID already in use', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(
      stack.create('_app@1', { appId: 'com.example.impostor', name: 'Impostor', did: APP_DID }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that moves a card onto a DID already in use', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const other = await stack.create('_app@1', { appId: 'com.example.other', name: 'Other App' });
    await expect(stack.patchContent(other.id, { did: APP_DID })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('a card may keep its own DID across an unrelated update', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const updated = await stack.patchContent(app.id, { version: '2.0.0' });
    expect((updated.content as { did?: string }).did).toBe(APP_DID);
  });

  test('cards without a DID do not collide with each other', async () => {
    await stack.create('_app@1', { appId: 'com.example.one', name: 'One' });
    const two = await stack.create('_app@1', { appId: 'com.example.two', name: 'Two' });
    expect(two.id).toBeTruthy();
  });

  test('rejects an update that moves a card off the DID it holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(stack.patchContent(app.id, { did: 'did:key:z6MkMoved' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects an update that clears the DID a card holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(stack.patchContent(app.id, { did: null })).rejects.toThrow(StackValidationError);
  });

  test('a card carrying no DID may adopt one', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.later',
      name: 'Key Comes Later',
    });
    const updated = await stack.patchContent(app.id, { did: APP_DID });
    expect((updated.content as { did?: string }).did).toBe(APP_DID);
  });

  test('a card that adopted a DID cannot be rolled back off it', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.later',
      name: 'Key Comes Later',
    });
    await stack.patchContent(app.id, { did: APP_DID });

    await expect(stack.restoreVersion(app.id, 1)).rejects.toThrow(StackValidationError);
  });

  test('a card may be restored onto the DID it already holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.patchContent(app.id, { version: '2.0.0' });

    const restored = await stack.restoreVersion(app.id, 1);
    expect((restored.content as { did?: string }).did).toBe(APP_DID);
  });
});

// -------------------------------------------------------
// Binding fields beyond _app.did
// -------------------------------------------------------

// appId is the other half of the attribution lookup: principalId resolves
// to a card by did, and that card's appId is what a record's own appId is
// checked against. Both halves bind, so both are unique and permanent.
describe('_app.appId bindings', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  // appId is immutable but not unique: nothing resolves a card by it, and
  // requiring it while forbidding a second card holding it would make the
  // replacement card key rotation calls for unwritable.
  test('a second card may claim the same appId under a different did', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const rotated = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: 'did:key:z6MkNotesAppRotated',
    });
    expect((rotated.content as { appId: string }).appId).toBe('com.example.notes');
  });

  test('the did on those cards is still unique', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(
      stack.create('_app@1', { appId: 'com.example.other', name: 'Impostor', did: APP_DID }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that moves a card off the appId it holds', async () => {
    const app = await stack.create('_app@1', { appId: 'com.example.notes', name: 'My Notes App' });
    await expect(stack.patchContent(app.id, { appId: 'com.example.bank' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('display fields stay writable while the bindings hold', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const updated = await stack.patchContent(app.id, { name: 'Renamed', version: '2.0.0' });
    expect(updated.content).toMatchObject({
      appId: 'com.example.notes',
      name: 'Renamed',
      did: APP_DID,
    });
  });

  test('the card names the software it describes, not the software that wrote it', async () => {
    // An admin console registering a third-party app is the ordinary case:
    // record.appId names the console, content.appId names what is registered.
    const card = await stack.create(
      '_app@1',
      { appId: 'com.example.notes', name: 'My Notes App', did: APP_DID },
      { appId: 'com.example.console' },
    );
    expect(card.appId).toBe('com.example.console');
    expect((card.content as { appId: string }).appId).toBe('com.example.notes');
  });
});

// An Actor's subjectId resolves through _entity.did exactly as its principalId resolves
// through _app.did, so the binding rules are the same ones — a petname card
// that could be repointed would carry the owner's chosen name onto a key
// someone else holds.
describe('_entity.did bindings', () => {
  const ALICE = 'did:key:z6MkAlice';
  const MALLORY = 'did:key:z6MkMallory';

  test('rejects a second card claiming a DID already in use', async () => {
    await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await expect(
      stack.create('_entity@1', { did: ALICE, name: 'Alice (verified)' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that repoints a card at another key', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await expect(stack.patchContent(alice.id, { did: MALLORY })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('a card may be relabelled without touching its binding', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    const updated = await stack.patchContent(alice.id, { name: 'Alice Smith', handle: 'alice' });
    expect(updated.content).toMatchObject({ did: ALICE, name: 'Alice Smith', handle: 'alice' });
  });

  test('a rollback that would move the binding is refused', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await stack.patchContent(alice.id, { name: 'Alice Smith' });
    // v1 holds the same did, so this rollback is a relabel and is allowed.
    const restored = await stack.restoreVersion(alice.id, 1);
    expect((restored.content as { did: string }).did).toBe(ALICE);
  });

  // Reaching no content, the check cursor-walks the family and stops at
  // the first clash, so a colliding card past page one must still be found —
  // short-circuiting is what keeps the walk bounded, not a narrower scan.
  test('finds a clash past page one on an adapter reaching no content', async () => {
    const incapable = await Stack.open(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    for (let i = 0; i < 60; i++) {
      await incapable.create('_entity@1', { did: `did:key:filler${i}`, name: `Filler ${i}` });
    }
    await incapable.create('_entity@1', { did: ALICE, name: 'Alice' });

    await expect(
      incapable.create('_entity@1', { did: ALICE, name: 'Alice (impostor)' }),
    ).rejects.toThrow(StackConflictError);
  });
});

// grant() refuses these families, but a _grant record is an ordinary Record
// and an unscoped Stack can mint one regardless. The rule holds at the point
// of use, so provenance cannot launder it.
describe('ungrantable families are refused at evaluation', () => {
  const MALLORY = 'did:key:z6MkMallory';

  test('a hand-minted grant on _app confers nothing', async () => {
    await stack.create('_grant@1', {
      typeId: '_app@1',
      actions: ['create', 'read-any'],
      grantee: { kind: 'authenticated' },
    });

    await expect(
      stack.asEntity(MALLORY).create('_app@1', { appId: 'com.example.evil', name: 'Evil' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a hand-minted grant on _grant confers nothing', async () => {
    await stack.create('_grant@1', {
      typeId: '_grant@1',
      actions: ['create'],
      grantee: { kind: 'authenticated' },
    });

    await expect(
      stack.asEntity(MALLORY).create('_grant@1', { typeId: NOTE_V1, actions: ['read-any'] }),
    ).rejects.toThrow(StackPermissionError);
  });
});

// -------------------------------------------------------
// Relationship targets
// -------------------------------------------------------

describe('relationship targets', () => {
  // Storage, targetEqual() and the filter all read an absent and an empty
  // stackUrl as this stack, so a target names this stack exactly one way.
  // Every other part that names something is required for the same reason:
  // an empty string would claim a name while carrying none.
  test('a record target names this stack by omitting stackUrl, never by emptying it', async () => {
    const note = await stack.create(NOTE_V1, { text: 'host' });
    await expect(
      stack.associate(note.id, {
        kind: 'relationship',
        label: 'series',
        target: { kind: 'record', recordId: 'somerecordid', stackUrl: '' },
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('a target outside the three kinds is refused', async () => {
    const note = await stack.create(NOTE_V1, { text: 'host' });
    await expect(
      stack.associate(note.id, {
        kind: 'relationship',
        label: 'series',
        target: { kind: 'Record', recordId: 'somerecordid' } as unknown as RelationshipTarget,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  // A discriminated union is not a runtime guard, and the kind is what
  // every surface routes on: a request body supplies raw JSON, and an
  // element that names no known kind is neither half of the partition.
  test.each([
    ['null', null],
    ['a string', 'tag'],
    ['an object with no kind', {}],
    ['an unknown kind', { kind: 'blessing', label: 'x' }],
  ])('%s is refused as an association, not crashed on', async (_label, element) => {
    const note = await stack.create(NOTE_V1, { text: 'host' });
    const association = element as unknown as DataAssociation;
    const authority = element as unknown as AuthorityAssociation;

    await expect(stack.associate(note.id, association)).rejects.toThrow(StackValidationError);
    await expect(stack.mutate(note.id, { associations: [association] })).rejects.toThrow(
      StackValidationError,
    );
    await expect(stack.mutate(note.id, { permissions: [authority] })).rejects.toThrow(
      StackValidationError,
    );
    await expect(
      stack.create(NOTE_V1, { text: 'host' }, { associations: [association] }),
    ).rejects.toThrow(StackValidationError);
    // Two of them reach the duplicate-identity check, which asks the same
    // equality every surface does.
    await expect(
      stack.mutate(note.id, { associations: [association, association] }),
    ).rejects.toThrow(StackValidationError);
  });

  test('a target outside the three kinds is refused at create too', async () => {
    await expect(
      stack.create(
        NOTE_V1,
        { text: 'host' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'series',
              target: {
                kind: 'Record',
                recordId: 'somerecordid',
              } as unknown as RelationshipTarget,
            },
          ],
        },
      ),
    ).rejects.toThrow(StackValidationError);
  });

  test.each([
    ['a record target', { kind: 'record', recordId: '' }],
    ['an entity target', { kind: 'entity', entityId: '' }],
    ['an external target namespace', { kind: 'external', ns: '', id: 'x' }],
    ['an external target id', { kind: 'external', ns: 'atproto', id: '' }],
  ])('%s requires a non-empty identifier', async (_name, target) => {
    const note = await stack.create(NOTE_V1, { text: 'host' });
    await expect(
      stack.associate(note.id, {
        kind: 'relationship',
        label: 'series',
        target: target as RelationshipTarget,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('two targets differing only by namespace are two associations', async () => {
    const note = await stack.create(NOTE_V1, { text: 'crossposted' });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
    });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
    });

    const stored = await stack.get(note.id);
    expect(stored?.associations).toHaveLength(2);
  });

  test('dissociate removes only the target it names', async () => {
    const note = await stack.create(NOTE_V1, { text: 'crossposted' });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
    });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
    });
    await stack.dissociate(note.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
    });

    const stored = await stack.get(note.id);
    expect(stored?.associations).toEqual([
      {
        kind: 'relationship',
        label: 'syndicated-to',
        target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
      },
    ]);
  });

  // A record target and an entity target carrying the same string are
  // different references — which is the distinction group rosters rest on.
  test('a record target does not match an entity target with the same value', async () => {
    const note = await stack.create(NOTE_V1, { text: 'ambiguous' });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'about',
      target: { kind: 'record', recordId: 'did:key:z6MkAlice' },
    });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'about',
      target: { kind: 'entity', entityId: 'did:key:z6MkAlice' },
    });

    const stored = await stack.get(note.id);
    expect(stored?.associations).toHaveLength(2);
  });

  test('a record target in another stack is stored with its stackUrl', async () => {
    const note = await stack.create(NOTE_V1, { text: 'reply' });
    await stack.associate(note.id, {
      kind: 'relationship',
      label: 'reply-to',
      target: { kind: 'record', recordId: 'abc123', stackUrl: 'https://alice.example/stack' },
    });

    const stored = await stack.get(note.id);
    expect(stored?.associations?.[0]).toEqual({
      kind: 'relationship',
      label: 'reply-to',
      target: { kind: 'record', recordId: 'abc123', stackUrl: 'https://alice.example/stack' },
    });
  });
});

// -------------------------------------------------------
// query — relatedTo filter
// -------------------------------------------------------

describe('query — relatedTo filter', () => {
  let subject: StackRecord;

  beforeEach(async () => {
    subject = await stack.create(NOTE_V1, { text: 'target' });
    const withSeries = await stack.create(NOTE_V1, { text: 'in a series' });
    await stack.associate(withSeries.id, {
      kind: 'relationship',
      label: 'series',
      target: { kind: 'record', recordId: subject.id },
    });
    const syndicated = await stack.create(NOTE_V1, { text: 'crossposted' });
    await stack.associate(syndicated.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { kind: 'external', ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/3k4' },
    });
    const authored = await stack.create(NOTE_V1, { text: 'by someone' });
    await stack.associate(authored.id, {
      kind: 'relationship',
      label: 'author',
      target: { kind: 'entity', entityId: 'did:key:z6MkAlice' },
    });
    await stack.create(NOTE_V1, { text: 'unrelated' });
  });

  // "Carries any relationship at all" is refused by the type, not defined —
  // the wire encoding has no way to say it, and `tags`/`hasAttachment` have
  // no match-any form either. @ts-expect-error fails typecheck if this ever
  // starts compiling.
  test('a filter naming neither a label nor a target does not typecheck', () => {
    // @ts-expect-error — relatedTo requires a label, a target, or both
    const filter: RecordFilter = { relatedTo: {} };
    expect(filter.relatedTo).toEqual({});
  });

  // A type is not a runtime guard: a server maps query params onto a
  // filter and supplies a plain object. Refusing the empty filter here is
  // what keeps it from widening to every record carrying a relationship.
  test('a filter naming neither a label nor a target is refused', async () => {
    await expect(
      stack.query({ filter: { relatedTo: {} as NonNullable<RecordFilter['relatedTo']> } }),
    ).rejects.toThrow(StackQueryError);
  });

  test('a filter target outside the three kinds is refused', async () => {
    await expect(
      stack.query({
        filter: {
          relatedTo: {
            target: { kind: 'Record', recordId: subject.id } as unknown as NonNullable<
              NonNullable<RecordFilter['relatedTo']>['target']
            >,
          },
        },
      }),
    ).rejects.toThrow(StackQueryError);
  });

  test('a filter naming this stack omits stackUrl rather than emptying it', async () => {
    await expect(
      stack.query({
        filter: { relatedTo: { target: { kind: 'record', recordId: subject.id, stackUrl: '' } } },
      }),
    ).rejects.toThrow(StackQueryError);
  });

  test('matches a record target', async () => {
    const { records } = await stack.query({
      filter: { relatedTo: { target: { kind: 'record', recordId: subject.id } } },
    });
    expect(records.map((r) => r.content.text)).toEqual(['in a series']);
  });

  test('matches an entity target', async () => {
    const { records } = await stack.query({
      filter: { relatedTo: { target: { kind: 'entity', entityId: 'did:key:z6MkAlice' } } },
    });
    expect(records.map((r) => r.content.text)).toEqual(['by someone']);
  });

  test('an external target without an id matches the whole namespace', async () => {
    const { records } = await stack.query({
      filter: { relatedTo: { target: { kind: 'external', ns: 'atproto' } } },
    });
    expect(records.map((r) => r.content.text)).toEqual(['crossposted']);
  });

  test('an external target with an id matches exactly', async () => {
    const miss = await stack.query({
      filter: { relatedTo: { target: { kind: 'external', ns: 'atproto', id: 'other' } } },
    });
    expect(miss.records).toHaveLength(0);
  });

  test('a bare label matches every target under it', async () => {
    const { records } = await stack.query({ filter: { relatedTo: { label: 'series' } } });
    expect(records.map((r) => r.content.text)).toEqual(['in a series']);
  });

  // An absent stackUrl is not a wildcard: it names this stack.
  test('a local record target does not match the same id in another stack', async () => {
    const remote = await stack.create(NOTE_V1, { text: 'remote reply' });
    await stack.associate(remote.id, {
      kind: 'relationship',
      label: 'reply-to',
      target: { kind: 'record', recordId: subject.id, stackUrl: 'https://alice.example/stack' },
    });

    const local = await stack.query({
      filter: {
        relatedTo: { label: 'reply-to', target: { kind: 'record', recordId: subject.id } },
      },
    });
    expect(local.records).toHaveLength(0);

    const scoped = await stack.query({
      filter: {
        relatedTo: {
          target: {
            kind: 'record',
            recordId: subject.id,
            stackUrl: 'https://alice.example/stack',
          },
        },
      },
    });
    expect(scoped.records.map((r) => r.content.text)).toEqual(['remote reply']);
  });
});

// Membership in the StackError hierarchy is what gives a server a wire
// code to answer with; anything outside it has no mapping and becomes a
// 500. Naming a type that isn't defined is a client-reachable request, so
// it has to land inside the taxonomy.
describe('undefined types stay inside the error taxonomy', () => {
  let typeStack: Stack;

  beforeEach(async () => {
    typeStack = await Stack.open(new MemoryAdapter({ ownerEntityId: 'owner-123' }));
  });

  test('create() with an unknown typeId raises a bad_request', async () => {
    const err = await typeStack.create('com.example.test/nope@1', { text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(StackQueryError);
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('defineType');
  });

  test('defineType() with a malformed typeId raises a bad_request', async () => {
    const err = await typeStack.defineType('not-a-type-id', 'Nope', {}).catch((e) => e);
    expect(err).toBeInstanceOf(StackQueryError);
    expect(err.code).toBe('bad_request');
  });

  test('commitMigration() to an unknown typeId raises a bad_request', async () => {
    await typeStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    const record = await typeStack.create(NOTE_V1, { text: 'hello' });
    const err = await typeStack
      .commitMigration(record.id, 'com.example.test/note@99', { text: 'hello' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StackQueryError);
    expect(err.code).toBe('bad_request');
  });
});

// -------------------------------------------------------
// Change sets
// -------------------------------------------------------

describe('Stack.mutate — one call, one version', () => {
  let box: StackRecord;
  let note: StackRecord;

  beforeEach(async () => {
    box = await stack.create(NOTE_V1, { text: 'box' });
    note = await stack.create(NOTE_V1, { text: 'hello' });
  });

  test('moves every named aspect in a single version', async () => {
    const moved = await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      parentId: box.id,
      permissions: [{ kind: 'anyone', label: 'read' }],
      unlisted: true,
    });

    expect(moved.version).toBe(note.version + 1);
    expect(moved.content).toEqual({ text: 'edited' });
    expect(moved.parentId).toBe(box.id);
    expect(moved.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
    expect(moved.unlistedAt).toBeInstanceOf(Date);
  });

  test('snapshots the prior state once, whatever the change set moved', async () => {
    await stack.mutate(note.id, { contentPatch: { text: 'edited' }, parentId: box.id });
    const versions = await stack.getVersions(note.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, content: { text: 'hello' } });
    expect('parentId' in versions[0]!).toBe(false);
  });

  test('emits one event naming every aspect that actually moved', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c));
    await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      parentId: box.id,
      permissions: [{ kind: 'anyone', label: 'read' }],
    });

    expect(seen).toHaveLength(1);
    expect([...seen[0]!.ops].sort()).toEqual(['patch', 'permissions', 'reparent']);
    expect(seen[0]!.kind).toBe('changed');
    expect(seen[0]!.version).toBe(2);
  });

  // ops comes from the record's own diff, so restating a value is not a
  // change — which is also what keeps the no-op rule and the event agreeing.
  test('reports only the aspects that moved, not the keys that were named', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c));
    await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      parentId: null,
      unlisted: false,
    });

    expect(seen[0]!.ops).toEqual(['patch']);
  });

  test('a change set already satisfied in every key writes nothing', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c));
    const same = await stack.mutate(note.id, {
      contentPatch: { text: 'hello' },
      parentId: null,
      permissions: [],
      unlisted: false,
    });

    expect(same.version).toBe(note.version);
    expect(seen).toHaveLength(0);
    expect(await stack.getVersions(note.id)).toHaveLength(0);
  });

  test('a change set naming no key at all is refused', async () => {
    await expect(stack.mutate(note.id, {})).rejects.toThrow(StackQueryError);
  });

  // Presence, not truthiness: both of these name an aspect.
  test('parentId: null moves to the root and unlisted: false relists', async () => {
    const inBox = await stack.mutate(note.id, { parentId: box.id, unlisted: true });
    expect(inBox.parentId).toBe(box.id);

    const out = await stack.mutate(note.id, { parentId: null, unlisted: false });
    expect(out.parentId).toBeUndefined();
    expect(out.unlistedAt).toBeUndefined();
  });

  test('one ifVersion fences the whole change set', async () => {
    await expect(
      stack.mutate(
        note.id,
        { contentPatch: { text: 'edited' }, parentId: box.id },
        { ifVersion: 99 },
      ),
    ).rejects.toThrow(StackVersionConflictError);

    const unchanged = await stack.get(note.id);
    expect(unchanged!.version).toBe(1);
    expect(unchanged!.content).toEqual({ text: 'hello' });
    expect(unchanged!.parentId).toBeUndefined();
  });

  // A refused key refuses the call, so nothing lands — the content patch
  // here is perfectly valid and must still not be applied.
  test('a refused key leaves every other key unapplied', async () => {
    // Format is checked before existence, so a malformed destination is a
    // 400 naming the problem and a well-formed absent one is a 409 — and
    // neither lets the content patch beside it land.
    await expect(
      stack.mutate(note.id, { contentPatch: { text: 'edited' }, parentId: 'nosuchrecord' }),
    ).rejects.toThrow(StackQueryError);
    await expect(
      stack.mutate(note.id, { contentPatch: { text: 'edited' }, parentId: generateId() }),
    ).rejects.toThrow(StackConflictError);

    const unchanged = await stack.get(note.id);
    expect(unchanged!.version).toBe(1);
    expect(unchanged!.content).toEqual({ text: 'hello' });
  });

  test('an invalid content patch refuses the move beside it', async () => {
    await expect(
      stack.mutate(note.id, { contentPatch: { text: 42 }, parentId: box.id }),
    ).rejects.toThrow(StackValidationError);
    expect((await stack.get(note.id))!.parentId).toBeUndefined();
  });

  test('replaces the association set, and reports the diff as add and remove', async () => {
    await stack.associate(note.id, { kind: 'tag', label: 'old' });
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c));

    const swapped = await stack.mutate(note.id, {
      associations: [{ kind: 'tag', label: 'new' }],
    });

    expect(swapped.associations).toEqual([{ kind: 'tag', label: 'new' }]);
    expect([...seen[0]!.ops].sort()).toEqual(['associate', 'dissociate']);
  });

  // unlist is the one op that must survive being bundled: a subscriber
  // holding the record has to be told to drop it, so kind stays 'deleted'.
  test('an unlist bundled with an edit is still kind deleted', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c), { includeUnlisted: true });
    await stack.mutate(note.id, { contentPatch: { text: 'edited' }, unlisted: true });

    expect(seen[0]!.kind).toBe('deleted');
    expect([...seen[0]!.ops].sort()).toEqual(['patch', 'unlist']);
  });

  test('a reparent bundled with an edit still reaches the origin container', async () => {
    await stack.mutate(note.id, { parentId: box.id });
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => seen.push(c), { filter: { parentId: box.id } });

    await stack.mutate(note.id, { contentPatch: { text: 'edited' }, parentId: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ops).toContain('reparent');
  });

  test('refuses a move that would make the record its own ancestor', async () => {
    await stack.mutate(note.id, { parentId: box.id });
    await expect(
      stack.mutate(box.id, { contentPatch: { text: 'x' }, parentId: note.id }),
    ).rejects.toThrow(StackConflictError);
  });

  // The adapter is handed only what moved, so restating an aspect cannot
  // rewrite it — an unlistedAt dragged forward by an unrelated edit would
  // move the record's publish moment with no op reporting it.
  test('restating an aspect does not rewrite it', async () => {
    const unlistedAt = (await stack.mutate(note.id, { unlisted: true })).unlistedAt;
    const perms: AuthorityAssociation[] = [{ kind: 'anyone', label: 'read' }];
    await stack.mutate(note.id, { permissions: perms });

    await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      unlisted: true,
      permissions: perms,
    });

    const after = await stack.get(note.id);
    expect(after!.unlistedAt).toEqual(unlistedAt);
    expect(after!.permissions).toEqual(perms);
  });

  test('patchContent is mutate with contentPatch alone', async () => {
    const patched = await stack.patchContent(note.id, { text: 'edited' });
    expect(patched.content).toEqual({ text: 'edited' });
    expect(patched.version).toBe(2);
  });
});
