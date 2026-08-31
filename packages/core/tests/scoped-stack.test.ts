import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  Stack,
  StackPermissionError,
  StackNotFoundError,
  StackValidationError,
  StackConflictError,
  StackPayloadTooLargeError,
  StackQueryError,
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
    expect(await view.get(record.id)).toBeNull();
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
    expect(await stack.asEntity(STRANGER).get(record.id)).toBeNull();
  });

  test('group member can read via a group read grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  // Membership names an identity, not a record. A roster entry pointing at
  // a record whose id happens to equal the DID confers nothing — the arms
  // are what keep the two apart now that both hold plain strings.
  test('a record-scoped roster entry does not confer membership', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'record', recordId: MEMBER } },
        ],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    expect(await stack.asEntity(MEMBER).get(record.id)).toBeNull();
  });

  test('non-member cannot read via a group read grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'group', groupId: group.id, read: true, write: false }],
      }),
    );
    expect(await stack.asEntity(STRANGER).get(record.id)).toBeNull();
  });

  test('get() answers a missing record and an unreadable one identically', async () => {
    const record = await adapter.createRecord(makeRecord());
    for (const view of [stack.asEntity(STRANGER), stack.asEntity(null)]) {
      expect(await view.get(record.id)).toBeNull();
      expect(await view.get('nonexistent')).toBeNull();
    }
    expect(await stack.asEntity(OWNER).get('nonexistent')).toBeNull();
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
    await expect(stack.asEntity(STRANGER).delete(record.id)).rejects.toThrow(StackNotFoundError);
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
    await expect(stack.asEntity(STRANGER).undelete(record.id)).rejects.toThrow(StackNotFoundError);
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
      StackNotFoundError,
    );
    await expect(stack.asEntity(STRANGER).dissociate(record.id, tag)).rejects.toThrow(
      StackNotFoundError,
    );
    await expect(stack.asEntity(STRANGER).setPermissions(record.id, perms)).rejects.toThrow(
      StackNotFoundError,
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
// setUnlisted — gated exactly like setPermissions, since both decide who
// or what can discover a record rather than merely read one already found.
// See docs/spec/access-control.md § Unlisted records.
// -------------------------------------------------------

describe('ScopedStack.setUnlisted', () => {
  test('rejects write-access holder that is not creator or stack owner', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        entityId: OWNER,
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: true }],
      }),
    );
    await expect(stack.asEntity(MEMBER).setUnlisted(record.id, true)).rejects.toThrow(
      StackPermissionError,
    );
    // Stack owner and record creator can still toggle it.
    await stack.asEntity(OWNER).setUnlisted(record.id, true);
    expect((await adapter.getRecord(record.id))?.unlistedAt).toBeInstanceOf(Date);
  });

  test('a stranger with no access gets StackNotFoundError', async () => {
    const record = await adapter.createRecord(makeRecord());
    await expect(stack.asEntity(STRANGER).setUnlisted(record.id, true)).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('the record creator (not stack owner) may toggle it', async () => {
    const record = await adapter.createRecord(makeRecord({ entityId: MEMBER }));
    await stack.asEntity(MEMBER).setUnlisted(record.id, true);
    expect((await adapter.getRecord(record.id))?.unlistedAt).toBeInstanceOf(Date);
  });
});

// -------------------------------------------------------
// Record-existence disclosure
// -------------------------------------------------------

