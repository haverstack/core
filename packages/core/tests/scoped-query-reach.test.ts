import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import type { ScopedStack } from '../src/scoped-stack/scoped-stack.js';
import { generateId } from '../src/id.js';
import { MemoryAdapter } from '../src/testing.js';
import { ScopeUnavailableError } from '../src/errors.js';
import type {
  Actor,
  AuthorityAssociation,
  QueryResult,
  Reach,
  StackQuery,
  StackRecord,
} from '../src/types/index.js';

const OWNER = 'did:key:owner';
const ALICE = 'did:key:alice';
const BOB = 'did:key:bob';
const CAROL = 'did:key:carol';
const APP = 'did:key:app';

const NOTE = 'com.example.test/note@1';
const NOTE_2 = 'com.example.test/note@2';
const COMMENT = 'com.example.test/comment@1';
const SECRET = 'com.example.test/secret@1';

type PermissionElement = Extract<AuthorityAssociation, { kind: 'permission' }>;

const ANYONE: AuthorityAssociation = { kind: 'anyone', label: 'read' };
const readFor = (entityId: string): PermissionElement => ({
  kind: 'permission',
  label: 'read',
  grantee: { kind: 'entity', entityId },
});
const readForGroup = (groupId: string, role: 'member' | 'admin'): PermissionElement => ({
  kind: 'permission',
  label: 'read',
  grantee: { kind: 'group', groupId, role },
});

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

async function defineTypes(target: Stack): Promise<void> {
  await target.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  await target.defineType({
    id: NOTE_2,
    name: 'Note',
    schema: { text: { kind: 'text' }, title: { kind: 'text' } },
  });
  await target.defineType({ id: COMMENT, name: 'Comment', schema: { text: { kind: 'text' } } });
  await target.defineType({ id: SECRET, name: 'Secret', schema: { ssn: { kind: 'text' } } });
}

beforeEach(async () => {
  adapter = await MemoryAdapter.open({ ownerEntityId: OWNER });
  stack = await Stack.open(adapter);
  await defineTypes(stack);
});

/** Every record an unscoped query lists, cursor-walked. */
async function everyRecord(query: StackQuery = {}): Promise<StackRecord[]> {
  const all: StackRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await stack.query({ ...query, cursor });
    all.push(...page.records);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return all;
}

const ids = (records: StackRecord[]): string[] => records.map((r) => r.id).sort();

