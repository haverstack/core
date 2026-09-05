import { describe, test, expect, beforeEach } from 'vitest';
import { createOptionsFromWireRecord, isOwnerActingAlone } from '../src/wire-entry.js';
import { Stack, StackQueryError, StackValidationError } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import type { StackRecord, TokenSession } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:owner';
const MEMBER = 'did:key:member';
const APP = 'did:key:app';

const session = (principalId: string, subjectId = principalId): TokenSession => ({
  principalId,
  subjectId,
});

const owner = session(OWNER);
const grantee = session(MEMBER);
/** The owner authenticated, acting for someone else. */
const ownerForMember = session(OWNER, MEMBER);
/** An app authenticated, acting for the owner. */
const appForOwner = session(APP, OWNER);

/** A whole record, as a client serializes one onto the wire for a create. */
const wireBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '0000000abcde',
  typeId: NOTE,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-02T00:00:00.000Z',
  content: { text: 'hello' },
  version: 1,
  ...overrides,
});

const parse = (body: unknown, as: TokenSession = owner) =>
  createOptionsFromWireRecord(body, as, OWNER);

// -------------------------------------------------------
// The identity fields
// -------------------------------------------------------

describe('createOptionsFromWireRecord — stamped fields', () => {
  test('a body naming its own identity fields yields options carrying none of them', () => {
    const { options } = parse(
      wireBody({
        entityId: MEMBER,
        principalId: APP,
        updatedBy: MEMBER,
        updatedVia: APP,
        version: 99,
      }),
    );
    for (const key of ['entityId', 'principalId', 'updatedBy', 'updatedVia', 'version']) {
      expect(key in options).toBe(false);
    }
  });

  test('a body naming them is accepted, not refused — they are ignored on input', () => {
    expect(() => parse(wireBody({ entityId: MEMBER, principalId: APP }))).not.toThrow();
  });
});

// -------------------------------------------------------
// The clock fields
// -------------------------------------------------------

describe('createOptionsFromWireRecord — createdAt/updatedAt', () => {
  test('the owner acting alone may backdate', () => {
    const { options } = parse(wireBody(), owner);
    expect(options.createdAt).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(options.updatedAt).toEqual(new Date('2020-01-02T00:00:00.000Z'));
  });

  // Asserted on the key, not the value: an edit reintroducing either as
  // undefined would be a drop by value and still fail this.
  test.each([
    ['a grantee', grantee],
    ['the owner acting for someone else', ownerForMember],
    ['an app acting for the owner', appForOwner],
  ])('%s has both dropped', (_label, as) => {
    const { options } = parse(wireBody(), as);
    expect('createdAt' in options).toBe(false);
    expect('updatedAt' in options).toBe(false);
  });

  test('a malformed date is refused for the requester who could have used it', () => {
    expect(() => parse(wireBody({ createdAt: 'yesterday' }), owner)).toThrow(StackValidationError);
    expect(() => parse(wireBody({ updatedAt: {} }), owner)).toThrow(StackValidationError);
  });

  test('the refusal names the field', () => {
    try {
      parse(wireBody({ createdAt: 'yesterday' }), owner);
      expect.unreachable();
    } catch (err) {
      expect((err as StackValidationError).errors[0].path).toBe('createdAt');
    }
  });

  // Dropped before anything reads it, so it cannot fail their create.
  test('a malformed date costs a requester who cannot backdate nothing', () => {
    const { options } = parse(wireBody({ createdAt: 'yesterday' }), grantee);
    expect('createdAt' in options).toBe(false);
  });
});

// -------------------------------------------------------
// The forwarded fields
// -------------------------------------------------------

describe('createOptionsFromWireRecord — unlistedAt', () => {
  test('it becomes unlisted: true for every requester, so the refusal stays ScopedStack’s', () => {
    for (const as of [owner, grantee, ownerForMember, appForOwner]) {
      expect(parse(wireBody({ unlistedAt: '2020-01-01T00:00:00.000Z' }), as).options.unlisted).toBe(
        true,
      );
    }
  });

  test('an ordinary body sets no unlisted flag at all', () => {
    expect('unlisted' in parse(wireBody()).options).toBe(false);
  });
});