// A refusal never confirms an ID to someone a read would not have
// confirmed it to, so guessed and derived IDs stay unconfirmable.
// See docs/spec/access-control.md § Errors and information exposure.
describe('ScopedStack — record-existence disclosure', () => {
  const tag: Association = { kind: 'tag', label: 'starred' };
  const perms: Permission[] = [{ access: 'public' }];

  // Every verb that takes a record ID, asked of the same requester about a
  // record that exists and one that does not.
  const verbs = (view: ReturnType<Stack['asEntity']>, id: string): Promise<unknown>[] => [
    view.update(id, { text: 'edited' }),
    view.delete(id),
    view.delete(id, { hard: true }),
    view.undelete(id),
    view.associate(id, tag),
    view.dissociate(id, tag),
    view.setPermissions(id, perms),
    view.getVersions(id),
    view.getVersion(id, 1),
    view.restoreVersion(id, 1),
  ];

  test('an unreadable record answers every verb exactly as a missing one does', async () => {
    const record = await adapter.createRecord(makeRecord());

    for (const view of [stack.asEntity(STRANGER), stack.asEntity(null)]) {
      expect(await view.get(record.id)).toBeNull();
      for (const attempt of [...verbs(view, record.id), ...verbs(view, 'nonexistent')]) {
        await expect(attempt).rejects.toThrow(StackNotFoundError);
      }
    }
  });

  test('a requester who can read the record is told the verb was refused', async () => {
    const record = await adapter.createRecord(
      makeRecord({
        permissions: [{ access: 'entity', entityId: MEMBER, read: true, write: false }],
      }),
    );
    const view = stack.asEntity(MEMBER);

    expect((await view.get(record.id))?.id).toBe(record.id);
    for (const attempt of verbs(view, record.id)) {
      await expect(attempt).rejects.toThrow(StackPermissionError);
    }
  });

  // The drop-box case: a contributor holds one ID legitimately and can
  // derive its same-millisecond siblings, so a create grant must not make
  // those siblings confirmable.
  test('a create-only grantee cannot confirm the records it wrote beside', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: NOTE }]);
    const view = stack.asEntity(MEMBER);
    const own = await view.create(NOTE, { text: 'submitted' });
    const sibling = await stack.create(NOTE, { text: "someone else's" });

    for (const id of [own.id, sibling.id, 'nonexistent']) {
      expect(await view.get(id)).toBeNull();
      await expect(view.getVersions(id)).rejects.toThrow(StackNotFoundError);
      await expect(view.update(id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
    }
  });

  test('a read-own holder cannot confirm a record of that type it may not read', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own', 'update-own'], typeId: NOTE }]);
    const view = stack.asEntity(MEMBER);
    const own = await stack.create(NOTE, { text: 'mine' }, { entityId: MEMBER });
    const theirs = await stack.create(NOTE, { text: 'theirs' }, { entityId: STRANGER });

    // Reachable through the grant, so the refusal may name itself...
    expect((await view.get(own.id))?.id).toBe(own.id);
    await expect(view.delete(own.id, { hard: true })).rejects.toThrow(StackPermissionError);
    // ...while a record of the same type it cannot read stays unconfirmed.
    expect(await view.get(theirs.id)).toBeNull();
    await expect(view.update(theirs.id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
  });

  test('a _grant record discloses neither its existence nor its family to a non-owner', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any'], typeId: NOTE }]);
    const [grantRecord] = (await stack.listGrants(MEMBER)) as StackRecord[];
    const view = stack.asEntity(MEMBER);

    expect(await view.get(grantRecord.id)).toBeNull();
    await expect(view.update(grantRecord.id, { actions: ['read-any'] })).rejects.toThrow(
      StackNotFoundError,
    );
    await expect(view.setPermissions(grantRecord.id, perms)).rejects.toThrow(StackNotFoundError);
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
      StackNotFoundError,
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
          { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: ADMIN } },
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await adapter.saveVersion(group.id, {
      version: 1,
      typeId: '_group@1',
      content: {},
      updatedAt: new Date(),
    });
    await expect(stack.asEntity(MEMBER).getVersions(group.id)).rejects.toThrow(StackNotFoundError);
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
      await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: PHOTO_NOTE }]);
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

    // The exemption is the owner's own, not something an owner principal
    // lends its subject: the gate resolves against the subject, whose
    // reach is what a restore would widen.
    test('the exemption does not extend to an owner principal acting for someone else', async () => {
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
      await expect(
        stack.asEntity(OWNER, { onBehalfOf: MEMBER }).restoreVersion(record.id, 1),
      ).rejects.toThrow(StackPermissionError);
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

  // includeUnlisted is owner-only: enumeration standing rests on nothing
  // but ownership, so no grant or delegation carries it. See
  // docs/spec/access-control.md § includeUnlisted is owner-only.
  describe('includeUnlisted', () => {
    test('refuses a non-owner requester with StackPermissionError', async () => {
      await expect(
        stack.asEntity(MEMBER).query({ filter: { includeUnlisted: true } }),
      ).rejects.toThrow(StackPermissionError);
    });

    test('refuses an anonymous requester', async () => {
      await expect(
        stack.asEntity(null).query({ filter: { includeUnlisted: true } }),
      ).rejects.toThrow(StackPermissionError);
    });

    test('the owner acting alone may pass it', async () => {
      await adapter.createRecord(
        makeRecord({ unlistedAt: new Date(), permissions: [{ access: 'public' }] }),
      );
      const result = await stack.asEntity(OWNER).query({ filter: { includeUnlisted: true } });
      expect(result.records).toHaveLength(1);
    });

    test('an owner-delegated app does not inherit it', async () => {
      const scoped = stack.asEntity('app-did', { onBehalfOf: OWNER });
      await expect(scoped.query({ filter: { includeUnlisted: true } })).rejects.toThrow(
        StackPermissionError,
      );
    });

    test('unlisted records are excluded from a scoped query by default', async () => {
      await adapter.createRecord(
        makeRecord({ unlistedAt: new Date(), permissions: [{ access: 'public' }] }),
      );
      const result = await stack.asEntity(null).query();
      expect(result.records).toHaveLength(0);
    });
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
    expect(await view.get(ownerRecord.id)).toBeNull();
    await expect(view.update(ownerRecord.id, { text: 'hijacked' })).rejects.toThrow(
      StackNotFoundError,
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
    ).rejects.toThrow(StackQueryError);
  });

  test('rejects a reserved-prefix id from a grantee', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create(COMMENT, { text: 'hello' }, { id: '_' + generateId().slice(1) }),
    ).rejects.toThrow(StackQueryError);
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
// ScopedStack.create — createdAt/updatedAt: owner acting alone only
// -------------------------------------------------------

describe('ScopedStack.create — createdAt/updatedAt refused to anyone but the owner acting alone', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
  });

  test('rejects a grantee-supplied createdAt with StackPermissionError', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create(COMMENT, { text: 'hello' }, { createdAt: new Date('2020-01-01') }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('rejects a grantee-supplied updatedAt with StackPermissionError', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create(COMMENT, { text: 'hello' }, { updatedAt: new Date('2020-01-01') }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('does not create a record when refused', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create(COMMENT, { text: 'hello' }, { createdAt: new Date('2020-01-01') }),
    ).rejects.toThrow();
    expect((await stack.query({ filter: { typeId: COMMENT } })).records).toHaveLength(0);
  });

  test('rejects createdAt from a principal delegated to act for the owner (not owner acting alone)', async () => {
    // subjectEntityId === OWNER satisfies checkCreateGrant()'s owner-subject
    // carve-out, so this exercises the createdAt/updatedAt gate itself
    // rather than getting stopped earlier by a missing create grant.
    await expect(
      stack
        .asEntity(MEMBER, { onBehalfOf: OWNER })
        .create(COMMENT, { text: 'hello' }, { createdAt: new Date('2020-01-01') }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('rejects createdAt when the owner delegates for someone else — the owner’s trust does not transfer to the subject', async () => {
    await expect(
      stack
        .asEntity(OWNER, { onBehalfOf: MEMBER })
        .create(COMMENT, { text: 'hello' }, { createdAt: new Date('2020-01-01') }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('owner acting alone may set createdAt, and updatedAt defaults to match', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const record = await stack.asEntity(OWNER).create(COMMENT, { text: 'hello' }, { createdAt });
    expect(record.createdAt).toEqual(createdAt);
    expect(record.updatedAt).toEqual(createdAt);
  });

  test('owner acting alone may set updatedAt distinct from createdAt', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const updatedAt = new Date('2020-06-20T12:00:00.000Z');
    const record = await stack
      .asEntity(OWNER)
      .create(COMMENT, { text: 'hello' }, { createdAt, updatedAt });
    expect(record.updatedAt).toEqual(updatedAt);
  });

  test('owner acting alone: an id agreeing with createdAt is accepted, ignoring the "vs. now" skew check', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const id = idWithTimestamp(createdAt.valueOf());
    const record = await stack
      .asEntity(OWNER)
      .create(COMMENT, { text: 'hello' }, { id, createdAt });
    expect(record.id).toBe(id);
  });

  test('owner acting alone: an id disagreeing with createdAt is rejected against createdAt, not "now"', async () => {
    const createdAt = new Date('2020-06-15T12:00:00.000Z');
    const id = idWithTimestamp(new Date('2000-01-01').valueOf());
    await expect(
      stack.asEntity(OWNER).create(COMMENT, { text: 'hello' }, { id, createdAt }),
    ).rejects.toThrow(StackValidationError);
  });

  test('owner acting alone still gets the reserved-prefix and format checks on a backdated id', async () => {
    await expect(
      stack
        .asEntity(OWNER)
        .create(COMMENT, { text: 'hello' }, { id: 'too-short', createdAt: new Date('2020-01-01') }),
    ).rejects.toThrow(StackQueryError);
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
    expect(await stack.asEntity(MEMBER).get(note.id)).toBeNull();
  });

  test('read-own: entity can read records they authored', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('read-own: entity cannot read records authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    expect(await stack.asEntity(MEMBER).get(record.id)).toBeNull();
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
// ScopedStack — group-targeted grants
// -------------------------------------------------------

describe('ScopedStack — group-targeted grants', () => {
  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
  });

  test('group member can create via a group-targeted create grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hi' });
    expect(record.content.text).toBe('hi');
  });

  test('group admin also satisfies a group-targeted grant — no admin-only tier', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });
    expect((await stack.asEntity(MEMBER).get(record.id))?.id).toBe(record.id);
  });

  test('non-member cannot act via a group-targeted grant', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' });
    expect(await stack.asEntity(STRANGER).get(record.id)).toBeNull();
  });

  test('group grant is visible in query() results for a member', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: COMMENT }]);
    await stack.create(COMMENT, { text: 'a' });
    await stack.create(COMMENT, { text: 'b' });
    const result = await stack.asEntity(MEMBER).query({ filter: { typeId: COMMENT } });
    expect(result.records).toHaveLength(2);
  });

  test('a revoked group grant no longer applies', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['create'], typeId: COMMENT }]);
    await stack.revoke({ groupId: group.id }, [{ actions: ['create'], typeId: COMMENT }]);
    await expect(stack.asEntity(MEMBER).create(COMMENT, { text: 'hi' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  // Resolving a group roster costs a record fetch; memoizing per
  // ScopedStack instance keeps a query examining many records from
  // re-walking the same roster once per candidate — see
  // docs/spec/access-control.md § Type-level grants.
  test('roster resolution for a group-targeted grant is memoized within one request', async () => {
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: COMMENT }]);
    for (let i = 0; i < 5; i++) {
      await stack.create(COMMENT, { text: `comment ${i}` });
    }

    const getSpy = vi.spyOn(stack, 'get');
    const view = stack.asEntity(MEMBER);
    const result = await view.query({ filter: { typeId: COMMENT } });
    expect(result.records).toHaveLength(5);
    const groupFetches = getSpy.mock.calls.filter(([id]) => id === group.id);
    expect(groupFetches).toHaveLength(1);
  });

  // A `_group` roster is editable by any of its admins, not just the stack
  // owner, so a grant that reached a principal through a roster would let
  // someone other than the owner name an app to a type the owner never
  // named it to. See docs/spec/access-control.md § Type-level grants.
  test('a group-targeted grant does not give a delegated principal authority', async () => {
    const APP = 'did:key:z6MkApp';
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: APP } },
        ],
      }),
    );
    // Both halves of the intersection are otherwise satisfied: the subject
    // holds a direct grant, and the app is on the granted group's roster.
    await stack.grant({ groupId: group.id }, [{ actions: ['create'], typeId: COMMENT }]);
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);

    await expect(
      stack.asEntity(APP, { onBehalfOf: MEMBER }).create(COMMENT, { text: 'hi' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a directly named app still reaches the subject through the intersection', async () => {
    const APP = 'did:key:z6MkApp';
    await stack.grant(APP, [{ actions: ['create'], typeId: COMMENT }]);

    // The subject needs its own standing too — authority intersects.
    await expect(
      stack.asEntity(APP, { onBehalfOf: MEMBER }).create(COMMENT, { text: 'hi' }),
    ).rejects.toThrow(StackPermissionError);

    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);
    const record = await stack
      .asEntity(APP, { onBehalfOf: MEMBER })
      .create(COMMENT, { text: 'hi' });
    expect(record.entityId).toBe(MEMBER);
    expect(record.principalId).toBe(APP);
  });

  test('a group-targeted grant still applies to the subject under delegation', async () => {
    const APP = 'did:key:z6MkApp';
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
      }),
    );
    // Only the principal side refuses roster-derived authority; the subject
    // is the entity a grant is written about, so its group grant counts.
    await stack.grant({ groupId: group.id }, [{ actions: ['create'], typeId: COMMENT }]);
    await stack.grant(APP, [{ actions: ['create'], typeId: COMMENT }]);

    const record = await stack
      .asEntity(APP, { onBehalfOf: MEMBER })
      .create(COMMENT, { text: 'hi' });
    expect(record.entityId).toBe(MEMBER);
  });

  test('a grant naming a record outside the _group family confers nothing', async () => {
    // Any Record's relationship associations would otherwise serve as a
    // roster, and a group migrated out of the family would keep resolving.
    const notAGroup = await stack.create(COMMENT, { text: 'not a group' });
    await stack.associate(notAGroup.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: MEMBER },
    });
    await stack.grant({ groupId: notAGroup.id }, [{ actions: ['read-any'], typeId: COMMENT }]);

    const target = await stack.create(COMMENT, { text: 'secret' });
    expect(await stack.asEntity(MEMBER).get(target.id)).toBeNull();
  });

  test('an empty granteeGroupId denies rather than widening to a default grant', async () => {
    // grant() refuses to write this; a _grant Record is an ordinary Record,
    // so evaluation has to refuse it again. Falling through to the default
    // tier here would grant the type to every authenticated entity.
    await adapter.createRecord(
      makeRecord({
        typeId: '_grant@1',
        content: { typeId: COMMENT, actions: ['read-any'], granteeGroupId: '' },
      }),
    );
    const record = await stack.create(COMMENT, { text: 'secret' });
    expect(await stack.asEntity(STRANGER).get(record.id)).toBeNull();
  });

  test('an empty granteeEntityId denies rather than widening to a default grant', async () => {
    await adapter.createRecord(
      makeRecord({
        typeId: '_grant@1',
        content: { typeId: COMMENT, actions: ['read-any'], granteeEntityId: '' },
      }),
    );
    const record = await stack.create(COMMENT, { text: 'secret' });
    expect(await stack.asEntity(STRANGER).get(record.id)).toBeNull();
  });

  // Roster resolution is memoized for one operation, not for the life of
  // the ScopedStack: asEntity() returns an object a caller may hold, and a
  // cache outliving the operation would let removal from a group go
  // unnoticed — the direction that must never go stale.
  test('a roster change takes effect on a ScopedStack that has already been used', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: MEMBER },
    });
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'secret' });

    const view = stack.asEntity(MEMBER);
    expect((await view.get(record.id))?.id).toBe(record.id);

    await stack.dissociate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: MEMBER },
    });
    expect(await view.get(record.id)).toBeNull();
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
    await stack.grant(MEMBER, [{ actions: ['read-own', 'update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: MEMBER });
    const updated = await stack.asEntity(MEMBER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });

  test('update-own: entity cannot update a record authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own', 'update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'edited' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('update-any: entity can update records regardless of authorship', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    const updated = await stack.asEntity(MEMBER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });

  test('delete-own: entity can delete a record they authored', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own', 'delete-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('delete-own: entity cannot delete a record authored by someone else', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-own', 'delete-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).delete(record.id)).rejects.toThrow(StackNotFoundError);
  });

  test('delete-any: entity can delete records regardless of authorship', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await stack.asEntity(MEMBER).delete(record.id);
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeDefined();
  });

  test('delete-any grant does not allow hard delete', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await expect(stack.asEntity(MEMBER).delete(record.id, { hard: true })).rejects.toThrow(
      StackPermissionError,
    );
    expect(await adapter.getRecord(record.id)).not.toBeNull();
  });

  test('update grant does not allow delete', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await expect(stack.asEntity(MEMBER).delete(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('delete grant does not allow update', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await expect(stack.asEntity(MEMBER).update(record.id, { text: 'edited' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('delete-any grant also allows undelete', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'delete-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });
    await stack.asEntity(MEMBER).delete(record.id);
    const undeleted = await stack.asEntity(MEMBER).undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('update grant does not allow undelete', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: MEMBER });
    await adapter.deleteRecord(record.id);
    await expect(stack.asEntity(MEMBER).undelete(record.id)).rejects.toThrow(StackPermissionError);
  });

  test('default grant (null entityId) applies update-own to any authenticated entity', async () => {
    await stack.grant(null, [{ actions: ['read-own', 'update-own'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'original' }, { entityId: STRANGER });
    const updated = await stack.asEntity(STRANGER).update(record.id, { text: 'edited' });
    expect(updated.content.text).toBe('edited');
  });
});

// -------------------------------------------------------
// Write implies read
// -------------------------------------------------------

// Both layers refuse mutation without read at the point of use, not only
// where they are written: a permissions array or a _grant record can arrive
// from an import, an unscoped Stack, or a server mapping a request body.
// See docs/spec/access-control.md § Write implies read.
describe('ScopedStack — write implies read', () => {
  /** A record with one prior version, whose permissions bypass validation. */
  async function recordWithHistory(permissions: Permission[]): Promise<StackRecord> {
    const record = await adapter.createRecord(
      makeRecord({ version: 2, content: { text: 'current' }, permissions }),
    );
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE,
      content: { text: 'draft-secret' },
      updatedAt: new Date(),
    });
    return record;
  }

  test('a write bit without read conveys neither the mutate surface nor history', async () => {
    const record = await recordWithHistory([
      { access: 'entity', entityId: MEMBER, read: false, write: true },
    ]);
    const view = stack.asEntity(MEMBER);
    expect(await view.get(record.id)).toBeNull();
    await expect(view.update(record.id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
    await expect(view.getVersions(record.id)).rejects.toThrow(StackNotFoundError);
    await expect(view.getVersion(record.id, 1)).rejects.toThrow(StackNotFoundError);
    await expect(view.restoreVersion(record.id, 1)).rejects.toThrow(StackNotFoundError);
    await expect(view.delete(record.id)).rejects.toThrow(StackNotFoundError);
    await expect(view.associate(record.id, { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('a group entry conveys no write without read either', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: MEMBER },
    });
    const record = await recordWithHistory([
      { access: 'group', groupId: group.id, read: false, write: true },
    ]);
    const view = stack.asEntity(MEMBER);
    await expect(view.update(record.id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
    await expect(view.getVersions(record.id)).rejects.toThrow(StackNotFoundError);
  });

  test('a mutate grant carrying no read action conveys nothing', async () => {
    await stack.create(`_grant@1`, {
      typeId: NOTE,
      actions: ['update-any', 'delete-any'],
      granteeEntityId: MEMBER,
    });
    const record = await recordWithHistory([]);
    const view = stack.asEntity(MEMBER);
    await expect(view.update(record.id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
    await expect(view.delete(record.id)).rejects.toThrow(StackNotFoundError);
    await expect(view.getVersions(record.id)).rejects.toThrow(StackNotFoundError);
  });

  // The companion is scope-matched: read over one's own records is not read
  // over the reach update-any can mutate.
  test('read-own does not license update-any, and leaves the read it does convey intact', async () => {
    await stack.create(`_grant@1`, {
      typeId: NOTE,
      actions: ['read-own', 'update-any'],
      granteeEntityId: MEMBER,
    });
    const own = await stack.create(NOTE, { text: 'mine' }, { entityId: MEMBER });
    const theirs = await recordWithHistory([]);
    const view = stack.asEntity(MEMBER);
    await expect(view.update(own.id, { text: 'edited' })).rejects.toThrow(StackPermissionError);
    await expect(view.update(theirs.id, { text: 'edited' })).rejects.toThrow(StackNotFoundError);
    expect((await view.get(own.id))?.content.text).toBe('mine');
  });

  test('a read companion in a separate grant record does not license the mutate one', async () => {
    await stack.create(`_grant@1`, {
      typeId: NOTE,
      actions: ['read-any'],
      granteeEntityId: MEMBER,
    });
    await stack.create(`_grant@1`, {
      typeId: NOTE,
      actions: ['update-any'],
      granteeEntityId: MEMBER,
    });
    const record = await recordWithHistory([]);
    const view = stack.asEntity(MEMBER);
    expect((await view.get(record.id))?.content.text).toBe('current');
    await expect(view.update(record.id, { text: 'edited' })).rejects.toThrow(StackPermissionError);
  });

  test('a delegated principal needs the read companion on its own side', async () => {
    const APP = 'did:key:z6MkApp';
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: NOTE }]);
    await stack.create(`_grant@1`, {
      typeId: NOTE,
      actions: ['update-any'],
      granteeEntityId: APP,
    });
    const record = await recordWithHistory([]);
    await expect(
      stack.asEntity(APP, { onBehalfOf: MEMBER }).update(record.id, { text: 'edited' }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Blind write
// -------------------------------------------------------

// The one shape that contributes without reading: `create` carries no read
// companion, since a record you write and cannot read back discloses
// nothing. See docs/spec/access-control.md § Write implies read.
describe('ScopedStack — blind write', () => {
  test('a create-only grantee writes records it cannot read back or enumerate', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: NOTE }]);
    const view = stack.asEntity(MEMBER);
    const posted = await view.create(NOTE, { text: 'for the owner' });
    const owners = await stack.create(NOTE, { text: 'already in the box' });

    expect(posted.entityId).toBe(MEMBER);
    expect(await view.get(posted.id)).toBeNull();
    expect(await view.get(owners.id)).toBeNull();
    await expect(view.getVersions(posted.id)).rejects.toThrow(StackNotFoundError);
    expect((await view.query({ filter: { typeId: NOTE } })).records).toEqual([]);
    expect((await stack.query({ filter: { typeId: NOTE } })).records).toHaveLength(2);
  });

  // A drop box's container is the one part of it a contributor must be able
  // to read: parenting is reference creation, gated on read of the target.
  test('parenting into a container requires read on the container', async () => {
    const box = await stack.create(NOTE, { text: 'inbox' });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: NOTE }]);
    await expect(
      stack.asEntity(MEMBER).create(NOTE, { text: 'hello' }, { parentId: box.id }),
    ).rejects.toThrow(StackPermissionError);

    await stack.setPermissions(box.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: false },
    ]);
    const posted = await stack
      .asEntity(MEMBER)
      .create(NOTE, { text: 'hello' }, { parentId: box.id });
    expect(posted.parentId).toBe(box.id);
  });
});

// -------------------------------------------------------
// ScopedStack.commitMigration
// -------------------------------------------------------

describe('ScopedStack.commitMigration', () => {
  const COMMENT_V2 = 'com.example.test/comment@2';

  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text', required: true } });
    await stack.defineType(
      COMMENT_V2,
      'Comment',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: COMMENT },
    );
  });

  test('anonymous requester cannot migrate a record', async () => {
    const record = await stack.create(COMMENT, { text: 'hello' });
    await expect(
      stack.asEntity(null).commitMigration(record.id, COMMENT_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(
      stack.asEntity(OWNER).commitMigration(generateId(), COMMENT_V2, { text: 'hello' }),
    ).rejects.toThrow(StackNotFoundError);
  });

  test('the owner acting alone can migrate a record', async () => {
    const record = await stack.create(COMMENT, { text: 'hello' });

    const migrated = await stack
      .asEntity(OWNER)
      .commitMigration(record.id, COMMENT_V2, { text: 'hello', title: '' });
    expect(migrated.typeId).toBe(COMMENT_V2);
    expect(migrated.content).toEqual({ text: 'hello', title: '' });
  });

  // Migration is owner-driven: migrateAll() is Stack-only and absent from
  // StackClient, and the per-record path carries the same restriction. No
  // combination of grants substitutes for it — ordinary write access to a
  // record is not consent to move it between families.
  test('an update grant on the record’s current family does not authorize migrating it', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, NOTE, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('update and create grants together still do not authorize a migration', async () => {
    await stack.grant(MEMBER, [
      { actions: ['read-any', 'update-any'], typeId: COMMENT },
      { actions: ['create'], typeId: NOTE },
    ]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, NOTE, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a grant naming both actions on one family does not cover an in-family migration', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any', 'create'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, COMMENT_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('record-level write on the record does not authorize migrating it', async () => {
    const record = await stack.create(COMMENT, { text: 'hello' });
    await stack.setPermissions(record.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, COMMENT_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot migrate an ordinary record into _app', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, '_app@1', {
        appId: 'com.example.impostor',
        name: 'Impostor',
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot migrate an ordinary record into _grant', async () => {
    await stack.grant(MEMBER, [{ actions: ['read-any', 'update-any'], typeId: COMMENT }]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack.asEntity(MEMBER).commitMigration(record.id, '_grant@1', {
        typeId: COMMENT,
        actions: ['create'],
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('the owner acting alone can migrate a record into a system family', async () => {
    const record = await stack.create(COMMENT, { text: 'hello' });

    const migrated = await stack.asEntity(OWNER).commitMigration(record.id, '_app@1', {
      appId: 'com.example.owner-tool',
      name: 'Owner Tool',
    });
    expect(migrated.typeId).toBe('_app@1');
  });

  // The owner's authority here is its own, so delegation never carries it:
  // an owner principal acting for a subject is not the owner acting alone,
  // the same rule deleteAttachment() and setPermissions() apply.
  test('an owner principal acting on behalf of a subject cannot migrate', async () => {
    const record = await stack.create(COMMENT, { text: 'hello' });

    await expect(
      stack
        .asEntity(OWNER, { onBehalfOf: MEMBER })
        .commitMigration(record.id, COMMENT_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot migrate a _grant record, even to a type they could otherwise create', async () => {
    const [grantRecord] = await stack.grant(MEMBER, [{ typeId: NOTE, actions: ['read-own'] }]);
    await stack.setPermissions(grantRecord.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);

    await expect(
      stack.asEntity(MEMBER).commitMigration(grantRecord.id, COMMENT, { text: 'x' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder with record-level write on an _app card cannot migrate it out of _app and shed its did', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: 'did:key:z6MkNotesApp',
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: COMMENT }]);

    await expect(
      stack.asEntity(MEMBER).commitMigration(shared.id, COMMENT, { text: 'hijacked' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a non-owner cannot claim the owner’s own did while migrating a record into _entity', async () => {
    await stack.grant(MEMBER, [
      { actions: ['read-any', 'update-any'], typeId: COMMENT },
      { actions: ['create'], typeId: '_entity@1' },
    ]);
    const record = await stack.create(COMMENT, { text: 'hello' }, { entityId: STRANGER });

    await expect(
      stack
        .asEntity(MEMBER)
        .commitMigration(record.id, '_entity@1', { did: OWNER, name: 'Impostor' }),
    ).rejects.toThrow(StackPermissionError);
  });

  // Regression: create() refuses a non-owner _attachment@1 record naming a
  // fileId they can't already reach, because an _attachment@1 record is
  // what canAccessFile()'s uploader clause reads. Migrate must not be a
  // second way in. See docs/spec/attachments.md § Creating `_attachment@1`
  // records directly.
  test('a grantee cannot reach attachment bytes by migrating a record into _attachment', async () => {
    const secret = await stack.putAttachment(new Uint8Array([1, 2, 3, 4]), 'text/plain', 's.txt');
    const fileId = secret.content.fileId;

    await stack.grant(MEMBER, [
      { actions: ['create', 'update-own', 'read-own'], typeId: COMMENT },
      { actions: ['create', 'read-own'], typeId: '_attachment@1' },
    ]);
    const view = stack.asEntity(MEMBER);

    // The direct route is already refused, and the bytes are out of reach.
    await expect(
      view.create('_attachment@1', { fileId, mimeType: 'text/plain', size: 4 }),
    ).rejects.toThrow(StackPermissionError);
    await expect(view.getAttachment(fileId)).rejects.toThrow(StackPermissionError);

    const decoy = await view.create(COMMENT, { text: 'decoy' });
    await expect(
      view.commitMigration(decoy.id, '_attachment@1', {
        fileId,
        mimeType: 'text/plain',
        size: 4,
      }),
    ).rejects.toThrow(StackPermissionError);
    await expect(view.getAttachment(fileId)).rejects.toThrow(StackPermissionError);
  });

  // Regression: _entity is grantable and requireOwnerForOwnerDid() guards
  // only the owner's own did, so binding immutability is what stops a
  // grantee moving a contact card onto another DID.
  test('a grantee cannot move an _entity card onto another did by migrating', async () => {
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });
    await stack.grant(MEMBER, [
      { actions: ['read-any', 'update-any', 'create'], typeId: '_entity@1' },
    ]);

    await expect(
      stack
        .asEntity(MEMBER)
        .commitMigration(card.id, '_entity@1', { did: 'did:key:zBob', name: 'Alice' }),
    ).rejects.toThrow(StackPermissionError);
    expect((await adapter.getRecord(card.id))?.content).toEqual({
      did: 'did:key:zAlice',
      name: 'Alice',
    });
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

    await stack.grant(MEMBER, [{ actions: ['create', 'read-own', 'update-own'], typeId: NOTE }]);
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
          { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: ADMIN } },
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
        ],
        ...overrides,
      }),
    );
  }

  test('plain member cannot update group content', async () => {
    const group = await makeGroup();
    await expect(stack.asEntity(MEMBER).update(group.id, { name: 'renamed' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('plain member cannot add or remove roster associations', async () => {
    const group = await makeGroup();
    const newMember: Association = {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: STRANGER },
    };
    await expect(stack.asEntity(MEMBER).associate(group.id, newMember)).rejects.toThrow(
      StackNotFoundError,
    );
    const existingMember: Association = {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: MEMBER },
    };
    await expect(stack.asEntity(MEMBER).dissociate(group.id, existingMember)).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('plain member cannot delete the group', async () => {
    const group = await makeGroup();
    await expect(stack.asEntity(MEMBER).delete(group.id)).rejects.toThrow(StackNotFoundError);
  });

  test('admin can update content, manage the roster, and delete the group', async () => {
    const group = await makeGroup();

    const updated = await stack.asEntity(ADMIN).update(group.id, { name: 'renamed' });
    expect(updated.content.name).toBe('renamed');

    const newMember: Association = {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: STRANGER },
    };
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
      StackNotFoundError,
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
    const newMember: Association = {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: STRANGER },
    };
    await expect(stack.asEntity(STRANGER).associate(group.id, newMember)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('setPermissions on a group requires admin, not just record authorship', async () => {
    const group = await makeGroup({ entityId: MEMBER });
    const perms: Permission[] = [{ access: 'public' }];
    // MEMBER authored the record but isn't an admin — generic creator carve-out doesn't apply.
    await expect(stack.asEntity(MEMBER).setPermissions(group.id, perms)).rejects.toThrow(
      StackNotFoundError,
    );
    await stack.asEntity(ADMIN).setPermissions(group.id, perms);
    expect((await adapter.getRecord(group.id))?.permissions).toEqual(perms);
  });

  test('setUnlisted on a group requires admin, not just record authorship', async () => {
    const group = await makeGroup({ entityId: MEMBER });
    // MEMBER authored the record but isn't an admin — generic creator carve-out doesn't apply.
    await expect(stack.asEntity(MEMBER).setUnlisted(group.id, true)).rejects.toThrow(
      StackNotFoundError,
    );
    await stack.asEntity(ADMIN).setUnlisted(group.id, true);
    expect((await adapter.getRecord(group.id))?.unlistedAt).toBeInstanceOf(Date);
  });

  test('creator is stamped as admin at create time and can manage the group afterward', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_group@1' }]);
    const group = await stack.asEntity(MEMBER).create('_group@1', { name: 'New Group' });
    expect(group.associations).toContainEqual({
      kind: 'relationship',
      label: 'admin',
      target: { scope: 'entity', entityId: MEMBER },
    });

    const updated = await stack.asEntity(MEMBER).update(group.id, { name: 'renamed' });
    expect(updated.content.name).toBe('renamed');
  });

  test('create-time bootstrap does not duplicate an explicitly supplied admin association', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_group@1' }]);
    const group = await stack.asEntity(MEMBER).create(
      '_group@1',
      { name: 'New Group' },
      {
        associations: [
          { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: MEMBER } },
        ],
      },
    );
    const adminAssociations = (group.associations ?? []).filter(
      (a) =>
        a.kind === 'relationship' &&
        a.label === 'admin' &&
        a.target.scope === 'entity' &&
        a.target.entityId === MEMBER,
    );
    expect(adminAssociations).toHaveLength(1);
  });

  // Bootstrap stamps the group's creator as its first admin exactly once —
  // the owner is no exception, and gets no duplicate roster entry.
  test('owner writing through ScopedStack stamps the owner as admin exactly once', async () => {
    const group = await stack.asEntity(OWNER).create('_group@1', { name: 'New Group' });
    expect(group.entityId).toBe(OWNER);
    const adminAssociations = (group.associations ?? []).filter(
      (a) =>
        a.kind === 'relationship' &&
        a.label === 'admin' &&
        a.target.scope === 'entity' &&
        a.target.entityId === OWNER,
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
          {
            kind: 'relationship',
            label: 'admin',
            target: { scope: 'entity', entityId: 'group-admin-2' },
          },
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
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
    expect(await stack.asEntity(MEMBER).get(record.id)).toBeNull();
    expect((await stack.asEntity('group-admin-2').get(record.id))?.id).toBe(record.id);
  });

  test('absent role behaves exactly as today — any member (or admin) qualifies', async () => {
    const admin = 'group-admin-3';
    const group = await adapter.createRecord(
      makeRecord({
        typeId: '_group',
        associations: [
          { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: admin } },
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: MEMBER } },
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
          associations: [
            {
              kind: 'relationship',
              label: 'related',
              target: { scope: 'record', recordId: unreadableNote.id },
            },
          ],
        },
      ),
    ).rejects.toThrow(StackPermissionError);
  });

  // An absent and an empty stackUrl are one target everywhere else, so
  // both spellings of a local Record meet the same gate — the reference is
  // refused for the access it names, before its shape is judged.
  test('a record target naming this stack with an empty stackUrl is gated', async () => {
    await expect(
      stack.asEntity(MEMBER).create(
        COMMENT,
        { text: 'hi' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'related',
              target: { scope: 'record', recordId: unreadableNote.id, stackUrl: '' },
            },
          ],
        },
      ),
    ).rejects.toThrow(StackPermissionError);
  });

  // The gate refuses a reference that would convey access to, or confirm
  // the existence of, an unreadable record. The other arms name nothing in
  // this stack, so there is nothing for it to protect and no check to make.
  test('a record target in another stack is not gated', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'reply-to',
            target: {
              scope: 'record',
              recordId: unreadableNote.id,
              stackUrl: 'https://alice.example/stack',
            },
          },
        ],
      },
    );
    expect(record.associations).toHaveLength(1);
  });

  test('an entity target is not gated', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'author',
            target: { scope: 'entity', entityId: 'did:key:z6MkAlice' },
          },
        ],
      },
    );
    expect(record.associations).toHaveLength(1);
  });

  test('an external target is not gated', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'syndicated-to',
            target: {
              scope: 'external',
              ns: 'atproto',
              id: 'at://did:plc:abc/app.bsky.feed.post/3k4',
            },
          },
        ],
      },
    );
    expect(record.associations).toHaveLength(1);
  });

  test('relationship association targeting a readable record is allowed', async () => {
    const record = await stack.asEntity(MEMBER).create(
      COMMENT,
      { text: 'hi' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'related',
            target: { scope: 'record', recordId: readableNote.id },
          },
        ],
      },
    );
    expect(record.associations).toContainEqual({
      kind: 'relationship',
      label: 'related',
      target: { scope: 'record', recordId: readableNote.id },
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
            {
              kind: 'relationship',
              label: 'related',
              target: { scope: 'record', recordId: 'nonexistent-record' },
            },
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
          associations: [
            {
              kind: 'relationship',
              label: 'related',
              target: { scope: 'record', recordId: unreadableNote.id },
            },
          ],
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
      target: { scope: 'entity', entityId: MEMBER },
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
        associations: [
          {
            kind: 'relationship',
            label: 'related',
            target: { scope: 'record', recordId: unreadableNote.id },
          },
        ],
      },
    );
    expect(record.parentId).toBe(unreadableNote.id);
  });
});

