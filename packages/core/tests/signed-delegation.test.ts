import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { StackBadRequestError, StackPermissionError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { DelegatedVerb, SignedDelegation } from '../src/types/index.js';

const OWNER = 'did:key:z6MkOwner';
const MEMBER = 'did:key:z6MkMember';
const APP = 'did:key:z6MkApp';
const NOTE = 'com.example.test/note@1';
const COMMENT = 'com.example.test/comment@1';
const fam = (typeId: string): string => typeId.split('@')[0]!;

/** A delegation allowing exactly the listed (verb, family) pairs. */
const delegation = (
  subjectId: string,
  allowed: [DelegatedVerb, string][],
  principalId = APP,
): SignedDelegation => ({
  subjectId,
  principalId,
  allows: (verb, baseId) => allowed.some(([v, b]) => v === verb && b === baseId),
});

const EVERYTHING: SignedDelegation['allows'] = () => true;

let stack: Stack;

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  await stack.defineType({ id: COMMENT, name: 'Comment', schema: { text: { kind: 'text' } } });
  await stack.grantType(fam(COMMENT), {
    actions: ['create', 'read-any'],
    grantee: { kind: 'entity', entityId: MEMBER },
  });
});

// The subject's signed scope stands where a grant naming the principal
// would: an app the owner never named reaches what its subject delegated,
// and never more than the subject itself reaches.
describe('Signed delegations — the principal side', () => {
  test('a delegation admits a principal no grant names', async () => {
    const view = stack.asActor(
      { subjectId: MEMBER, principalId: APP },
      { delegation: delegation(MEMBER, [['create', fam(COMMENT)]]) },
    );
    const record = await view.create(COMMENT, { text: 'hi' });
    expect(record.createdBy).toEqual({ subjectId: MEMBER, principalId: APP });
  });

  test('without the delegation the same principal is refused', async () => {
    const view = stack.asActor({ subjectId: MEMBER, principalId: APP });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('it admits only the verbs and families it allows', async () => {
    await stack.create(COMMENT, { text: 'seen' });
    const view = stack.asActor(
      { subjectId: MEMBER, principalId: APP },
      { delegation: delegation(MEMBER, [['read', fam(COMMENT)]]) },
    );
    expect((await view.query({ filter: { typeId: COMMENT } })).records).toHaveLength(1);
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('it never reaches past what the subject itself reaches', async () => {
    await stack.create(NOTE, { text: 'private' });
    const view = stack.asActor(
      { subjectId: MEMBER, principalId: APP },
      { delegation: { subjectId: MEMBER, principalId: APP, allows: EVERYTHING } },
    );
    expect((await view.query({ filter: { typeId: NOTE } })).records).toHaveLength(0);
    await expect(view.create(NOTE, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('it adds to the grants naming the principal rather than replacing them', async () => {
    await stack.create(NOTE, { text: 'owner note' });
    await stack.create(COMMENT, { text: 'owner comment' });
    await stack.grantType(fam(NOTE), {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: APP },
    });
    const view = stack.asActor(
      { subjectId: OWNER, principalId: APP },
      { delegation: delegation(OWNER, [['read', fam(COMMENT)]]) },
    );
    expect((await view.query({ filter: { typeId: NOTE } })).records).toHaveLength(1);
    expect((await view.query({ filter: { typeId: COMMENT } })).records).toHaveLength(1);
  });

  test('it never reaches an ungrantable family, even from the owner', async () => {
    await stack.grantType(fam(NOTE), {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
    const view = stack.asActor(
      { subjectId: OWNER, principalId: APP },
      { delegation: { subjectId: OWNER, principalId: APP, allows: EVERYTHING } },
    );
    expect((await view.query({ filter: { typeId: '_grant@1' } })).records).toHaveLength(0);
    expect((await view.query({ filter: { typeId: '_config@1' } })).records).toHaveLength(0);
  });

  test('it carries none of the verbs delegation never carries', async () => {
    const view = stack.asActor(
      { subjectId: OWNER, principalId: APP },
      { delegation: { subjectId: OWNER, principalId: APP, allows: EVERYTHING } },
    );
    await expect(
      view.defineType({ id: 'com.example.test/other@1', name: 'Other', schema: {} }),
    ).rejects.toThrow(StackPermissionError);
    await expect(
      view.create(
        COMMENT,
        { text: 'shared' },
        { permissions: [{ kind: 'anyone', label: 'read' }] },
      ),
    ).rejects.toThrow(StackPermissionError);
  });
});

describe('Signed delegations — naming the pair', () => {
  test('a delegation must name the actor’s subject and principal', () => {
    expect(() =>
      stack.asActor(
        { subjectId: MEMBER, principalId: APP },
        { delegation: delegation(OWNER, [['read', fam(COMMENT)]]) },
      ),
    ).toThrow(StackBadRequestError);
    expect(() =>
      stack.asActor(
        { subjectId: MEMBER, principalId: APP },
        { delegation: delegation(MEMBER, [['read', fam(COMMENT)]], 'did:key:z6MkOther') },
      ),
    ).toThrow(StackBadRequestError);
  });

  test('an undelegated actor takes no delegation', () => {
    expect(() =>
      stack.asActor(
        { subjectId: MEMBER },
        { delegation: delegation(MEMBER, [['read', fam(COMMENT)]], MEMBER) },
      ),
    ).toThrow(StackBadRequestError);
  });
});