describe('createOptionsFromWireRecord — forwarded record fields', () => {
  test('id, parentId, appId, permissions and associations pass through', () => {
    const permissions = [{ access: 'public' as const }];
    const associations = [{ kind: 'tag' as const, label: 'starred' }];
    const { typeId, content, options } = parse(
      wireBody({
        parentId: '0000000parnt',
        appId: 'com.example.editor',
        permissions,
        associations,
      }),
    );
    expect(typeId).toBe(NOTE);
    expect(content).toEqual({ text: 'hello' });
    expect(options.id).toBe('0000000abcde');
    expect(options.parentId).toBe('0000000parnt');
    expect(options.appId).toBe('com.example.editor');
    expect(options.permissions).toEqual(permissions);
    expect(options.associations).toEqual(associations);
  });

  test('an absent optional field sets no key', () => {
    const { options } = parse({ typeId: NOTE, content: {} });
    for (const key of ['id', 'parentId', 'appId', 'permissions', 'associations']) {
      expect(key in options).toBe(false);
    }
  });
});

// -------------------------------------------------------
// Malformed input
// -------------------------------------------------------

describe('createOptionsFromWireRecord — refusals', () => {
  test.each([
    ['a non-object body', 'not a record'],
    ['an array body', []],
    ['a body with no typeId', { content: {} }],
    ['a body whose typeId is not a string', { typeId: 7, content: {} }],
    ['a body with no content', { typeId: NOTE }],
    ['a body whose content is an array', { typeId: NOTE, content: [] }],
  ])('%s is not a create request', (_label, body) => {
    expect(() => parse(body)).toThrow(StackQueryError);
  });

  test('a null is not a spelling of absent', () => {
    expect(() => parse(wireBody({ parentId: null }))).toThrow(StackValidationError);
    expect(() => parse(wireBody({ unlistedAt: null }))).toThrow(StackValidationError);
  });

  test('a body carrying deletedAt creates a live record, the only kind a create makes', () => {
    const { options } = parse(wireBody({ deletedAt: '2020-06-01T00:00:00.000Z' }));
    expect('deletedAt' in options).toBe(false);
  });

  // Dropping any of these writes a different record than the one asked for.
  test.each([
    ['id', { id: 12345 }],
    ['parentId', { parentId: 12345 }],
    ['appId', { appId: [] }],
    ['unlistedAt', { unlistedAt: true }],
    ['permissions', { permissions: 'public' }],
    ['associations', { associations: {} }],
  ])('a wrongly typed %s is refused rather than dropped', (path, override) => {
    try {
      parse(wireBody(override));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StackValidationError);
      expect((err as StackValidationError).errors[0].path).toBe(path);
    }
  });
});

// -------------------------------------------------------
// isOwnerActingAlone
// -------------------------------------------------------

describe('isOwnerActingAlone', () => {
  test('the owner authenticated as itself qualifies, and no other pairing does', () => {
    expect(isOwnerActingAlone(owner, OWNER)).toBe(true);
    expect(isOwnerActingAlone(grantee, OWNER)).toBe(false);
    expect(isOwnerActingAlone(ownerForMember, OWNER)).toBe(false);
    expect(isOwnerActingAlone(appForOwner, OWNER)).toBe(false);
  });

  test('an anonymous request never qualifies', () => {
    expect(isOwnerActingAlone({ principalId: null, subjectId: null }, OWNER)).toBe(false);
  });
});

// -------------------------------------------------------
// Against a real ScopedStack
// -------------------------------------------------------

describe('createOptionsFromWireRecord — through ScopedStack.create()', () => {
  let adapter: MemoryAdapter;
  let stack: Stack;

  beforeEach(async () => {
    adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
    stack = await Stack.create(adapter);
    await stack.defineType(NOTE, 'Note', { text: { kind: 'text' } });
    await stack.grant(MEMBER, [{ actions: ['create'], typeId: NOTE }]);
  });

  const create = async (body: Record<string, unknown>, as: TokenSession): Promise<StackRecord> => {
    const { typeId, content, options } = createOptionsFromWireRecord(body, as, OWNER);
    return stack.forSession(as).create(typeId, content, options);
  };

  // The failure the helper exists to prevent: a client sends both clock
  // fields on every create, and forwarding a grantee's unfiltered turns an
  // ordinary create into a refusal.
  test('a grantee create carrying both clock fields succeeds and is stamped now', async () => {
    const before = Date.now();
    const record = await create(wireBody({ id: undefined }), grantee);
    expect(record.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(record.entityId).toBe(MEMBER);
  });

  test('an owner create carrying both keeps the dates it sent', async () => {
    const record = await create(wireBody({ id: undefined }), owner);
    expect(record.createdAt).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(record.updatedAt).toEqual(new Date('2020-01-02T00:00:00.000Z'));
  });

  test('a body claiming another entity is stamped with the requester instead', async () => {
    const record = await create(
      wireBody({ id: undefined, entityId: OWNER, principalId: APP }),
      grantee,
    );
    expect(record.entityId).toBe(MEMBER);
    expect(record.principalId).toBeUndefined();
  });
});
