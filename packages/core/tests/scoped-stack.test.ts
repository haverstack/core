import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  Stack,
  StackPermissionError,
  StackNotFoundError,
  StackValidationError,
  StackConflictError,
  StackPayloadTooLargeError,
} from '../src/stack.js';
import { generateId, crockford32Encode } from '../src/id.js';
import { MemoryAdapter, IncapableMemoryAdapter } from '../src/testing.js';
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
    // version: 2 — the live record already moved past the v1 snapshot
    // below (simulating a prior edit), so restoreVersion()'s own
    // saveVersion(existing) snapshots version 2, not a colliding version 1.
    const record = await adapter.createRecord(makeRecord({ version: 2 }));
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE,
      content: { text: 'old' },
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(STRANGER).restoreVersion(record.id, 1)).rejects.toThrow(
      StackPermissionError,
    );
    const restored = await stack.asEntity(OWNER).restoreVersion(record.id, 1);
    expect(restored.content.text).toBe('old');
  });

  // history is the mutate/recovery surface, not a read surface — a
  // plain reader (read access but no write) must be denied, matching
  // update()/associate()'s gate exactly.
  test('getVersions/getVersion deny a read-only requester', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE,
      content: {},
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(MEMBER).getVersions(record.id)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(stack.asEntity(MEMBER).getVersion(record.id, 1)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('getVersions/getVersion allow a write-holder', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE,
      content: {},
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(MEMBER).getVersions(record.id)).resolves.toHaveLength(1);
    await expect(stack.asEntity(MEMBER).getVersion(record.id, 1)).resolves.not.toBeNull();
  });

  test('getVersions/getVersion strip snapshot permissions for a non-owner write-holder, but not for the owner', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE,
      content: {},
      updatedAt: new Date(),
      permissions: [{ access: 'entity', entityId: 'someone-else', read: true, write: false }],
    });

    const [memberList, memberSingle] = await Promise.all([
      stack.asEntity(MEMBER).getVersions(record.id),
      stack.asEntity(MEMBER).getVersion(record.id, 1),
    ]);
    expect(memberList[0].permissions).toBeUndefined();
    expect(memberSingle?.permissions).toBeUndefined();

    const [ownerList, ownerSingle] = await Promise.all([
      stack.asEntity(OWNER).getVersions(record.id),
      stack.asEntity(OWNER).getVersion(record.id, 1),
    ]);
    expect(ownerList[0].permissions).toEqual([
      { access: 'entity', entityId: 'someone-else', read: true, write: false },
    ]);
    expect(ownerSingle?.permissions).toEqual([
      { access: 'entity', entityId: 'someone-else', read: true, write: false },
    ]);
  });

  test('getVersions/getVersion on a group require admin, not just membership', async () => {
    const ADMIN = 'group-version-admin';
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group@1',
        associations: [
          { kind: 'relationship', label: 'admin', recordId: ADMIN },
          { kind: 'relationship', label: 'member', recordId: MEMBER },
        ],
      }),
    );
    await adapter.saveVersion(group.id, {
      version: 1,
      typeId: '_group@1',
      content: {},
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(MEMBER).getVersions(group.id)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(stack.asEntity(ADMIN).getVersions(group.id)).resolves.toHaveLength(1);
  });

  // Related follow-up: restoreVersion() restores associations/file-ref
  // fields straight from the snapshot, which for a non-owner write-holder
  // could re-convey access to a file or record they can no longer reach —
  // the reference was legitimate when created, but access moved on since.
  // Re-running the reference-creation checks against the snapshot closes
  // that: a write-holder may only restore references they could create fresh.
  describe('restoreVersion — reference-reconveyance gating', () => {
    test('rejects restoring an attachment association to a file the requester can no longer access', async () => {
      const record = await adapter.createRecord(
        makeRecord({
          version: 2,
          permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
        }),
      );
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: NOTE,
        content: {},
        updatedAt: new Date(),
        associations: [{ kind: 'attachment', label: 'x', fileId: 'unreachable-file' }],
      });
      await expect(stack.asEntity(MEMBER).restoreVersion(record.id, 1)).rejects.toThrow(
        StackPermissionError,
      );
    });

    test('allows restoring an attachment association to a file the requester can currently access', async () => {
      await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
      const {
        content: { fileId },
      } = await stack.asEntity(MEMBER).putAttachment(new Uint8Array([1]), 'image/png');
      const record = await adapter.createRecord(
        makeRecord({
          version: 2,
          permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
        }),
      );
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: NOTE,
        content: {},
        updatedAt: new Date(),
        associations: [{ kind: 'attachment', label: 'x', fileId }],
      });
      const restored = await stack.asEntity(MEMBER).restoreVersion(record.id, 1);
      expect(restored.associations).toContainEqual({ kind: 'attachment', label: 'x', fileId });
    });

    test('rejects restoring a file-ref content field the requester can no longer access', async () => {
      const PHOTO_NOTE = 'com.example.test/photo-note-restore@1';
      await stack.defineType(PHOTO_NOTE, 'Photo note', { coverFileId: { kind: 'file-ref' } });
      await stack.grant(MEMBER, [{ actions: ['update-any'], typeId: PHOTO_NOTE }]);
      const record = await adapter.createRecord(
        makeRecord({
          typeId: PHOTO_NOTE,
          version: 2,
          permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
        }),
      );
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: PHOTO_NOTE,
        content: { coverFileId: 'unreachable-file' },
        updatedAt: new Date(),
      });
      await expect(stack.asEntity(MEMBER).restoreVersion(record.id, 1)).rejects.toThrow(
        StackPermissionError,
      );
    });

    test('the owner is exempt from the reference-reconveyance gate', async () => {
      const record = await adapter.createRecord(makeRecord({ version: 2 }));
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: NOTE,
        content: {},
        updatedAt: new Date(),
        associations: [{ kind: 'attachment', label: 'x', fileId: 'anything-at-all' }],
      });
      const restored = await stack.asEntity(OWNER).restoreVersion(record.id, 1);
      expect(restored.associations).toContainEqual({
        kind: 'attachment',
        label: 'x',
        fileId: 'anything-at-all',
      });
    });
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
  });

  // A scoped write always names its author, so an absent entityId means
  // exactly one thing: an unscoped Stack wrote the record.
  test('owner writing through asEntity(ownerEntityId) stamps entityId', async () => {
    const record = await stack.asEntity(OWNER).create(COMMENT, { text: 'hello' });
    expect(record.entityId).toBe(OWNER);
    expect(record.principalId).toBeUndefined();
  });

  test('a non-owner entity still gets entityId stamped as the author', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hello' });
    expect(record.entityId).toBe(MEMBER);
  });

  // Owner bypasses grants entirely (checkAccess's owner shortcut), so an
  // owner-authored record carrying no entityId can never accidentally
  // satisfy a *different* requester's -own grant check — pinning the claim
  // that this normalization doesn't regress -own semantics.
  test('a stranger with a -own grant cannot use it against an owner-authored record', async () => {
    const ownerRecord = await stack.asEntity(OWNER).create(COMMENT, { text: 'hello' });
    await stack.grant(STRANGER, [{ actions: ['read-own', 'update-own'], typeId: COMMENT }]);
    const view = stack.asEntity(STRANGER);
    await expect(view.get(ownerRecord.id)).rejects.toThrow(StackPermissionError);
    await expect(view.update(ownerRecord.id, { text: 'hijacked' })).rejects.toThrow(
      StackPermissionError,
    );
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
// ScopedStack.create — client-supplied id
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

  test('a grant on comment@1 covers comment@2 records — version bump does not orphan it', async () => {
    const COMMENT_V2 = 'com.example.test/comment@2';
    await stack.defineType(
      COMMENT_V2,
      'Comment',
      { text: { kind: 'text', required: true }, edited: { kind: 'boolean' } },
      { migratesFrom: COMMENT },
    );
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT_V2, { text: 'hello', edited: false });
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  // The grant prefetch cursor-walks every _grant record, so a grant past
  // MemoryAdapter's 50-record default page is still honored rather than
  // silently unseen.
  test('a grant beyond the first page (>50 _grant records) is still honored', async () => {
    for (let i = 0; i < 55; i++) {
      await stack.grant(STRANGER, [
        { actions: ['read-any'], typeId: `com.example.test/filler${i}@1` },
      ]);
    }
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });

    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
    const result = await stack.asEntity(MEMBER).query({ filter: { typeId: COMMENT } });
    expect(result.records.map((r) => r.id)).toContain(record.id);
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
    const {
      content: { fileId },
    } = await stack.asEntity(OWNER).putAttachment(data, 'image/png');
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
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(data, 'image/png');
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

  test('returns the attributed record, so the uploader needs no follow-up query', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);

    const record = await stack.asEntity(MEMBER).putAttachment(data, 'image/png', 'photo.png');

    expect(record.typeId).toBe('_attachment@1');
    expect(record.entityId).toBe(MEMBER);
    expect(record.content.filename).toBe('photo.png');
    expect(await stack.get(record.id)).toMatchObject({ id: record.id, entityId: MEMBER });
  });

  test('upload without filename omits filename from record content', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    await stack.asEntity(MEMBER).putAttachment(data, 'image/png');
    const result = await stack.query({ filter: { typeId: '_attachment@1', entityId: MEMBER } });
    expect(result.records[0].content).not.toHaveProperty('filename');
  });

  test('default grant allows any authenticated entity to upload', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.asEntity(STRANGER).putAttachment(data, 'image/png');
    expect(typeof fileId).toBe('string');
  });

  // Uploads stamp authorship the same way create() does — one rule for
  // every record a ScopedStack writes.
  test('owner upload via asEntity(ownerEntityId) stamps entityId', async () => {
    await stack.asEntity(OWNER).putAttachment(data, 'image/png');
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].entityId).toBe(OWNER);
  });

  test('putAttachment records the appId it is given', async () => {
    await stack.asEntity(OWNER).putAttachment(data, 'image/png', undefined, 'com.example.myapp');
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records[0].appId).toBe('com.example.myapp');
  });

  // the maxAttachmentBytes pre-check applies to ScopedStack's own
  // upload path too, after the permission checks (grant checks run against
  // adapter.query(), which is unaffected by upload size).
  test('over-ceiling upload throws StackPayloadTooLargeError without touching the adapter', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    Object.assign(adapter, {
      capabilities: { ...adapter.capabilities, maxAttachmentBytes: 2 },
    });
    const putAttachmentSpy = vi.spyOn(adapter, 'putAttachment');

    await expect(stack.asEntity(MEMBER).putAttachment(data, 'image/png')).rejects.toThrow(
      StackPayloadTooLargeError,
    );
    expect(putAttachmentSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------
// ScopedStack.getAttachment — owner, referencing-record, and uploader access
// -------------------------------------------------------

describe('ScopedStack.getAttachment', () => {
  test('owner can always download', async () => {
    adapter.blobs.set('any-file-id', { data: new Uint8Array([1]), modifiedAt: new Date() });
    const bytes = await stack.asEntity(OWNER).getAttachment('any-file-id');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  test('requester who can read a record referencing the file can download', async () => {
    adapter.blobs.set('file-referenced', { data: new Uint8Array([1]), modifiedAt: new Date() });
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: NOTE }]);
    const record = await stack.create(NOTE, { text: 'has attachment' });
    await stack.associate(record.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'file-referenced',
    });

    const bytes = await stack.asEntity(MEMBER).getAttachment('file-referenced');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  test('uploader can download their own upload before it is associated with any record', async () => {
    adapter.blobs.set('file-mine', { data: new Uint8Array([1]), modifiedAt: new Date() });
    await stack.create(
      '_attachment@1',
      { fileId: 'file-mine', mimeType: 'image/png', size: 1 },
      { entityId: MEMBER },
    );

    const bytes = await stack.asEntity(MEMBER).getAttachment('file-mine');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  test('requester with no relation to the file is denied', async () => {
    await expect(stack.asEntity(STRANGER).getAttachment('file-nobody')).rejects.toThrow(
      StackPermissionError,
    );
  });

  // On adapters without contentFieldQuery the uploader check matches in
  // memory, cursor-walking so every one of the requester's uploads is
  // considered. IncapableMemoryAdapter forces that fallback path (a
  // compliant local adapter takes the content-filtered query).
  test('uploader can access an upload that is not their first (regression)', async () => {
    const incapableAdapter = new IncapableMemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
    const incapableStack = await Stack.create(incapableAdapter);
    incapableAdapter.blobs.set('file-first', { data: new Uint8Array([1]), modifiedAt: new Date() });
    incapableAdapter.blobs.set('file-second', {
      data: new Uint8Array([2]),
      modifiedAt: new Date(),
    });
    await incapableStack.create(
      '_attachment@1',
      { fileId: 'file-first', mimeType: 'image/png', size: 1 },
      { entityId: MEMBER },
    );
    await incapableStack.create(
      '_attachment@1',
      { fileId: 'file-second', mimeType: 'image/png', size: 1 },
      { entityId: MEMBER },
    );

    const bytes = await incapableStack.asEntity(MEMBER).getAttachment('file-second');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  // hasReadableReference() cursor-walks every referencing record rather
  // than a bounded page, so a file referenced by many unreadable records
  // plus one readable one further down still grants access. MemoryAdapter
  // returns records in insertion order, so the 11th-created record lands
  // past a bounded-page cutoff.
  test('requester can download when the only readable referencing record is past the first 10 (regression)', async () => {
    const fileId = 'file-widely-referenced';
    adapter.blobs.set(fileId, { data: new Uint8Array([1]), modifiedAt: new Date() });
    for (let i = 0; i < 10; i++) {
      await stack.create(
        NOTE,
        { text: `unreadable-${i}` },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId }],
        },
      );
    }
    await stack.create(
      NOTE,
      { text: 'readable' },
      {
        associations: [{ kind: 'attachment', label: 'x', fileId }],
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      },
    );

    const bytes = await stack.asEntity(MEMBER).getAttachment(fileId);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  test('reference creation (gating check) succeeds when the only readable referencing record is past the first 10', async () => {
    const fileId = 'file-widely-referenced-2';
    for (let i = 0; i < 10; i++) {
      await stack.create(
        NOTE,
        { text: `unreadable-${i}` },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId }],
        },
      );
    }
    // The 11th record referencing fileId is one MEMBER can already read —
    // that's what should let MEMBER attach fileId to a brand-new record too.
    await stack.create(
      NOTE,
      { text: 'readable' },
      {
        associations: [{ kind: 'attachment', label: 'x', fileId }],
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      },
    );

    await stack.grant(MEMBER, [{ actions: ['create', 'update-own'], typeId: NOTE }]);
    const own = await stack.asEntity(MEMBER).create(NOTE, { text: 'mine' });
    await stack.asEntity(MEMBER).associate(own.id, { kind: 'attachment', label: 'y', fileId });

    const updated = await stack.get(own.id);
    expect(updated?.associations).toContainEqual({ kind: 'attachment', label: 'y', fileId });
  });

  test('requester who can read none of >10 referencing records is still denied (no false positive)', async () => {
    const fileId = 'file-widely-referenced-3';
    for (let i = 0; i < 12; i++) {
      await stack.create(
        NOTE,
        { text: `unreadable-${i}` },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId }],
        },
      );
    }

    await expect(stack.asEntity(MEMBER).getAttachment(fileId)).rejects.toThrow(
      StackPermissionError,
    );
  });
});

