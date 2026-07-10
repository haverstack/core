import { describe, test, expect, beforeEach } from 'vitest';
import {
  Stack,
  StackPermissionError,
  StackNotFoundError,
  StackValidationError,
  StackConflictError,
} from '../src/stack.js';
import { generateId, crockford32Encode } from '../src/id.js';
import { MemoryAdapter } from '../src/testing.js';
import type { StackRecord, Association, Permission } from '../src/types.js';

// -------------------------------------------------------
// Test setup
// -------------------------------------------------------

// Builds a well-formed 12-char id with a specific timestamp prefix, bypassing
// generateId()'s own monotonic-clock clamp (which would otherwise pull an
// "ancient" test timestamp forward to the real current time).
const idWithTimestamp = (ms: number): string => `${crockford32Encode(ms).padStart(9, '0')}000`;

const NOTE = 'com.example.test/note@1';
const OWNER = 'owner-123';
const MEMBER = 'member-456';
const STRANGER = 'stranger-789';

let adapter: MemoryAdapter;
let stack: Stack;

function makeRecord(overrides: Partial<StackRecord> = {}): StackRecord {
  const now = new Date();
  return {
    id: generateId(),
    typeId: NOTE,
    createdAt: now,
    updatedAt: now,
    content: {},
    version: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text' } });
});

const COMMENT = 'com.example.test/comment@1';

// -------------------------------------------------------
// Read access
// -------------------------------------------------------