describe('the reach a scoped query runs within', () => {
  // A world holding every route to a read: each grant tier, each permission
  // element, live, deleted and unlisted rosters, both sides of delegation.
  async function populate(): Promise<void> {
    const group = async (overrides: Partial<StackRecord>) =>
      (await adapter.createRecord(makeRecord({ typeId: '_group@1', ...overrides }))).id;
    const roster = (entityId: string, label: 'member' | 'admin') => ({
      kind: 'relationship' as const,
      label,
      target: { kind: 'entity' as const, entityId },
    });

    const editors = await group({ associations: [roster(ALICE, 'admin'), roster(BOB, 'member')] });
    const disbanded = await group({
      associations: [roster(CAROL, 'member')],
      deletedAt: new Date(),
    });
    const quiet = await group({ associations: [roster(CAROL, 'member')], unlistedAt: new Date() });
    // A roster-shaped record outside the `_group` family carries none.
    const lookalike = (
      await adapter.createRecord(makeRecord({ associations: [roster(BOB, 'admin')] }))
    ).id;

    await stack.grantType('com.example.test/comment', {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: editors, role: 'member' },
    });
    await stack.grantType('com.example.test/note', {
      actions: ['read-own'],
      grantee: { kind: 'authenticated' },
    });
    await stack.grantType('com.example.test/secret', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: CAROL },
    });
    await stack.grantType('com.example.test/comment', {
      actions: ['read-own'],
      grantee: { kind: 'entity', entityId: APP },
    });
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: disbanded, role: 'member' },
    });
    await stack.grantType('com.example.test/secret', {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: APP },
    });

    const author = (subjectId: string) => ({ createdBy: { subjectId } });
    const fixtures: Partial<StackRecord>[] = [
      {},
      { ...author(ALICE) },
      { typeId: NOTE_2, ...author(BOB) },
      { typeId: NOTE_2, ...author(CAROL), permissions: [readFor(ALICE)] },
      { permissions: [ANYONE] },
      { permissions: [readFor(ALICE)] },
      { permissions: [readFor(BOB), { ...readFor(BOB), label: 'write' }] },
      { permissions: [{ ...readFor(CAROL), label: 'write' }] },
      { permissions: [readForGroup(editors, 'admin')] },
      { permissions: [readForGroup(editors, 'member')] },
      { permissions: [readForGroup(disbanded, 'member')] },
      { permissions: [readForGroup(quiet, 'member')] },
      { permissions: [readForGroup(lookalike, 'member')] },
      { typeId: COMMENT },
      { typeId: COMMENT, ...author(ALICE), permissions: [ANYONE] },
      { typeId: SECRET, ...author(BOB) },
      { typeId: SECRET, permissions: [readFor(BOB)] },
      { permissions: [ANYONE], unlistedAt: new Date() },
      { permissions: [ANYONE], deletedAt: new Date() },
    ];
    for (const fixture of fixtures) await adapter.createRecord(makeRecord(fixture));
  }

  const requesters: [string, Actor | null][] = [
    ['anonymous', null],
    ['an entity on a roster as admin', { subjectId: ALICE }],
    ['an entity on a roster as member', { subjectId: BOB }],
    ['an entity on deleted and unlisted rosters', { subjectId: CAROL }],
    ['an entity nothing names', { subjectId: 'did:key:nobody' }],
    ['an app acting for an entity', { principalId: APP, subjectId: ALICE }],
    ['an app acting for the owner', { principalId: APP, subjectId: OWNER }],
    ['an app with no grants acting for an entity', { principalId: 'did:key:bare', subjectId: BOB }],
    ['the owner acting for an entity', { principalId: OWNER, subjectId: CAROL }],
    ['the owner acting alone', { subjectId: OWNER }],
  ];

  for (const [name, actor] of requesters) {
    for (const includeDeleted of [false, true]) {
      test(`query() and get() agree Record for Record: ${name}${includeDeleted ? ', deleted included' : ''}`, async () => {
        await populate();
        const view = actor ? stack.asActor(actor) : stack.asEntity(null);
        const filter = { includeDeleted };

        const readable: StackRecord[] = [];
        for (const record of await everyRecord({ filter })) {
          if (await view.get(record.id, { includeDeleted: true })) readable.push(record);
        }
        const page = await view.query({ filter, limit: 1000 });

        expect(ids(page.records)).toEqual(ids(readable));
        expect(page.cursor).toBeNull();
      });
    }
  }

  test('a hidden Record changes nothing about any page: records, fullness or cursor', async () => {
    const twin = await MemoryAdapter.open({ ownerEntityId: OWNER });
    const twinStack = await Stack.open(twin);
    await defineTypes(twinStack);

    // The same readable Records in both stacks, with hidden ones between
    // them in this one alone.
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 4; j++) await adapter.createRecord(makeRecord());
      const shared = makeRecord({ permissions: [ANYONE], content: { text: `n${i}` } });
      await adapter.createRecord(shared);
      await twin.createRecord(shared);
    }

    const pages = async (view: ScopedStack): Promise<QueryResult[]> => {
      const out: QueryResult[] = [];
      let cursor: string | undefined;
      do {
        const page = await view.query({ limit: 2, cursor, sort: { contentField: 'text' } });
        out.push(page);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return out;
    };

    const withHidden = await pages(stack.asEntity(null));
    expect(withHidden.map((p) => p.records.length)).toEqual([2, 2, 1]);
    expect(withHidden).toEqual(await pages(twinStack.asEntity(null)));
  });

  test('a cursor never comes back for a page whose remainder is hidden', async () => {
    for (let i = 0; i < 17; i++) {
      await adapter.createRecord(makeRecord({ typeId: SECRET, content: { ssn: `x${i}` } }));
    }
    const result = await stack.asEntity(null).query({
      filter: { typeId: SECRET },
      sort: { contentField: 'ssn' },
      limit: 1,
    });
    expect(result).toEqual({ records: [], cursor: null });
  });

  test('a delegated subject reads through the principal’s fence only', async () => {
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: ALICE },
    });
    await stack.grantType('com.example.test/comment', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: ALICE },
    });
    await stack.grantType('com.example.test/note', {
      actions: ['read-own'],
      grantee: { kind: 'entity', entityId: APP },
    });
    const note = await adapter.createRecord(makeRecord());
    await adapter.createRecord(makeRecord({ typeId: COMMENT }));

    const spy = vi.spyOn(adapter, 'queryReadable');
    const result = await stack.asActor({ principalId: APP, subjectId: ALICE }).query();
    const reach = spy.mock.calls[0]![1] as Reach;
    spy.mockRestore();

    expect(result.records.map((r) => r.id)).toEqual([note.id]);
    expect(reach.fence).toEqual(['com.example.test/note']);
  });

  test('the owner acting alone has a reach that constrains nothing', async () => {
    const spy = vi.spyOn(adapter, 'queryReadable');
    await adapter.createRecord(makeRecord());
    const result = await stack.asEntity(OWNER).query();
    expect(result.records).toHaveLength(1);
    expect(spy.mock.calls[0]![1]).toEqual({});
    spy.mockRestore();
  });

  test('an owner subject is fenced by the app acting for it, and by nothing else', async () => {
    await stack.grantType('com.example.test/comment', {
      actions: ['read-own'],
      grantee: { kind: 'entity', entityId: APP },
    });
    const spy = vi.spyOn(adapter, 'queryReadable');
    await stack.asActor({ principalId: APP, subjectId: OWNER }).query();
    expect(spy.mock.calls[0]![1]).toEqual({ fence: ['com.example.test/comment'] });
    spy.mockRestore();
  });
});