// -------------------------------------------------------
// ScopedStack.getAttachment — file-ref content fields convey access
// -------------------------------------------------------

describe('ScopedStack.getAttachment — file-ref content fields', () => {
  const PHOTO_NOTE = 'com.example.test/photo-note@1';
  const PHOTO_NOTE_PLAIN = 'com.example.test/photo-note-plain@1';
  const FILE_ID = 'b'.repeat(64);

  test('requester who can read a record with a file-ref field referencing the file can download', async () => {
    adapter.blobs.set(FILE_ID, { data: new Uint8Array([1]), modifiedAt: new Date() });
    await stack.defineType(PHOTO_NOTE, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: PHOTO_NOTE }]);
    await stack.create(PHOTO_NOTE, { coverFileId: FILE_ID });

    const bytes = await stack.asEntity(MEMBER).getAttachment(FILE_ID);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  test('a plain string field holding the same-looking fileId conveys no access', async () => {
    await stack.defineType(PHOTO_NOTE_PLAIN, 'Photo note (plain)', {
      coverFileId: { kind: 'string', required: true },
    });
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: PHOTO_NOTE_PLAIN }]);
    await stack.create(PHOTO_NOTE_PLAIN, { coverFileId: FILE_ID });

    await expect(stack.asEntity(MEMBER).getAttachment(FILE_ID)).rejects.toThrow(
      StackPermissionError,
    );
  });
});