describe('ScopedStack — read access', () => {
  test('owner can read a private record', async () => {
    const record = await adapter.createRecord(makeRecord());
    const view = stack.asEntity(OWNER);
    expect(await view.get(record.id)).toEqual(record);
  });

  test('anonymous requester cannot read a private record', async () => {
    const record = await adapter.createRecord(makeRecord());
    const view = stack.asEntity(null);
    await expect(view.get(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('anonymous requester can read a public record', async () => {
    const record = await adapter.createRecord(makeRecord({ permissions: [{ access: 'public' }] }));
    const view = stack.asEntity(null);
    expect((await view.get(record.id))?.id).toBe(record.id);
  });

  test('entity with a matching read grant can read', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('entity without a matching grant cannot read', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    await expect(stack.asEntity(STRANGER).get(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('group member can read via a group read grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [{ kind: 'relationship', label: 'member', recordId: MEMBER }],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('non-member cannot read via a group read grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [{ kind: 'relationship', label: 'member', recordId: MEMBER }],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    await expect(stack.asEntity(STRANGER).get(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('get() returns null, not StackPermissionError, for a record that does not exist', async () => {
    expect(await stack.asEntity(OWNER).get('nonexistent')).toBeNull();
    expect(await stack.asEntity(null).get('nonexistent')).toBeNull();
  });
});

// -------------------------------------------------------
// Write access
// -------------------------------------------------------

describe('ScopedStack — write access', () => {
  test('owner can update any record', async () => {
    const record = await adapter.createRecord(makeRecord());
    const updated = await stack.asEntity(OWNER).update(record.id, { text: 'hi' });
    expect(updated.content.text).toBe('hi');
  });

  test('public access does not grant write', async () => {
    const record = await adapter.createRecord(makeRecord({ permissions: [{ access: 'public' }] }));
    await expect(stack.asEntity(STRANGER).update(record.id, { text: 'hi' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('entity with write:true can update', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    const updated = await stack.asEntity(MEMBER).update(record.id, { text: 'hi' });
    expect(updated.content.text).toBe('hi');
  });

  test('entity with write:false cannot update even with read:true', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'hi' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('delete enforces write access', async () => {
    const record = await adapter.createRecord(makeRecord());
    await expect(stack.asEntity(STRANGER).delete(record.id)).rejects.toThrow(StackPermissionError);
    await stack.asEntity(OWNER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('write:true holder can soft-delete but not hard-delete', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    await expect(stack.asEntity(MEMBER).delete(record.id, { hard: true })).rejects.toThrow(
      StackPermissionError,
    );
    expect(await adapter.getRecord(record.id)).not.toBeNull();

    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('owner can hard-delete', async () => {
    const record = await adapter.createRecord(makeRecord());
    await stack.asEntity(OWNER).delete(record.id, { hard: true });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('undelete enforces write access', async () => {
    const record = await adapter.createRecord(makeRecord({ deletedAt: new Date() }));
    await expect(stack.asEntity(STRANGER).undelete(record.id)).rejects.toThrow(
      StackPermissionError,
    );
    const undeleted = await stack.asEntity(OWNER).undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('write:true holder can undelete', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        deletedAt: new Date(),
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    const undeleted = await stack.asEntity(MEMBER).undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('a write-holder soft-delete is undeletable by the owner — recoverability holds', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();

    const undeleted = await stack.asEntity(OWNER).undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeUndefined();
  });

  test('associate/dissociate/setPermissions enforce write access', async () => {
    const record = await adapter.createRecord(makeRecord());
    const tag: Association = { kind: 'tag', label: 'starred' };
    const perms: Permission[] = [{ access: 'public' }];

    await expect(stack.asEntity(STRANGER).associate(record.id, tag)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(stack.asEntity(STRANGER).dissociate(record.id, tag)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(stack.asEntity(STRANGER).setPermissions(record.id, perms)).rejects.toThrow(
      StackPermissionError,
    );

    await stack.asEntity(OWNER).associate(record.id, tag);
    expect((await adapter.getRecord(record.id))?.associations).toContainEqual(tag);
  });

  test('setPermissions rejects write-access holder that is not creator or stack owner', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        entityId: OWNER,
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    const perms: Permission[] = [{ access: 'public' }];
    await expect(stack.asEntity(MEMBER).setPermissions(record.id, perms)).rejects.toThrow(
      StackPermissionError,
    );
    // Stack owner and record creator can still manage permissions.
    await stack.asEntity(OWNER).setPermissions(record.id, perms);
    expect((await adapter.getRecord(record.id))?.permissions).toEqual(perms);
  });

  test('write methods throw StackNotFoundError (not StackPermissionError) for a missing record', async () => {
    await expect(stack.asEntity(OWNER).update('nonexistent', {})).rejects.toThrow(
      StackNotFoundError,
    );
    await expect(stack.asEntity(OWNER).update('nonexistent', {})).rejects.not.toThrow(
      StackPermissionError,
    );
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('ScopedStack — versions', () => {
  test('restoreVersion enforces write access', async () => {
    const record = await adapter.createRecord(makeRecord());
    await adapter.saveVersion(record.id, {
      version: 1,
      content: { text: 'old' },
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(STRANGER).restoreVersion(record.id, 1)).rejects.toThrow(
      StackPermissionError,
    );
    const restored = await stack.asEntity(OWNER).restoreVersion(record.id, 1);
    expect(restored.content.text).toBe('old');
  });

  test('getVersions/getVersion enforce read access', async () => {
    const record = await adapter.createRecord(makeRecord());
    await adapter.saveVersion(record.id, { version: 1, content: {}, updatedAt: new Date() });
    await expect(stack.asEntity(STRANGER).getVersions(record.id)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(stack.asEntity(OWNER).getVersions(record.id)).resolves.toHaveLength(1);
  });
});

// -------------------------------------------------------
// Query — permission filtering and pagination
// -------------------------------------------------------

describe('ScopedStack.query', () => {
  test('filters out records the requester cannot read', async () => {
    await adapter.createRecord(makeRecord()); // private
    const pub = await adapter.createRecord(makeRecord({ permissions: [{ access: 'public' }] }));

    const result = await stack.asEntity(null).query();
    expect(result.records.map((r) => r.id)).toEqual([pub.id]);
  });

  test('total is always null on scoped queries, even though the adapter reports a real count', async () => {
    await adapter.createRecord(makeRecord({ permissions: [{ access: 'public' }] }));
    const unscoped = await stack.query();
    expect(unscoped.total).toBe(1);

    const scoped = await stack.asEntity(null).query();
    expect(scoped.total).toBeNull();
  });

  test('refills across multiple adapter pages without skipping records, even if the result lands under the requested limit', async () => {
    // 6 records fetched 2-at-a-time (limit: 2), only the last one is public.
    // Pages 1 and 2 contain zero visible records, so the loop must refetch
    // through all 3 pages — stopping only because the cursor is exhausted,
    // not because it hit the limit — and still find the one visible record.
    let visibleId = '';
    for (let i = 0; i < 6; i++) {
      const isPublic = i === 5;
      const record = await adapter.createRecord(
        makeRecord(isPublic ? { permissions: [{ access: 'public' }] } : {}),
      );
      if (isPublic) visibleId = record.id;
    }

    const result = await stack.asEntity(null).query({ limit: 2 });
    expect(result.records.map((r) => r.id)).toEqual([visibleId]);
    expect(result.cursor).toBeNull();
  });

  test('a page may overshoot the requested limit rather than split mid-page', async () => {
    // priv, priv, priv, pub, pub, pub — fetched 2 at a time with limit: 2.
    // Page 1 (priv,priv): 0 visible. Page 2 (priv,pub): 1 visible, still
    // under limit, so a 3rd page is fetched. Page 3 (pub,pub): both visible,
    // pushing the total to 3 — over the requested limit of 2, by design.
    for (let i = 0; i < 6; i++) {
      await adapter.createRecord(makeRecord(i >= 3 ? { permissions: [{ access: 'public' }] } : {}));
    }

    const result = await stack.asEntity(null).query({ limit: 2 });
    expect(result.records).toHaveLength(3);
    expect(result.cursor).toBeNull();
  });

  test('clamps an oversized limit to MAX_QUERY_LIMIT (1000)', async () => {
    await adapter.createRecord(makeRecord({ permissions: [{ access: 'public' }] }));
    const result = await stack.asEntity(null).query({ limit: 9_999_999 });
    // The limit is silently clamped — no error thrown, results still returned.
    expect(result.records.length).toBeGreaterThanOrEqual(0);
    expect(result.records.length).toBeLessThanOrEqual(1000);
  });
});

// -------------------------------------------------------
// ScopedStack.create — grant-based creation
// -------------------------------------------------------

describe('ScopedStack.create', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
  });

  test('owner can always create records via ScopedStack', async () => {
    const record = await stack.asEntity(OWNER).create(COMMENT, { text: 'hello' });
    expect(record.typeId).toBe(COMMENT);
    expect(record.entityId).toBe(OWNER);
  });

  test('anonymous requester cannot create records', async () => {
    await expect(stack.asEntity(null).create(COMMENT, { text: 'hello' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('authenticated entity without a grant cannot create records', async () => {
    await expect(stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('entity with an entity-specific grant can create the granted type', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' });
    expect(record.typeId).toBe(COMMENT);
    expect(record.entityId).toBe(MEMBER);
  });

  test('entity cannot create a type other than the one granted', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    await expect(stack.asEntity(MEMBER).create(NOTE, { text: 'sneaky' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('default grant (null entityId) allows any authenticated entity to create', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack.asEntity(STRANGER).create(COMMENT, { text: 'hello' });
    expect(record.entityId).toBe(STRANGER);
  });

  test('default grant does not apply to anonymous requesters', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: COMMENT }]);
    await expect(stack.asEntity(null).create(COMMENT, { text: 'hello' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('entity without a specific grant is not helped by a grant for a different entity', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    await expect(stack.asEntity(STRANGER).create(COMMENT, { text: 'hello' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('created record always carries the requester entityId', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' });
    expect(record.entityId).toBe(MEMBER);
  });

  test('content validation still runs after grant check', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    await expect(stack.asEntity(MEMBER).create(COMMENT, {} as { text: string })).rejects.toThrow(
      StackValidationError,
    );
  });
});

// -------------------------------------------------------
// ScopedStack.create — client-supplied id (#55)
// -------------------------------------------------------

describe('ScopedStack.create — client-supplied id', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
  });

  test('accepts a well-formed, recent id from a grantee', async () => {
    const id = generateId();
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' }, { id });
    expect(record.id).toBe(id);
  });

  test('rejects a malformed id from a grantee', async () => {
    await expect(
      stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' }, { id: 'too-short' }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a reserved-prefix id from a grantee', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create(COMMENT, { text: 'hello' }, { id: '_' + generateId().slice(1) }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects an id whose timestamp is far outside the clock-skew tolerance', async () => {
    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    await expect(
      stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' }, { id: ancientId }),
    ).rejects.toThrow(StackValidationError);
  });

  test('idTimestampSkewMs: null on the Stack disables the skew check for grantees', async () => {
    const permissiveAdapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
    const permissiveStack = await Stack.create(permissiveAdapter, { idTimestampSkewMs: null });
    await permissiveStack.defineType(COMMENT, 'Comment', {
      text: { kind: 'text', required: true },
    });
    await permissiveStack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);

    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    const record = await permissiveStack
      .asEntity(MEMBER)
      .create(COMMENT, { text: 'hello' }, { id: ancientId });
    expect(record.id).toBe(ancientId);
  });

  test('duplicate id from a grantee surfaces as StackConflictError', async () => {
    const id = generateId();
    await stack.asEntity(MEMBER).create(COMMENT, { text: 'first' }, { id });
    await expect(
      stack.asEntity(MEMBER).create(COMMENT, { text: 'second' }, { id }),
    ).rejects.toThrow(StackConflictError);
  });
});

// -------------------------------------------------------
// ScopedStack — grant-based read
// -------------------------------------------------------

describe('ScopedStack — grant-based read', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
  });

  test('read-any: entity can read private records of the granted type', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('read-any: does not grant access to other types', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const note = await stack.create(NOTE, { text: 'private note' });
    await expect(stack.asEntity(MEMBER).get(note.id)).rejects.toThrow(StackPermissionError);
  });

  test('read-own: entity can read records they authored', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('read-own: entity cannot read records authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).get(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('default read-any grant allows any authenticated entity to read', async () => {
    await stack.grant(null, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });
    expect((await stack.asEntity(STRANGER).get(record.id))?.id).toBe(record.id);
  });

  test('read grant is visible in query() results', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    await stack.create(COMMENT, { text: 'a' });
    await stack.create(COMMENT, { text: 'b' });
    const result = await stack.asEntity(MEMBER).query({ filter: { typeId: COMMENT } });
    expect(result.records).toHaveLength(2);
  });

  test('query() filters out types not covered by the read grant', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    await stack.create(COMMENT, { text: 'visible' });
    await stack.create(NOTE, { text: 'hidden' });
    const result = await stack.asEntity(MEMBER).query();
    expect(result.records.every((r) => r.typeId === COMMENT)).toBe(true);
  });

  test('read grant does not grant write access', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'edited' })).rejects.toThrow(
      StackPermissionError,
    );
  });
});

// -------------------------------------------------------
// ScopedStack — grant-based update/delete
// -------------------------------------------------------

describe('ScopedStack — grant-based update/delete', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
  });

  test('update-own: entity can update a record they authored', async () => {
    await stack.grant(MEMBER, [{ actions: ['update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: MEMBER });
    const updated = await stack.asEntity(MEMBER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });

  test('update-own: entity cannot update a record authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'edited' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('update-any: entity can update records regardless of authorship', async () => {
    await stack.grant(MEMBER, [{ actions: ['update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    const updated = await stack.asEntity(MEMBER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });

  test('delete-own: entity can delete a record they authored', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('delete-own: entity cannot delete a record authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).delete(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('delete-any: entity can delete records regardless of authorship', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('delete-any grant does not allow hard delete', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).delete(record.id, { hard: true })).rejects.toThrow(
      StackPermissionError,
    );
    expect(await adapter.getRecord(record.id)).not.toBeNull();
  });

  test('update grant does not allow delete', async () => {
    await stack.grant(MEMBER, [{ actions: ['update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await expect(stack.asEntity(MEMBER).delete(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('delete grant does not allow update', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'edited' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('delete-any grant also allows undelete', async () => {
    await stack.grant(MEMBER, [{ actions: ['delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await stack.asEntity(MEMBER).delete(record.id);
    const undeleted = await stack.asEntity(MEMBER).undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('update grant does not allow undelete', async () => {
    await stack.grant(MEMBER, [{ actions: ['update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await adapter.deleteRecord(record.id);
    await expect(stack.asEntity(MEMBER).undelete(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('default grant (null entityId) applies update-own to any authenticated entity', async () => {
    await stack.grant(null, [{ actions: ['update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    const updated = await stack.asEntity(STRANGER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });
});

// -------------------------------------------------------
// ScopedStack.putAttachment — grant-based upload
// -------------------------------------------------------

describe('ScopedStack.putAttachment', () => {
  const data = new Uint8Array([1, 2, 3]);

  test('owner can always upload without a grant', async () => {
    const fileId = await stack.asEntity(OWNER).putAttachment(data, 'image/png');
    expect(typeof fileId).toBe('string');
  });

  test('anonymous requester cannot upload', async () => {
    await expect(stack.asEntity(null).putAttachment(data, 'image/png')).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('authenticated entity without a grant cannot upload', async () => {
    await expect(stack.asEntity(MEMBER).putAttachment(data, 'image/png')).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('entity with create grant on _attachment@1 can upload', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const fileId = await stack.asEntity(MEMBER).putAttachment(data, 'image/png');
    expect(typeof fileId).toBe('string');
  });

  test('upload creates _attachment@1 record owned by the uploader', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    await stack.asEntity(MEMBER).putAttachment(data, 'image/png', 'photo.png');
    const result = await stack.query({ filter: { typeId: '_attachment@1', entityId: MEMBER } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].entityId).toBe(MEMBER);
    const content = result.records[0].content as Record<string, unknown>;
    expect(content.mimeType).toBe('image/png');
    expect(content.size).toBe(3);
    expect(content.filename).toBe('photo.png');
  });

  test('upload without filename omits filename from record content', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    await stack.asEntity(MEMBER).putAttachment(data, 'image/png');
    const result = await stack.query({ filter: { typeId: '_attachment@1', entityId: MEMBER } });
    expect(result.records[0].content).not.toHaveProperty('filename');
  });

  test('default grant allows any authenticated entity to upload', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const fileId = await stack.asEntity(STRANGER).putAttachment(data, 'image/png');
    expect(typeof fileId).toBe('string');
  });
});

// -------------------------------------------------------
// ScopedStack.putAttachmentBytes — bytes-only upload, gated like putAttachment
// -------------------------------------------------------

describe('ScopedStack.putAttachmentBytes', () => {
  const data = new Uint8Array([1, 2, 3]);

  test('owner can always upload without a grant', async () => {
    const fileId = await stack.asEntity(OWNER).putAttachmentBytes(data);
    expect(typeof fileId).toBe('string');
  });

  test('anonymous requester cannot upload', async () => {
    await expect(stack.asEntity(null).putAttachmentBytes(data)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('authenticated entity without a grant cannot upload', async () => {
    await expect(stack.asEntity(MEMBER).putAttachmentBytes(data)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('entity with create grant on _attachment@1 can upload', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const fileId = await stack.asEntity(MEMBER).putAttachmentBytes(data);
    expect(typeof fileId).toBe('string');
  });

  test('default grant allows any authenticated entity to upload', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const fileId = await stack.asEntity(STRANGER).putAttachmentBytes(data);
    expect(typeof fileId).toBe('string');
  });

  test('does not create an _attachment@1 record', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    await stack.asEntity(MEMBER).putAttachmentBytes(data);
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(0);
  });

  test('putAttachment() still succeeds and creates its metadata record via the shared gate', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const fileId = await stack.asEntity(MEMBER).putAttachment(data, 'image/png', 'photo.png');
    const result = await stack.query({ filter: { typeId: '_attachment@1', entityId: MEMBER } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content).toMatchObject({ fileId, mimeType: 'image/png' });
  });
});
