import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import type { RecordChange, StackRecord } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'owner-123';
const READER = 'did:key:zReader';
const OTHER = 'did:key:zOther';
const APP = 'did:key:zApp';

let adapter: MemoryAdapter;
let stack: Stack;

const collector = () => {
  const seen: RecordChange[] = [];
  return { seen, handler: (change: RecordChange) => void seen.push(change) };
};

/** Scoped delivery is asynchronous by construction — the permission check is. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
});

// -------------------------------------------------------
// canRead decides, per event
// -------------------------------------------------------

describe('a record the subscriber cannot read produces no event', () => {
  test('a private record is invisible to everyone but the owner', async () => {
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'private' });
    await settle();

    expect(reader.seen).toEqual([]);
  });

  test('a public record reaches an anonymous subscriber', async () => {
    const anon = collector();
    await stack.asEntity(null).subscribe(anon.handler, { filter: { typeId: NOTE } });

    const note = await stack.create(
      NOTE,
      { text: 'public' },
      { permissions: [{ access: 'public' }] },
    );
    await settle();

    expect(anon.seen.map((c) => c.recordId)).toEqual([note.id]);
  });

  test('an entity permission reaches its named subject and nobody else', async () => {
    const reader = collector();
    const other = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });
    await stack.asEntity(OTHER).subscribe(other.handler, { filter: { typeId: NOTE } });

    await stack.create(
      NOTE,
      { text: 'shared' },
      { permissions: [{ access: 'entity', entityId: READER, read: true, write: false }] },
    );
    await settle();

    expect(reader.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
  });

  test('gaining access arrives as `changed`, not `created`', async () => {
    const note = await stack.create(NOTE, { text: 'private' });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.setPermissions(note.id, [
      { access: 'entity', entityId: READER, read: true, write: false },
    ]);
    await settle();

    expect(reader.seen.map((c) => [c.kind, c.op])).toEqual([['changed', 'permissions']]);
  });

  test('losing access is silent — no event, and no signal that one was withheld', async () => {
    const note = await stack.create(
      NOTE,
      { text: 'shared' },
      { permissions: [{ access: 'entity', entityId: READER, read: true, write: false }] },
    );
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.setPermissions(note.id, []);
    await stack.update(note.id, { text: 'edited after revocation' });
    await settle();

    expect(reader.seen).toEqual([]);
  });

  test('a purge is filtered on the record as it stood, since nothing survives it', async () => {
    const visible = await stack.create(
      NOTE,
      { text: 'shared' },
      { permissions: [{ access: 'entity', entityId: READER, read: true, write: false }] },
    );
    const hidden = await stack.create(NOTE, { text: 'private' });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.delete(visible.id, { hard: true });
    await stack.delete(hidden.id, { hard: true });
    await settle();

    expect(reader.seen.map((c) => c.recordId)).toEqual([visible.id]);
    expect(reader.seen[0]!.record).toBeUndefined();
  });
});

// -------------------------------------------------------
// Grants
// -------------------------------------------------------

describe('type-level grants reach the feed exactly as they reach query()', () => {
  test('a read grant delivers records the subject does not own', async () => {
    await stack.grant(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'granted' });
    await settle();

    expect(reader.seen).toHaveLength(1);
  });

  test('a delegated session sees the intersection, not either half', async () => {
    await stack.grant(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    const delegated = collector();
    // The app holds no grant on this type, so the intersection is empty
    // however much the subject may read.
    await stack
      .asEntity(APP, { onBehalfOf: READER })
      .subscribe(delegated.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'granted to the person, not the app' });
    await settle();

    expect(delegated.seen).toEqual([]);
  });
});

// -------------------------------------------------------
// Cache invalidation — the fail-open case
// -------------------------------------------------------

describe('a revocation takes effect on the next event, not the next subscription', () => {
  test('revoking a grant stops delivery', async () => {
    await stack.grant(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'before revocation' });
    await settle();
    expect(reader.seen).toHaveLength(1);

    await stack.revoke(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    await stack.create(NOTE, { text: 'after revocation' });
    await settle();

    // The grant cache was dropped by the `_grant` write itself, which is
    // why holding one across a long-lived subscription is safe at all.
    expect(reader.seen).toHaveLength(1);
  });

  test('granting mid-subscription starts delivery without resubscribing', async () => {
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'before grant' });
    await settle();
    expect(reader.seen).toEqual([]);

    await stack.grant(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    await stack.create(NOTE, { text: 'after grant' });
    await settle();

    expect(reader.seen).toHaveLength(1);
  });

  test('removal from a group roster stops delivery through a group-targeted grant', async () => {
    const group = await stack.create(
      '_group@1',
      { name: 'Team' },
      {
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: READER } },
        ],
      },
    );
    // A grant naming the group, not the entity: reachability now depends on
    // the roster, which is the lookup a subscription caches.
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: NOTE }]);
    const note = await stack.create(NOTE, { text: 'team note' });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.update(note.id, { text: 'while a member' });
    await settle();
    expect(reader.seen).toHaveLength(1);

    await stack.dissociate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: READER },
    });
    await stack.update(note.id, { text: 'after removal' });
    await settle();

    expect(reader.seen).toHaveLength(1);
  });

  test('a revocation that lands mid-prefetch still expires the cached grants', async () => {
    await stack.grant(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    // Hold the subscription's first grant prefetch open so the revocation
    // commits while it is still in flight: the set it resolves with is
    // already stale, and seating it would outlive every later invalidation.
    const query = adapter.queryRecords.bind(adapter);
    let held = false;
    adapter.queryRecords = async (q) => {
      const result = await query(q);
      const grantQuery =
        typeof q.filter?.typeId === 'string' && q.filter.typeId.startsWith('_grant');
      if (grantQuery && !held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result;
    };

    await stack.create(NOTE, { text: 'starts the prefetch' });
    await settle();
    await stack.revoke(READER, [{ actions: ['read-any'], typeId: NOTE }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const delivered = reader.seen.length;
    await stack.create(NOTE, { text: 'after revocation' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reader.seen.length).toBe(delivered);
  });

  test('a record-level group permission follows the roster too', async () => {
    const group = await stack.create(
      '_group@1',
      { name: 'Team' },
      {
        associations: [
          { kind: 'relationship', label: 'member', target: { scope: 'entity', entityId: READER } },
        ],
      },
    );
    const note = await stack.create(
      NOTE,
      { text: 'team note' },
      { permissions: [{ access: 'group', groupId: group.id, read: true, write: false }] },
    );
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { filter: { typeId: NOTE } });

    await stack.update(note.id, { text: 'while a member' });
    await settle();
    expect(reader.seen).toHaveLength(1);

    await stack.dissociate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: READER },
    });
    await stack.update(note.id, { text: 'after removal' });
    await settle();

    expect(reader.seen).toHaveLength(1);
  });
});

// -------------------------------------------------------
// Unlisted records — the feed matches query()'s default exclusion, with
// the `unlist` transition itself as the one exception. See
// docs/spec/events.md § The unlisted transition.
// -------------------------------------------------------

describe('the feed excludes unlisted records like an equivalent query() would', () => {
  test('includeUnlisted is refused to a non-owner at subscribe() time', async () => {
    await expect(
      stack.asEntity(READER).subscribe(() => {}, { includeUnlisted: true }),
    ).rejects.toThrow('includeUnlisted is owner-only');
  });

  test('a record created unlisted produces no event for a default subscriber', async () => {
    const owner = collector();
    await stack.asEntity(OWNER).subscribe(owner.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    await settle();

    expect(owner.seen).toEqual([]);
  });

  test('an edit to an already-unlisted record produces no event for a default subscriber', async () => {
    const note = await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    const owner = collector();
    await stack.asEntity(OWNER).subscribe(owner.handler, { filter: { typeId: NOTE } });

    await stack.update(note.id, { text: 'still unlisted' });
    await settle();

    expect(owner.seen).toEqual([]);
  });

  test('the unlist transition itself reaches a default subscriber, as kind "deleted"', async () => {
    const note = await stack.create(NOTE, { text: 'was public' });
    const owner = collector();
    await stack.asEntity(OWNER).subscribe(owner.handler, { filter: { typeId: NOTE } });

    await stack.setUnlisted(note.id, true);
    await settle();

    expect(owner.seen.map((c) => [c.kind, c.op])).toEqual([['deleted', 'unlist']]);
  });

  test('the list transition reaches a default subscriber, as an ordinary upsert', async () => {
    const note = await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    const owner = collector();
    await stack.asEntity(OWNER).subscribe(owner.handler, { filter: { typeId: NOTE } });

    await stack.setUnlisted(note.id, false);
    await settle();

    expect(owner.seen.map((c) => [c.kind, c.op])).toEqual([['changed', 'list']]);
  });

  test('the owner acting alone with includeUnlisted sees the create and the silent edit', async () => {
    const owner = collector();
    await stack
      .asEntity(OWNER)
      .subscribe(owner.handler, { filter: { typeId: NOTE }, includeUnlisted: true });

    const note = await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    await stack.update(note.id, { text: 'still unlisted' });
    await settle();

    expect(owner.seen.map((c) => c.op)).toEqual(['create', 'update']);
  });
});

// -------------------------------------------------------
// Ordering and failure
// -------------------------------------------------------

describe('scoped delivery keeps the guarantees the emitter makes', () => {
  test('per-record order survives the asynchronous permission check', async () => {
    const note = await stack.create(NOTE, { text: 'v1' }, { permissions: [{ access: 'public' }] });
    const anon = collector();
    await stack.asEntity(null).subscribe(anon.handler, { filter: { typeId: NOTE } });

    for (let i = 2; i <= 12; i++) await stack.update(note.id, { text: `v${i}` });
    await settle();

    expect(anon.seen.map((c) => c.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('a permission check that throws drops the event and reports it', async () => {
    const errors: unknown[] = [];
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, {
      filter: { typeId: NOTE },
      onError: (err) => void errors.push(err),
    });

    // A group permission whose roster record cannot be read at all: the
    // resolver throws rather than answering.
    const broken = new Error('grant lookup failed');
    const original = adapter.queryRecords.bind(adapter);
    adapter.queryRecords = async () => {
      throw broken;
    };
    await stack.create(NOTE, { text: 'unreadable decision' }, { permissions: [] });
    await settle();
    adapter.queryRecords = original;

    expect(reader.seen).toEqual([]);
    expect(errors).toContain(broken);
  });

  test('a scoped subscriber sees its own writes', async () => {
    await stack.grant(READER, [{ actions: ['create', 'read-any'], typeId: NOTE }]);
    const scoped = stack.asEntity(READER);
    const reader = collector();
    await scoped.subscribe(reader.handler, { filter: { typeId: NOTE }, includeRecords: true });

    const note = await scoped.create(NOTE, { text: 'mine' });
    await settle();

    expect(reader.seen.map((c) => c.recordId)).toEqual([note.id]);
    expect((reader.seen[0]!.record as StackRecord).entityId).toBe(READER);
    expect(reader.seen[0]!.actor).toEqual({ entityId: READER });
  });

  test('unsubscribing stops delivery even mid-flight', async () => {
    const note = await stack.create(NOTE, { text: 'v1' }, { permissions: [{ access: 'public' }] });
    const anon = collector();
    const unsubscribe = await stack
      .asEntity(null)
      .subscribe(anon.handler, { filter: { typeId: NOTE } });

    await stack.update(note.id, { text: 'v2' });
    unsubscribe();
    await settle();

    expect(anon.seen).toEqual([]);
  });
});

// -------------------------------------------------------
// Soft-deleted records reach the feed as tombstones
// -------------------------------------------------------

describe('the feed carries no more of a soft-deleted record than get() does', () => {
  const publicRead = [{ access: 'public' as const }];

  test('a soft-delete frame carries a tombstone, not the body', async () => {
    const note = await stack.create(NOTE, { text: 'secret' }, { permissions: publicRead });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { includeRecords: true });

    await stack.delete(note.id);
    await settle();

    const frame = reader.seen.find((c) => c.recordId === note.id);
    expect(frame?.kind).toBe('deleted');
    expect(frame?.record).toBeDefined();
    expect(frame!.record!.content).toEqual({});
    expect(frame!.record!.deletedAt).toBeInstanceOf(Date);
  });

  test('an ordinary change still carries its body', async () => {
    const note = await stack.create(NOTE, { text: 'before' }, { permissions: publicRead });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { includeRecords: true });

    await stack.update(note.id, { text: 'after' });
    await settle();

    expect(reader.seen.at(-1)!.record!.content).toEqual({ text: 'after' });
  });

  // An unlist frame announces a record that stays fully readable — the
  // projection keys on deletedAt, so the two transitions can't be confused.
  test('an unlist frame is unaffected', async () => {
    const note = await stack.create(NOTE, { text: 'still here' }, { permissions: publicRead });
    const reader = collector();
    await stack.asEntity(READER).subscribe(reader.handler, { includeRecords: true });

    await stack.setUnlisted(note.id, true);
    await settle();

    const frame = reader.seen.find((c) => c.op === 'unlist');
    expect(frame?.record?.content).toEqual({ text: 'still here' });
  });

  test('an unscoped subscriber is untouched — Stack is the trusted layer', async () => {
    const note = await stack.create(NOTE, { text: 'secret' }, { permissions: publicRead });
    const seen = collector();
    await stack.subscribe(seen.handler, { includeRecords: true });

    await stack.delete(note.id);
    await settle();

    expect(seen.seen.at(-1)!.record!.content).toEqual({ text: 'secret' });
  });
});