// -------------------------------------------------------
// ScopedStack.collectAttachmentGarbage — owner only
// -------------------------------------------------------

describe('ScopedStack.collectAttachmentGarbage', () => {
  test('owner can run the sweep', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');

    const result = await stack.asEntity(OWNER).collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  test('non-owner is denied', async () => {
    await expect(stack.asEntity(MEMBER).collectAttachmentGarbage({ graceMs: 0 })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('anonymous requester is denied', async () => {
    await expect(stack.asEntity(null).collectAttachmentGarbage({ graceMs: 0 })).rejects.toThrow(
      StackPermissionError,
    );
  });
});

// -------------------------------------------------------
// ScopedStack — group role gating
// -------------------------------------------------------

describe('ScopedStack — group role gating', () => {
  const ADMIN = 'group-admin-1';

  function makeGroup(overrides: Partial<StackRecord> = {}): Promise<StackRecord> {
    return adapter.createRecord(
      makeRecord({
        typeId: '_group@1',
        associations: [
          { kind: 'relationship', label: 'admin', recordId: ADMIN },
          { kind: 'relationship', label: 'member', recordId: MEMBER },
        ],
        ...overrides,
      }),
    );
  }

  test('plain member cannot update group content', async () => {
    const group = await makeGroup();
    await expect(stack.asEntity(MEMBER).update(group.id, { name: 'renamed' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('plain member cannot add or remove roster associations', async () => {
    const group = await makeGroup();
    const newMember: Association = { kind: 'relationship', label: 'member', recordId: STRANGER };
    await expect(stack.asEntity(MEMBER).associate(group.id, newMember)).rejects.toThrow(
      StackPermissionError,
    );
    const existingMember: Association = {
      kind: 'relationship',
      label: 'member',
      recordId: MEMBER,
    };
    await expect(stack.asEntity(MEMBER).dissociate(group.id, existingMember)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('plain member cannot delete the group', async () => {
    const group = await makeGroup();
    await expect(stack.asEntity(MEMBER).delete(group.id)).rejects.toThrow(StackPermissionError);
  });

  test('admin can update content, manage the roster, and delete the group', async () => {
    const group = await makeGroup();

    const updated = await stack.asEntity(ADMIN).update(group.id, { name: 'renamed' });
    expect(updated.content.name).toBe('renamed');

    const newMember: Association = { kind: 'relationship', label: 'member', recordId: STRANGER };
    await stack.asEntity(ADMIN).associate(group.id, newMember);
    expect((await adapter.getRecord(group.id))?.associations).toContainEqual(newMember);

    await stack.asEntity(ADMIN).dissociate(group.id, newMember);
    expect((await adapter.getRecord(group.id))?.associations).not.toContainEqual(newMember);

    await stack.asEntity(ADMIN).delete(group.id);
    expect((await adapter.getRecord(group.id))?.deletedAt).toBeDefined();
  });

  test('stack owner can manage the group regardless of roster membership', async () => {
    const group = await makeGroup();
    const updated = await stack.asEntity(OWNER).update(group.id, { name: 'renamed' });
    expect(updated.content.name).toBe('renamed');
    await stack.asEntity(OWNER).delete(group.id);
    expect((await adapter.getRecord(group.id))?.deletedAt).toBeDefined();
  });

  test('a stranger with no roster entry cannot manage the group', async () => {
    const group = await makeGroup();
    await expect(stack.asEntity(STRANGER).update(group.id, { name: 'renamed' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('record-level write:true permission does not substitute for admin status', async () => {
    // The self-amplifying-roster hole this issue closes: a group with a
    // generic write grant must not let that grantee touch the roster.
    const group = await makeGroup({
      permissions: [{ access: 'entity', entityId: STRANGER, read: true, write: true }],
    });
    await expect(stack.asEntity(STRANGER).update(group.id, { name: 'renamed' })).rejects.toThrow(
      StackPermissionError,
    );
    const newMember: Association = { kind: 'relationship', label: 'member', recordId: STRANGER };
    await expect(stack.asEntity(STRANGER).associate(group.id, newMember)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('setPermissions on a group requires admin, not just record authorship', async () => {
    const group = await makeGroup({ entityId: MEMBER });
    const perms: Permission[] = [{ access: 'public' }];
    // MEMBER authored the record but isn't an admin — generic creator carve-out doesn't apply.
    await expect(stack.asEntity(MEMBER).setPermissions(group.id, perms)).rejects.toThrow(
      StackPermissionError,
    );
    await stack.asEntity(ADMIN).setPermissions(group.id, perms);
    expect((await adapter.getRecord(group.id))?.permissions).toEqual(perms);
  });

  test('creator is stamped as admin at create time and can manage the group afterward', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_group@1' }]);
    const group = await stack.asEntity(MEMBER).create('_group@1', { name: 'New Group' });
    expect(group.associations).toContainEqual({
      kind: 'relationship',
      label: 'admin',
      recordId: MEMBER,
    });

    const updated = await stack.asEntity(MEMBER).update(group.id, { name: 'renamed' });
    expect(updated.content.name).toBe('renamed');
  });

  test('create-time bootstrap does not duplicate an explicitly supplied admin association', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_group@1' }]);
    const group = await stack
      .asEntity(MEMBER)
      .create(
        '_group@1',
        { name: 'New Group' },
        { associations: [{ kind: 'relationship', label: 'admin', recordId: MEMBER }] },
      );
    const adminAssociations = (group.associations ?? []).filter(
      (a) => a.kind === 'relationship' && a.label === 'admin' && a.recordId === MEMBER,
    );
    expect(adminAssociations).toHaveLength(1);
  });

  // Bootstrap stamps the group's creator as its first admin exactly once —
  // the owner is no exception, and gets no duplicate roster entry.
  test('owner writing through ScopedStack stamps the owner as admin exactly once', async () => {
    const group = await stack.asEntity(OWNER).create('_group@1', { name: 'New Group' });
    expect(group.entityId).toBe(OWNER);
    const adminAssociations = (group.associations ?? []).filter(
      (a) => a.kind === 'relationship' && a.label === 'admin' && a.recordId === OWNER,
    );
    expect(adminAssociations).toHaveLength(1);
  });
});

// -------------------------------------------------------
// Permission — group `role`
// -------------------------------------------------------

describe('Permission — group role restriction', () => {
  test('role: "admin" ACL entry excludes a plain member', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'admin', recordId: 'group-admin-2' },
          { kind: 'relationship', label: 'member', recordId: MEMBER },
        ],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [
          { access: 'group', groupId: group.id, role: 'admin', read: true, write: false },
        ],
      }),
    );
    await expect(stack.asEntity(MEMBER).get(record.id)).rejects.toThrow(StackPermissionError);
    expect((await stack.asEntity('group-admin-2').get(record.id))?.id).toBe(record.id);
  });

  test('absent role behaves exactly as today — any member (or admin) qualifies', async () => {
    const admin = 'group-admin-3';
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'admin', recordId: admin },
          { kind: 'relationship', label: 'member', recordId: MEMBER },
        ],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
    expect((await stack.asEntity(admin).get(record.id))?.id).toBe(record.id);
  });
});

// -------------------------------------------------------
// ScopedStack.create()/associate() — reference-creation gating
// -------------------------------------------------------
//
// ScopedStack.create() forwards parentId/associations from an untrusted
// caller; creating a reference requires exactly what possessing it would
// grant, and missing vs. forbidden targets are indistinguishable. See
// docs/spec/access-control.md § Reference-creation gating.

describe('ScopedStack.create — attachment association gating', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
  });

  test('attachment association referencing an inaccessible file is rejected', async () => {
    await expect(
      stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId: 'unknown-file' }],
        },
      ),
    ).rejects.toThrow(StackPermissionError);
  });

  test('attachment association referencing a file the requester uploaded is allowed', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(new Uint8Array([1]), 'image/png');
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [{ kind: 'attachment', label: 'x', fileId }],
      },
    );
    expect(record.associations).toContainEqual({
      kind: 'attachment',
      label: 'x',
      fileId,
    });
  });

  test('attachment association referencing a file readable via another record is allowed', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const owned = await stack.create(NOTE, { text: 'owner note' });
    await stack.associate(owned.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: NOTE }]);

    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [{ kind: 'attachment', label: 'x', fileId }],
      },
    );
    expect(record.associations).toContainEqual({
      kind: 'attachment',
      label: 'x',
      fileId,
    });
  });

  test('nonexistent and existing-but-forbidden fileIds produce indistinguishable errors', async () => {
    const {
      content: { fileId: forbiddenFileId },
    } = await stack.putAttachment(new Uint8Array([9]), 'image/png');
    let nonexistentError: Error | undefined;
    let forbiddenError: Error | undefined;
    try {
      await stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId: 'truly-nonexistent' }],
        },
      );
    } catch (e) {
      nonexistentError = e as Error;
    }
    try {
      await stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [{ kind: 'attachment', label: 'x', fileId: forbiddenFileId }],
        },
      );
    } catch (e) {
      forbiddenError = e as Error;
    }
    expect(nonexistentError).toBeInstanceOf(StackPermissionError);
    expect(forbiddenError).toBeInstanceOf(StackPermissionError);
    expect(nonexistentError?.message).toBe(forbiddenError?.message);
  });

  test('tag associations are never gated', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [{ kind: 'tag', label: 'starred' }],
      },
    );
    expect(record.associations).toContainEqual({ kind: 'tag', label: 'starred' });
  });

  test('the owner is exempt from the attachment-association gate', async () => {
    const record = await stack.create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [{ kind: 'attachment', label: 'x', fileId: 'anything' }],
      },
    );
    expect(record.associations).toHaveLength(1);
  });
});