describe('ScopedStack.associate — reference-creation gating', () => {
  let ownedRecord: StackRecord;

  beforeEach(async () => {
    await stack.grant(MEMBER, [{ actions: ['create', 'read-own', 'update-own'], typeId: NOTE }]);
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
        target: { scope: 'record', recordId: unreadableNote.id },
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
    await stack.grant(MEMBER, [
      { actions: ['create', 'read-own', 'update-own'], typeId: PHOTO_NOTE },
    ]);
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

  // Taking the session whole is what a server should reach for: both
  // identities are DIDs, so a positional pair leaves nothing to catch a
  // swap, and a swap is invisible undelegated where the two are equal.
  test('forSession() scopes to the principal and subject a token names', async () => {
    await grantAll(APP);
    await grantAll(MEMBER);
    const record = await stack
      .forSession({ principalId: APP, subjectId: MEMBER })
      .create(COMMENT, { text: 'hi' });
    expect(record.entityId).toBe(MEMBER);
    expect(record.principalId).toBe(APP);
  });

  test('forSession() with one identity is the undelegated case', async () => {
    await grantAll(MEMBER);
    const record = await stack
      .forSession({ principalId: MEMBER, subjectId: MEMBER })
      .create(COMMENT, { text: 'hi' });
    expect(record.entityId).toBe(MEMBER);
    expect(record.principalId).toBeUndefined();
  });

  // What a swapped pair costs, and why no error catches it: both orders
  // are permitted here, and they differ only in who the write is
  // attributed to — so `-own` afterwards resolves against the software
  // rather than the person it acted for.
  test('a swapped pair attributes the write to the app instead of the person', async () => {
    await grantAll(APP);
    await grantAll(MEMBER);
    const correct = await stack
      .forSession({ principalId: APP, subjectId: MEMBER })
      .create(COMMENT, { text: 'hi' });
    const swapped = await stack
      .forSession({ principalId: MEMBER, subjectId: APP })
      .create(COMMENT, { text: 'hi' });
    expect(correct.entityId).toBe(MEMBER);
    expect(swapped.entityId).toBe(APP);
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
    expect(await view.get(theirs.id)).toBeNull();
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
    expect(await stack.asEntity(APP, { onBehalfOf: MEMBER }).get(shared.id)).toBeNull();
  });

  // Owner bypass keys on the principal. An app delegated for the owner is
  // bounded by its grants; it does not inherit the owner's unconditional
  // access.
  test('an app delegated for the owner gets no owner bypass', async () => {
    const record = await adapter.createRecord(makeRecord({ content: { text: 'private' } }));
    expect(await stack.asEntity(APP, { onBehalfOf: OWNER }).get(record.id)).toBeNull();
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

  // The owner-or-creator rule is asked of both identities. An owner
  // principal holds the verb, so only the subject half stands between a
  // delegated subject and every record in the stack.
  test('an owner principal cannot reshare a record its subject did not author', async () => {
    const record = await stack.create(COMMENT, { text: 'owner private' });
    const view = stack.asEntity(OWNER, { onBehalfOf: MEMBER });

    await expect(view.setPermissions(record.id, [{ access: 'public' }])).rejects.toThrow(
      StackNotFoundError,
    );
    expect((await stack.get(record.id))?.permissions).toBeUndefined();
  });

  // The subject half is authorship, not reachability in general: a subject
  // may still reshare what it wrote, which is the reach it holds undelegated.
  test('an owner principal may reshare a record its subject authored', async () => {
    await grantAll(MEMBER);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'mine' });

    await stack
      .asEntity(OWNER, { onBehalfOf: MEMBER })
      .setPermissions(record.id, [{ access: 'public' }]);

    expect((await stack.get(record.id))?.permissions).toEqual([{ access: 'public' }]);
  });

  // Closes the route from the gate above to the _app registry: a card the
  // owner wrote is not the subject's to reshare, so record-level write on
  // it never becomes available to point its did at the subject's own key.
  test('an owner principal cannot reach an _app card through its subject', async () => {
    const card = await stack.asEntity(OWNER).create('_app@1', { appId: 'com.trusted', name: 'T' });
    const view = stack.asEntity(OWNER, { onBehalfOf: MEMBER });

    await expect(
      view.setPermissions(card.id, [
        { access: 'entity', entityId: MEMBER, read: true, write: true },
      ]),
    ).rejects.toThrow(StackNotFoundError);
    await expect(view.update(card.id, { did: 'did:key:z6MkMember' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  // The gate above rests on the subject being unable to reach the card at
  // all. Record-level write is shareable, so where the subject can reach
  // it, the owner-alone rule on the binding fields is the whole fence.
  test('an owner principal cannot set a card binding for a subject holding write on it', async () => {
    const card = await stack.asEntity(OWNER).create('_app@1', { appId: 'com.trusted', name: 'T' });
    await stack.setPermissions(card.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    const view = stack.asEntity(OWNER, { onBehalfOf: MEMBER });

    await expect(view.update(card.id, { did: 'did:key:z6MkMember' })).rejects.toThrow(
      StackPermissionError,
    );
    await expect(view.update(card.id, { appId: 'com.example.bank' })).rejects.toThrow(
      StackPermissionError,
    );

    const after = await stack.get(card.id);
    expect(after?.content).toMatchObject({ appId: 'com.trusted' });
    expect((after?.content as { did?: string }).did).toBeUndefined();
  });

  // The uploader clause matches on the subject a scoped create stamps, so
  // the owner's exemption from the _attachment@1 refusal has to be the
  // owner's own — otherwise naming a fileId is enough to reach its bytes.
  test('an owner principal cannot mint an attachment card for a file its subject cannot reach', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([9, 9, 9]), 'image/png', 'secret.png');

    const view = stack.asEntity(OWNER, { onBehalfOf: MEMBER });
    await expect(
      view.create('_attachment@1', { fileId, mimeType: 'image/png', size: 3 }),
    ).rejects.toThrow(StackPermissionError);

    await expect(stack.asEntity(MEMBER).getAttachment(fileId)).rejects.toThrow(
      StackPermissionError,
    );
  });

  // The create-time counterpart of the setPermissions gate above. Denying
  // the app setPermissions() only contains it if the same reach isn't
  // available one step earlier, while it is authoring the record.
  test('an app delegated for the owner cannot publish its subject records at create time', async () => {
    await grantAll(APP);
    await grantAll(null);
    const view = stack.asEntity(APP, { onBehalfOf: OWNER });
    await expect(
      view.create(
        COMMENT,
        { text: 'meant to stay private' },
        { permissions: [{ access: 'public' }] },
      ),
    ).rejects.toThrow(StackPermissionError);

    // Refused before the write, so there is no record to have leaked.
    const all = await stack.query({ filter: { typeId: COMMENT } });
    expect(all.records).toHaveLength(0);
  });

  test('a delegated app may still create records it does not try to share', async () => {
    await grantAll(APP);
    await grantAll(null);
    const record = await stack
      .asEntity(APP, { onBehalfOf: OWNER })
      .create(COMMENT, { text: 'hi' }, { permissions: [] });
    expect(record.permissions).toBeUndefined();
  });

  test('an undelegated requester may still set permissions at create time', async () => {
    await grantAll(MEMBER);
    const record = await stack
      .asEntity(MEMBER)
      .create(COMMENT, { text: 'hi' }, { permissions: [{ access: 'public' }] });
    expect(record.permissions).toEqual([{ access: 'public' }]);
  });

  // Bytes follow the same intersection as the records describing them.
  // The uploader clause decides *which* files the subject authored; it is
  // not itself a grant, so the app still needs one of its own.
  test('an app with no grant of its own cannot download files its subject uploaded', async () => {
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const attachment = await stack
      .asEntity(MEMBER)
      .putAttachment(new Uint8Array([1, 2, 3]), 'text/plain', 'secret.txt');
    const { fileId } = attachment.content;

    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    // The record describing the bytes is already refused ...
    expect(await view.get(attachment.id)).toBeNull();
    // ... so the bytes themselves must be too.
    await expect(view.getAttachment(fileId)).rejects.toThrow(StackPermissionError);
  });

  test('an app delegated for a group admin cannot manage the group', async () => {
    const group = await stack.create('_group@1', { name: 'Book Club' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'admin',
      target: { scope: 'entity', entityId: MEMBER },
    });
    expect(await stack.asEntity(MEMBER).update(group.id, { name: 'Renamed' })).toBeTruthy();
    await expect(
      stack.asEntity(APP, { onBehalfOf: MEMBER }).update(group.id, { name: 'Hijacked' }),
    ).rejects.toThrow(StackNotFoundError);
  });

  // Default grants say "any authenticated entity" — people who turn up,
  // not software the owner installed. An app reaches only what it is named
  // in, which is the whole of what containment promises.
  test('a default grant does not satisfy the principal side of the intersection', async () => {
    await grantAll(null);
    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);

    // The same default grant is all an undelegated requester needs.
    const direct = await stack.asEntity(MEMBER).create(COMMENT, { text: 'hi' });
    expect(direct.entityId).toBe(MEMBER);
  });

  // Unconditional owner authority belongs to the owner acting as itself.
  // The verbs resting on it are irreversible or disclose the sharing
  // graph, so delegation carries none of them, whichever side the owner
  // is on. The group rule below is two-sided instead, like setPermissions.
  test('an owner principal cannot hard delete for its subject', async () => {
    await grantAll(MEMBER);
    const record = await stack.asEntity(MEMBER).create(COMMENT, { text: 'mine' });

    await expect(
      stack.asEntity(OWNER, { onBehalfOf: MEMBER }).delete(record.id, { hard: true }),
    ).rejects.toThrow(StackPermissionError);

    // Soft delete is still reachable, so the refusal is about the verb.
    await stack.asEntity(OWNER, { onBehalfOf: MEMBER }).delete(record.id);
    expect((await stack.get(record.id))?.deletedAt).toBeDefined();
  });

  test('an owner principal does not disclose snapshot permissions to its subject', async () => {
    const record = await stack.create(COMMENT, { text: 'v1' });
    await stack.setPermissions(record.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    await stack.update(record.id, { text: 'v2' });

    const versions = await stack.asEntity(OWNER, { onBehalfOf: MEMBER }).getVersions(record.id);
    expect(versions.every((v) => v.permissions === undefined)).toBe(true);

    // The owner acting alone still sees them.
    const direct = await stack.asEntity(OWNER).getVersions(record.id);
    expect(direct.some((v) => v.permissions !== undefined)).toBe(true);
  });

  test('an owner principal cannot delete attachments for its subject', async () => {
    const attachment = await stack.putAttachment(new Uint8Array([1, 2, 3]), 'text/plain');
    const view = stack.asEntity(OWNER, { onBehalfOf: MEMBER });

    await expect(view.deleteAttachment(attachment.content.fileId)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(view.collectAttachmentGarbage()).rejects.toThrow(StackPermissionError);
  });

  test('an owner principal cannot manage a group its subject does not administer', async () => {
    const group = await stack.create('_group@1', { name: 'Book Club' });

    await expect(
      stack.asEntity(OWNER, { onBehalfOf: MEMBER }).update(group.id, { name: 'Hijacked' }),
    ).rejects.toThrow(StackNotFoundError);

    // An admin subject reaches it, since both identities then manage it.
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'admin',
      target: { scope: 'entity', entityId: MEMBER },
    });
    expect(
      await stack.asEntity(OWNER, { onBehalfOf: MEMBER }).update(group.id, { name: 'Renamed' }),
    ).toBeTruthy();
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

// -------------------------------------------------------
// _app registry integrity, through a scoped view
// -------------------------------------------------------

// _app is ungrantable, so only the owner registers a card. Record-level
// write on one is still shareable, and that is enough to reach restore.
describe('ScopedStack — _app bindings', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  test('a non-owner cannot create an _app card', async () => {
    await expect(
      stack
        .asEntity(MEMBER)
        .create('_app@1', { appId: 'com.example.impostor', name: 'Impostor', did: APP_DID }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a non-owner with write on a card cannot give it a DID', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    await expect(stack.asEntity(MEMBER).update(shared.id, { did: MEMBER })).rejects.toThrow(
      StackPermissionError,
    );

    const after = await stack.get(shared.id);
    expect((after?.content as { did?: string }).did).toBeUndefined();
  });

  test('a non-owner with write on a card cannot roll it back off its DID', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
    });
    await stack.update(shared.id, { did: APP_DID });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    await expect(stack.asEntity(MEMBER).restoreVersion(shared.id, 1)).rejects.toThrow(
      StackPermissionError,
    );

    const after = await stack.get(shared.id);
    expect((after?.content as { did?: string }).did).toBe(APP_DID);
  });

  test('a non-owner with write on a card may still update its other fields', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    const updated = await stack.asEntity(MEMBER).update(shared.id, { version: '2.0.0' });
    expect((updated.content as { did?: string }).did).toBe(APP_DID);
  });

  // The fence reads values, not keys. Read-modify-write is the ordinary
  // client shape, and a card sent back with its bindings untouched is
  // exercising the display-field reach the test above pins — a presence
  // check would make that reach unreachable for any client that round-trips
  // the whole content object.
  test('a write-holder may round-trip unchanged bindings in a full-content update', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    const scoped = stack.asEntity(MEMBER);
    const current = await scoped.get(shared.id);
    const updated = await scoped.update(shared.id, { ...current!.content, name: 'Renamed' });

    expect(updated.content).toMatchObject({
      appId: 'com.example.notes',
      name: 'Renamed',
      did: APP_DID,
    });
  });
});

// The owner-only rule covers both halves of the attribution lookup: a
// write-holder who could relabel a card's appId would make their own key
// verify as another app, reaching the same end as repointing its did.
describe('ScopedStack — _app.appId is owner-only', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  test('a non-owner with write on a card cannot change its appId', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    await expect(
      stack.asEntity(MEMBER).update(shared.id, { appId: 'com.example.bank' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a non-owner with write on a card may still update its display fields', async () => {
    const shared = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.setPermissions(shared.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);

    const updated = await stack.asEntity(MEMBER).update(shared.id, { version: '2.0.0' });
    expect(updated.content).toMatchObject({ appId: 'com.example.notes', version: '2.0.0' });
  });
});

// _entity stays grantable — naming people is what a contacts app does — so
// its cards are reachable by grant, and only the binding rules fence them.
describe('ScopedStack — _entity bindings hold under a grant', () => {
  const ALICE = 'did:key:z6MkAlice';

  test('a grantee may write a petname card but not repoint an existing one', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await stack.grant(MEMBER, [
      { typeId: '_entity@1', actions: ['create', 'read-any', 'update-any'] },
    ]);
    const scoped = stack.asEntity(MEMBER);

    // Relabelling is the contacts-app case and stays allowed.
    await expect(scoped.update(alice.id, { name: 'Alice Smith' })).resolves.toBeDefined();

    // Repointing is the impersonation and is refused.
    await expect(scoped.update(alice.id, { did: MEMBER })).rejects.toThrow(StackValidationError);
  });

  test('a grantee cannot mint a second card for a DID already carded', async () => {
    await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await stack.grant(MEMBER, [{ typeId: '_entity@1', actions: ['create'] }]);

    await expect(
      stack.asEntity(MEMBER).create('_entity@1', { did: ALICE, name: 'Alice (verified)' }),
    ).rejects.toThrow(StackConflictError);
  });

  // Every other DID stays open to a contacts app, but the owner's own is
  // reserved: `ownerProfile` adopts whichever card holds it, and uniqueness
  // makes the first claim permanent.
  test('a grantee cannot mint a card for the owner own DID', async () => {
    await stack.grant(MEMBER, [
      { typeId: '_entity@1', actions: ['create', 'read-any', 'update-any'] },
    ]);

    await expect(
      stack.asEntity(MEMBER).create('_entity@1', { did: OWNER, name: 'Totally The Owner' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a grantee cannot adopt the owner own DID onto a card carrying none', async () => {
    const blank = await stack.create('_entity@1', { did: '', name: 'Unclaimed' });
    await stack.grant(MEMBER, [{ typeId: '_entity@1', actions: ['read-any', 'update-any'] }]);

    await expect(stack.asEntity(MEMBER).update(blank.id, { did: OWNER })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('the owner acting alone may card their own DID', async () => {
    const card = await stack.asEntity(OWNER).create('_entity@1', { did: OWNER, name: 'Me' });
    expect((card.content as { did: string }).did).toBe(OWNER);
  });

  test('an app delegated for the owner cannot card the owner own DID', async () => {
    const APP = 'did:key:z6MkApp';
    await stack.grant(APP, [{ typeId: '_entity@1', actions: ['create'] }]);

    await expect(
      stack
        .asEntity(APP, { onBehalfOf: OWNER })
        .create('_entity@1', { did: OWNER, name: 'Owner, per the app' }),
    ).rejects.toThrow(StackPermissionError);
  });

  // The reservation is on *claiming* the DID. Re-sending the value a card
  // already holds claims nothing, and immutability refuses changing it — so
  // refusing the round-trip would only stop a grantee relabelling the card,
  // which is the reach a grant on _entity exists to give.
  test('a grantee may relabel the owner card while round-tripping its DID', async () => {
    const ownerCard = await stack.asEntity(OWNER).create('_entity@1', { did: OWNER, name: 'Me' });
    await stack.grant(MEMBER, [{ typeId: '_entity@1', actions: ['read-any', 'update-any'] }]);

    const scoped = stack.asEntity(MEMBER);
    const current = await scoped.get(ownerCard.id);
    const updated = await scoped.update(ownerCard.id, { ...current!.content, name: 'The Owner' });

    expect(updated.content).toMatchObject({ did: OWNER, name: 'The Owner' });
  });
});

describe('ScopedStack — _grant records are owner-write-only', () => {
  // A _grant Record is authority itself, so record-level `write` on one must
  // not be a route to editing what it confers — the same escalation
  // ungrantable families are refused at evaluation, reached by rewriting an
  // existing grant instead of minting a fresh one.
  const shareGrantRecord = async () => {
    const [grantRecord] = await stack.grant(MEMBER, [{ typeId: NOTE, actions: ['read-own'] }]);
    await stack.setPermissions(grantRecord.id, [
      { access: 'entity', entityId: MEMBER, read: true, write: true },
    ]);
    return grantRecord;
  };

  test('a write-holder cannot widen the actions on their own grant', async () => {
    const grantRecord = await shareGrantRecord();

    await expect(
      stack.asEntity(MEMBER).update(grantRecord.id, { actions: ['read-any'] }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot retarget a grant at another type', async () => {
    const grantRecord = await shareGrantRecord();

    await expect(
      stack.asEntity(MEMBER).update(grantRecord.id, { typeId: COMMENT }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot reassign a grant to another grantee', async () => {
    const grantRecord = await shareGrantRecord();

    await expect(
      stack.asEntity(MEMBER).update(grantRecord.id, { granteeEntityId: STRANGER }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a write-holder cannot delete or reshare a grant record', async () => {
    const grantRecord = await shareGrantRecord();
    const scoped = stack.asEntity(MEMBER);

    await expect(scoped.delete(grantRecord.id)).rejects.toThrow(StackPermissionError);
    await expect(scoped.setPermissions(grantRecord.id, [{ access: 'public' }])).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('an owner principal acting for someone else cannot write a grant record', async () => {
    const grantRecord = await shareGrantRecord();

    await expect(
      stack.asEntity(OWNER, { onBehalfOf: MEMBER }).update(grantRecord.id, {
        actions: ['read-any'],
      }),
    ).rejects.toThrow(StackPermissionError);
  });

  // The fence is on writes. Reading how a Record you already hold got that
  // way is not the escalation it exists to stop, and a write-holder who
  // could not audit the grant they hold would be worse off than before.
  test('a write-holder still reads a grant record and its history', async () => {
    const grantRecord = await shareGrantRecord();
    await stack.update(grantRecord.id, { actions: ['read-any'] });
    const scoped = stack.asEntity(MEMBER);

    expect(await scoped.get(grantRecord.id)).not.toBeNull();

    const versions = await scoped.getVersions(grantRecord.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect((versions[0].content as { actions: string[] }).actions).toEqual(['read-own']);

    const v1 = await scoped.getVersion(grantRecord.id, 1);
    expect(v1).not.toBeNull();
  });

  test('a write-holder reading grant history still gets snapshot permissions stripped', async () => {
    const grantRecord = await shareGrantRecord();
    await stack.update(grantRecord.id, { actions: ['read-any'] });

    const versions = await stack.asEntity(MEMBER).getVersions(grantRecord.id);
    expect(versions.every((v) => v.permissions === undefined)).toBe(true);
  });

  // Restoring is a write, so it stays fenced even though reading the
  // snapshot it would restore does not.
  test('a write-holder cannot restore a grant record to an earlier version', async () => {
    const grantRecord = await shareGrantRecord();
    await stack.update(grantRecord.id, { actions: ['read-any'] });

    await expect(stack.asEntity(MEMBER).restoreVersion(grantRecord.id, 1)).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('the owner acting alone still maintains grant records', async () => {
    const [grantRecord] = await stack.grant(MEMBER, [{ typeId: NOTE, actions: ['read-own'] }]);

    await expect(
      stack.asEntity(OWNER).update(grantRecord.id, { actions: ['read-any'] }),
    ).resolves.toBeDefined();
  });
});

describe('ScopedStack — a delegated appId must match the registered _app card', () => {
  const APP = 'did:key:z6MkApp';

  beforeEach(async () => {
    await stack.defineType(COMMENT, 'Comment', { text: { kind: 'text' } });
    await stack.grant(APP, [{ typeId: COMMENT, actions: ['create'] }]);
    await stack.grant(MEMBER, [{ typeId: COMMENT, actions: ['create'] }]);
    await stack.grant(APP, [{ typeId: '_attachment@1', actions: ['create'] }]);
    await stack.grant(MEMBER, [{ typeId: '_attachment@1', actions: ['create'] }]);
  });

  const register = (appId: string) => stack.create('_app@1', { appId, name: 'Notes', did: APP });

  test('a verified principal cannot claim an appId the owner gave other software', async () => {
    await register('com.example.notes');

    await expect(
      stack
        .asEntity(APP, { onBehalfOf: MEMBER })
        .create(COMMENT, { text: 'hi' }, { appId: 'com.example.trustedbank' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('the appId its card names is accepted', async () => {
    await register('com.example.notes');

    const record = await stack
      .asEntity(APP, { onBehalfOf: MEMBER })
      .create(COMMENT, { text: 'hi' }, { appId: 'com.example.notes' });
    expect(record.appId).toBe('com.example.notes');
  });

  test('a principal the owner never registered keeps appId as a self-report', async () => {
    const record = await stack
      .asEntity(APP, { onBehalfOf: MEMBER })
      .create(COMMENT, { text: 'hi' }, { appId: 'com.example.anything' });
    expect(record.appId).toBe('com.example.anything');
  });

  test('an undelegated writer is unaffected, having no verified principal', async () => {
    await register('com.example.notes');

    const record = await stack
      .asEntity(MEMBER)
      .create(COMMENT, { text: 'hi' }, { appId: 'com.example.somethingelse' });
    expect(record.appId).toBe('com.example.somethingelse');
    expect(record.principalId).toBeUndefined();
  });

  test('putAttachment stamps appId under the same rule', async () => {
    await register('com.example.notes');
    const view = stack.asEntity(APP, { onBehalfOf: MEMBER });

    await expect(
      view.putAttachment(new Uint8Array([1, 2, 3]), 'text/plain', 'a.txt', 'com.example.evil'),
    ).rejects.toThrow(StackPermissionError);

    const ok = await view.putAttachment(
      new Uint8Array([1, 2, 3]),
      'text/plain',
      'a.txt',
      'com.example.notes',
    );
    expect(ok.appId).toBe('com.example.notes');
  });
});