describe('a stack whose adapter cannot query within a reach', () => {
  test('cannot be scoped at all', async () => {
    Object.assign(adapter, { queryReadable: undefined });
    const unscopable = await Stack.open(adapter);
    expect(() => unscopable.asEntity(null)).toThrow(ScopeUnavailableError);
    expect(() => unscopable.asEntity(null)).toThrow(/does not implement queryReadable\(\)/);
    expect(() => unscopable.asEntity(OWNER)).toThrow(ScopeUnavailableError);
  });
});

describe('what a scoped get() reads', () => {
  // The record, then each authority set at most once: the grants for an
  // identified requester, the rosters for an identified subject that is not
  // the owner. See docs/spec/access-control.md § Reach.
  const cases: [string, Actor | null, number][] = [
    ['the owner acting alone', { subjectId: OWNER }, 0],
    ['anonymous', null, 0],
    ['an identified entity', { subjectId: ALICE }, 2],
    ['an app acting for an entity', { principalId: APP, subjectId: ALICE }, 2],
    ['an app acting for the owner', { principalId: APP, subjectId: OWNER }, 1],
  ];

  test.each(cases)('%s', async (_name, actor, authorityReads) => {
    const editors = await adapter.createRecord(
      makeRecord({
        typeId: '_group@1',
        associations: [
          { kind: 'relationship', label: 'member', target: { kind: 'entity', entityId: ALICE } },
        ],
      }),
    );
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: editors.id, role: 'member' },
    });
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: APP },
    });
    const record = await adapter.createRecord(
      makeRecord({ permissions: [ANYONE, readForGroup(editors.id, 'member')] }),
    );

    const view = actor ? stack.asActor(actor) : stack.asEntity(null);
    const gets = vi.spyOn(adapter, 'getRecord');
    const queries = vi.spyOn(adapter, 'queryRecords');
    expect(await view.get(record.id)).not.toBeNull();
    expect(gets).toHaveBeenCalledTimes(1);
    expect(queries).toHaveBeenCalledTimes(authorityReads);
  });
});

describe('an operation reads its authority once', () => {
  // However many gates one operation asks — the create grant, the parent,
  // every relationship target — it reads the grants and the rosters once.
  // See docs/spec/access-control.md § Reach.
  test('a create naming a parent and five relationship targets', async () => {
    await stack.grantType('com.example.test/note', {
      actions: ['create', 'read-any'],
      grantee: { kind: 'entity', entityId: ALICE },
    });
    const parent = await adapter.createRecord(makeRecord());
    const targets = [];
    for (let i = 0; i < 5; i++) targets.push(await adapter.createRecord(makeRecord()));

    const view = stack.asEntity(ALICE);
    const queries = vi.spyOn(stack, 'query');
    await view.create(
      NOTE,
      { text: 'linked' },
      {
        parentId: parent.id,
        associations: targets.map((t) => ({
          kind: 'relationship' as const,
          label: 'cites',
          target: { kind: 'record' as const, recordId: t.id },
        })),
      },
    );
    const authorityReads = queries.mock.calls.filter(
      ([q]) => q?.filter?.typeId === '_grant@1' || q?.filter?.baseId === '_group',
    );
    expect(authorityReads).toHaveLength(2);
  });
});