// -------------------------------------------------------
// ScopedStack.create — non-owner _attachment@1 refusal
// -------------------------------------------------------
//
// putAttachment() proves possession by hashing bytes; generic create()
// accepts a caller-supplied fileId with no such proof. These pin the
// non-owner refusal and its carve-out. See docs/spec/attachments.md
// § Creating `_attachment@1` records directly.

describe('ScopedStack.create — non-owner _attachment@1 refusal', () => {
  beforeEach(async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
  });

  test('non-owner create() with a guessed fileId is refused even with a create grant', async () => {
    await expect(
      stack.asEntity(MEMBER).create('_attachment@1', {
        fileId: 'guessed-sha256-hash',
        mimeType: 'image/png',
        size: 12345,
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('owner is exempt from the refusal', async () => {
    const record = await stack.asEntity(OWNER).create('_attachment@1', {
      fileId: 'anything',
      mimeType: 'image/png',
      size: 1,
    });
    expect(record.typeId).toBe('_attachment@1');
  });

  test('unscoped Stack.create() is unaffected (full trust)', async () => {
    const record = await stack.create('_attachment@1', {
      fileId: 'anything',
      mimeType: 'image/png',
      size: 1,
    });
    expect(record.typeId).toBe('_attachment@1');
  });

  // The exploit this guard closes: a non-owner cannot turn a guessed fileId
  // into a read by first failing to create a metadata record for it, then
  // trying to download it anyway.
  test('exploit regression: a refused create leaves getAttachment() denied too', async () => {
    const guessedFileId = 'guessed-sha256-hash';
    await expect(
      stack.asEntity(MEMBER).create('_attachment@1', {
        fileId: guessedFileId,
        mimeType: 'image/png',
        size: 12345,
      }),
    ).rejects.toThrow(StackPermissionError);

    await expect(stack.asEntity(MEMBER).getAttachment(guessedFileId)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('non-owner putAttachment(bytes, mime, filename) still works end-to-end', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(data, 'image/png', 'photo.png');

    // The upload is now accessible to them...
    const bytes = await stack.asEntity(MEMBER).getAttachment(fileId);
    expect(bytes).toEqual(data);

    // ...and they can reference it from a new record.
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack
      .asEntity(MEMBER)
      .create(
        COMMENT,
        { text: 'hi' },
        { associations: [{ kind: 'attachment', label: 'x', fileId }] },
      );
    expect(record.associations).toContainEqual({
      kind: 'attachment',
      label: 'x',
      fileId,
    });
  });

  // Residual decision 1: a non-owner who can already read a record
  // referencing F may add their own _attachment@1 (e.g. a second filename)
  // without re-uploading bytes — this conveys no access they didn't already
  // have via the readable record.
  test('carve-out: a non-owner with a readable referencing record can add a second metadata record', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png', 'owner.png');
    const owned = await stack.create(NOTE, { text: 'owner note' });
    await stack.associate(owned.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: NOTE }]);

    const record = await stack.asEntity(MEMBER).create('_attachment@1', {
      fileId,
      mimeType: 'image/png',
      size: 1,
      filename: 'members-name.png',
    });
    expect(record.content).toMatchObject({ fileId, filename: 'members-name.png' });
  });

  // The carve-out must never fall back to the uploader clause: a non-owner
  // who has an *existing* _attachment@1 record for F (but no readable
  // record referencing F) does not get to bootstrap a second one from it —
  // that would let one successful guess unlock unlimited further records
  // for the same fileId.
  test('carve-out does not extend to the uploader clause', async () => {
    await stack.create(
      '_attachment@1',
      { fileId: 'file-mine', mimeType: 'image/png', size: 1 },
      { entityId: MEMBER },
    );

    await expect(
      stack.asEntity(MEMBER).create('_attachment@1', {
        fileId: 'file-mine',
        mimeType: 'image/png',
        size: 1,
        filename: 'second-name.png',
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a non-owner without a readable referencing record is refused even for a real, existing fileId', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([9]), 'image/png');
    // fileId is real and exists, but MEMBER has no readable record referencing it.
    await expect(
      stack.asEntity(MEMBER).create('_attachment@1', {
        fileId,
        mimeType: 'image/png',
        size: 1,
        filename: 'sneaky.png',
      }),
    ).rejects.toThrow(StackPermissionError);
  });
});

describe('ScopedStack.create — relationship association and parentId gating', () => {
  let readableNote: StackRecord;
  let unreadableNote: StackRecord;

  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    readableNote = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    unreadableNote = await adapter.createRecord(makeRecord());
  });

  test('relationship association targeting an unreadable record is rejected', async () => {
    await expect(
      stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [{ kind: 'relationship', label: 'related', recordId: unreadableNote.id }],
        },
      ),
    ).rejects.toThrow(StackPermissionError);
  });

  test('relationship association targeting a readable record is allowed', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [{ kind: 'relationship', label: 'related', recordId: readableNote.id }],
      },
    );
    expect(record.associations).toContainEqual({
      kind: 'relationship',
      label: 'related',
      recordId: readableNote.id,
    });
  });

  test('missing and unreadable relationship targets produce indistinguishable errors', async () => {
    let missingError: Error | undefined;
    let unreadableError: Error | undefined;
    try {
      await stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [
            { kind: 'relationship', label: 'related', recordId: 'nonexistent-record' },
          ],
        },
      );
    } catch (e) {
      missingError = e as Error;
    }
    try {
      await stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [{ kind: 'relationship', label: 'related', recordId: unreadableNote.id }],
        },
      );
    } catch (e) {
      unreadableError = e as Error;
    }
    expect(missingError).toBeInstanceOf(StackPermissionError);
    expect(unreadableError).toBeInstanceOf(StackPermissionError);
    expect(missingError?.message).toBe(unreadableError?.message);
  });

  test('_group roster relationship associations are exempt from the target-read check', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_group@1' }]);
    // MEMBER's own entityId has no corresponding readable record in this stack.
    const group = await stack.asEntity(MEMBER).create('_group@1', { name: 'New Group' });
    expect(group.associations).toContainEqual({
      kind: 'relationship',
      label: 'admin',
      recordId: MEMBER,
    });
  });

  test('parentId requires read access to the parent', async () => {
    await expect(
      stack.asEntity(MEMBER).create(COMMENT, { text: 'hi' }, { parentId: unreadableNote.id }),
    ).rejects.toThrow(StackPermissionError);

    const record = await stack
      .asEntity(MEMBER)
      .create(COMMENT, { text: 'hi' }, { parentId: readableNote.id });
    expect(record.parentId).toBe(readableNote.id);
  });

  test('the owner is exempt from parentId and relationship gates', async () => {
    const record = await stack.create(
      COMMENT,
      { text: 'hi' },
      {
        parentId: unreadableNote.id,
        associations: [{ kind: 'relationship', label: 'related', recordId: unreadableNote.id }],
      },
    );
    expect(record.parentId).toBe(unreadableNote.id);
  });
});

describe('ScopedStack.associate — reference-creation gating', () => {
  let ownedRecord: StackRecord;

  beforeEach(async () => {
    await stack.grant(MEMBER, [{ actions: ['create', 'update-own'], typeId: NOTE }]);
    ownedRecord = await stack.asEntity(MEMBER).create(NOTE, { text: 'mine' });
  });

  test('associate() rejects an attachment association to a file the requester cannot access', async () => {
    await expect(
      stack.asEntity(MEMBER).associate(ownedRecord.id, {
        kind: 'attachment',
        label: 'x',
        fileId: 'unknown',
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('associate() allows an attachment association to a file the requester uploaded', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(new Uint8Array([1]), 'image/png');
    await stack
      .asEntity(MEMBER)
      .associate(ownedRecord.id, { kind: 'attachment', label: 'x', fileId });
    expect((await adapter.getRecord(ownedRecord.id))?.associations).toContainEqual({
      kind: 'attachment',
      label: 'x',
      fileId,
    });
  });

  test('associate() rejects a relationship association to an unreadable record', async () => {
    const unreadableNote = await adapter.createRecord(makeRecord());
    await expect(
      stack.asEntity(MEMBER).associate(ownedRecord.id, {
        kind: 'relationship',
        label: 'related',
        recordId: unreadableNote.id,
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('associate() never gates tag associations', async () => {
    await stack.asEntity(MEMBER).associate(ownedRecord.id, { kind: 'tag', label: 'starred' });
    expect((await adapter.getRecord(ownedRecord.id))?.associations).toContainEqual({
      kind: 'tag',
      label: 'starred',
    });
  });
});

describe('ScopedStack — file-ref content field gating', () => {
  const PHOTO_NOTE = 'com.example.test/photo-note-gating@1';
  const FILE_ID = 'c'.repeat(64);

  beforeEach(async () => {
    await stack.defineType(PHOTO_NOTE, 'Photo note', {
      coverFileId: { kind: 'file-ref' },
      title: { kind: 'string' },
    });
    await stack.grant(MEMBER, [{ actions: ['create', 'update-own'], typeId: PHOTO_NOTE }]);
  });

  test('create() rejects a file-ref field pointing at an inaccessible file', async () => {
    await expect(
      stack.asEntity(MEMBER).create(PHOTO_NOTE, { coverFileId: FILE_ID }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('create() allows a file-ref field pointing at a file the requester uploaded', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(new Uint8Array([1]), 'image/png');
    const record = await stack.asEntity(MEMBER).create(PHOTO_NOTE, { coverFileId: fileId });
    expect(record.content.coverFileId).toBe(fileId);
  });

  test('update() rejects changing a file-ref field to an inaccessible file', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.asEntity(MEMBER).putAttachment(new Uint8Array([1]), 'image/png');
    const record = await stack.asEntity(MEMBER).create(PHOTO_NOTE, { coverFileId: fileId });

    await expect(
      stack.asEntity(MEMBER).update(record.id, { coverFileId: FILE_ID }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('update() leaving the file-ref field untouched is unaffected by its accessibility', async () => {
    // Owner-created record with a file-ref the MEMBER updater can't independently access;
    // a patch that never mentions coverFileId carries no new reference and isn't gated.
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const record = await stack.create(
      PHOTO_NOTE,
      { coverFileId: fileId },
      {
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      },
    );

    const updated = await stack.asEntity(MEMBER).update(record.id, { title: 'renamed' });
    expect(updated.content.title).toBe('renamed');
    expect(updated.content.coverFileId).toBe(fileId);
  });

  test('the owner is exempt from the file-ref gate', async () => {
    const record = await stack.create(PHOTO_NOTE, { coverFileId: FILE_ID });
    expect(record.content.coverFileId).toBe(FILE_ID);
  });
});

// -------------------------------------------------------
// Delegation: principal vs subject
// -------------------------------------------------------

// A delegated app's authority is the intersection of its own grants with
// the subject's, so neither party can lend the other reach it lacks. The
// four rows below are that table; the rest pin what stays principal-side.
describe('ScopedStack — delegation', () => {
  const APP = 'did:key:z6MkApp';

  const grantAll = (who: string | null, typeId = COMMENT) =>
    stack.grant(who, [
      { actions: ['create', 'read-own', 'read-any', 'update-any', 'delete-any'], typeId },
    ]);

  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text' } });
  });

  test('an anonymous principal cannot act on behalf of an entity', () => {
    expect(() => stack.asEntity(null, { onBehalfOf: MEMBER })).toThrow(StackPermissionError);
  });

  test('a delegated create stamps the subject as author and the app as principal', async () => {
    await grantAll(APP);
    await grantAll(MEMBER);
    const record = await stack
      .asEntity(APP, { onBehalfOf: MEMBER })
      .create(COMMENT, { text: 'hi' }, { appId: 'com.example.myapp' });
    expect(record.entityId).toBe(MEMBER);
    expect(record.principalId).toBe(APP);
    expect(record.appId).toBe('com.example.myapp');
  });

  test('an app with no grant of its own cannot act for a granted subject', async () => {
    await grantAll(MEMBER);
    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('a granted app cannot act for a subject with no grant', async () => {
    await grantAll(APP);
    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  // The leak intersection closes: a read-any app delegated to a read-own
  // subject must not hand that subject records it couldn't otherwise see.
  test('a read-any app delegated to a read-own subject reads only the subject own records', async () => {
    await stack.grant(APP, [{ actions: ['read-any'], typeId: COMMENT }]);
    await stack.grant(MEMBER, [{ actions: ['read-own'], typeId: COMMENT }]);
    const mine = await adapter.createRecord(
      makeRecord({ typeId: COMMENT, entityId: MEMBER, content: { text: 'mine' } }),
    );
    const theirs = await adapter.createRecord(
      makeRecord({ typeId: COMMENT, entityId: STRANGER, content: { text: 'theirs' } }),
    );

    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    expect((await view.get(mine.id))?.id).toBe(mine.id);
    await expect(view.get(theirs.id)).rejects.toThrow(StackPermissionError);
  });

  // -own on the principal side is read as the bare verb: which records are
  // reachable is settled by the subject, not by the app.
  test('an app holding only read-own may still serve a subject reading records it did not author', async () => {
    await stack.grant(APP, [{ actions: ['read-own'], typeId: COMMENT }]);
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: COMMENT }]);
    const theirs = await adapter.createRecord(
      makeRecord({ typeId: COMMENT, entityId: STRANGER, content: { text: 'theirs' } }),
    );
    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    expect((await view.get(theirs.id))?.id).toBe(theirs.id);
  });

  test('a record shared by permission stays unreachable through an app with no grant on its type', async () => {
    await stack.grant(APP, [{ actions: ['read-any'], typeId: COMMENT }]);
    const shared = await adapter.createRecord(
      makeRecord({
        typeId: NOTE,
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    // Undelegated, the same subject reaches it — the mask is what changes.
    expect((await stack.asEntity(MEMBER).get(shared.id))?.id).toBe(shared.id);
    await expect(stack.asEntity(APP, { onBehalfOf: MEMBER }).get(shared.id)).rejects.toThrow(
      StackPermissionError,
    );
  });

  // Owner bypass keys on the principal. An app delegated for the owner is
  // bounded by its grants; it does not inherit the owner's unconditional
  // access.
  test('an app delegated for the owner gets no owner bypass', async () => {
    const record = await adapter.createRecord(makeRecord({ content: { text: 'private' } }));
    await expect(stack.asEntity(APP, { onBehalfOf: OWNER }).get(record.id)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('an app delegated for the owner cannot hard delete', async () => {
    await grantAll(APP);
    await grantAll(null);
    const record = await adapter.createRecord(makeRecord({ typeId: COMMENT, entityId: OWNER }));
    await expect(
      stack.asEntity(APP, { onBehalfOf: OWNER }).delete(record.id, { hard: true }),
    ).rejects.toThrow(StackPermissionError);
  });

  // setPermissions has no grant fence at all, so authorship is deliberately
  // not enough: a contained app can never reshare its subject's data.
  test('an app delegated for the owner cannot set permissions on its subject records', async () => {
    await grantAll(APP);
    await grantAll(null);
    const view = stack.asEntity(APP, { onBehalfOf: OWNER });
    const record = await view.create(COMMENT, { text: 'hi' });
    expect(record.entityId).toBe(OWNER);
    await expect(view.setPermissions(record.id, [{ access: 'public' }])).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('an app delegated for a group admin cannot manage the group', async () => {
    const group = await stack.create('_group@1', { name: 'Book Club' });
    await stack.associate(group.id, { kind: 'relationship', label: 'admin', recordId: MEMBER });
    expect(await stack.asEntity(MEMBER).update(group.id, { name: 'Renamed' })).toBeTruthy();
    await expect(
      stack.asEntity(APP, { onBehalfOf: MEMBER }).update(group.id, { name: 'Hijacked' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('records are queryable by the principal that wrote them', async () => {
    await grantAll(APP);
    await grantAll(null);
    await stack.asEntity(APP, { onBehalfOf: OWNER }).create(COMMENT, { text: 'via app' });
    await stack.asEntity(OWNER).create(COMMENT, { text: 'direct' });

    const viaApp = await stack.query({ filter: { principalId: APP } });
    expect(viaApp.records.map((r) => r.content.text)).toEqual(['via app']);
  });
});
