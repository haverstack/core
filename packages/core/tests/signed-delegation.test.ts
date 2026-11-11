import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import {
  DelegationRefusedError,
  ScopeUnavailableError,
  StackBadRequestError,
  StackConflictError,
  StackPermissionError,
  StackValidationError,
} from '../src/errors.js';
import { IncapableMemoryAdapter, MemoryAdapter } from '../src/testing.js';
import type { DelegationVerifier, RecordVerb, VerifiedDelegation } from '../src/types/index.js';

const OWNER = 'did:key:z6MkOwner';
const MEMBER = 'did:key:z6MkMember';
const APP = 'did:key:z6MkApp';
const NOTE = 'com.example.test/note@1';
const COMMENT = 'com.example.test/comment@1';
const fam = (typeId: string): string => typeId.split('@')[0]!;

/**
 * Core verifies no signatures, so these tests stand a registry in for the
 * verifier: each delegation gets an opaque one-link chain, and verifying
 * that chain answers with the delegation it stands for.
 */
const registry = new Map<string, VerifiedDelegation>();
const keyOf = (chain: readonly Uint8Array[]) => chain.map((link) => link.join('.')).join('|');
const fakeVerifier: DelegationVerifier = async (chain) => {
  const delegation = registry.get(keyOf(chain));
  if (!delegation) throw new Error('not a chain this test issued');
  return delegation;
};
const chainFor = (delegation: VerifiedDelegation): Uint8Array[] => {
  const chain = [Uint8Array.of(registry.size >> 8, registry.size & 0xff, 1)];
  registry.set(keyOf(chain), delegation);
  return chain;
};

/** A delegation allowing exactly the listed (verb, family) pairs. */
const delegation = (
  subjectId: string,
  allowed: [RecordVerb, string][],
  principalId = APP,
): VerifiedDelegation => ({
  subjectId,
  principalId,
  expiresAt: null,
  allows: (verb, baseId) => allowed.some(([v, b]) => v === verb && b === baseId),
});

const everything = (subjectId: string): VerifiedDelegation => ({
  subjectId,
  principalId: APP,
  expiresAt: null,
  allows: () => true,
});

let stack: Stack;

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }), {
    verifyDelegation: fakeVerifier,
  });
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
    const view = stack.asActor({
      subjectId: MEMBER,
      principalId: APP,
      delegationChain: chainFor(delegation(MEMBER, [['create', fam(COMMENT)]])),
    });
    const record = await view.create(COMMENT, { text: 'hi' });
    expect(record.createdBy).toEqual({ subjectId: MEMBER, principalId: APP });
  });

  test('without the delegation the same principal is refused', async () => {
    const view = stack.asActor({ subjectId: MEMBER, principalId: APP });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('it admits only the verbs and families it allows', async () => {
    await stack.create(COMMENT, { text: 'seen' });
    const view = stack.asActor({
      subjectId: MEMBER,
      principalId: APP,
      delegationChain: chainFor(delegation(MEMBER, [['read', fam(COMMENT)]])),
    });
    expect((await view.query({ filter: { typeId: COMMENT } })).records).toHaveLength(1);
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  test('it never reaches past what the subject itself reaches', async () => {
    await stack.create(NOTE, { text: 'private' });
    const view = stack.asActor({
      subjectId: MEMBER,
      principalId: APP,
      delegationChain: chainFor(everything(MEMBER)),
    });
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
    const view = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(delegation(OWNER, [['read', fam(COMMENT)]])),
    });
    expect((await view.query({ filter: { typeId: NOTE } })).records).toHaveLength(1);
    expect((await view.query({ filter: { typeId: COMMENT } })).records).toHaveLength(1);
  });

  test('it never reaches an ungrantable family, even from the owner', async () => {
    await stack.grantType(fam(NOTE), {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
    const view = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(everything(OWNER)),
    });
    expect((await view.query({ filter: { typeId: '_grant@1' } })).records).toHaveLength(0);
    expect((await view.query({ filter: { typeId: '_config@1' } })).records).toHaveLength(0);
  });

  // A delegation conveys what a grant naming the principal would, and a
  // grant's update or delete counts only beside read.
  test('update or delete counts only where read is delegated too', async () => {
    const note = await stack.create(COMMENT, { text: 'mine' });
    const updateOnly = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(delegation(OWNER, [['update', fam(COMMENT)]])),
    });
    await expect(updateOnly.patchContent(note.id, { text: 'changed' })).rejects.toThrow();
    const withRead = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(
        delegation(OWNER, [
          ['update', fam(COMMENT)],
          ['read', fam(COMMENT)],
        ]),
      ),
    });
    await expect(withRead.patchContent(note.id, { text: 'changed' })).resolves.toBeDefined();
  });

  // Withdrawing authority is authority: an app must not lift a revocation,
  // its own or a sibling's, however wide its delegation.
  test('it never reaches _revocation, which governs delegations themselves', async () => {
    const revocation = await stack.create('_revocation@1', { cid: 'zdpuSibling' });
    const view = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(everything(OWNER)),
    });
    expect((await view.query({ filter: { typeId: '_revocation@1' } })).records).toHaveLength(0);
    await expect(view.delete(revocation.id)).rejects.toThrow();
    await expect(view.create('_revocation@1', { cid: 'zdpuOther' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  // The rule is about the principal's side, not about delegations: an app
  // the owner named directly is held to it too while acting for someone.
  test('a grant naming the app reaches no _revocation while it acts for someone', async () => {
    await stack.grantType('_revocation', {
      actions: ['create', 'read-any', 'delete-any'],
      grantee: { kind: 'entity', entityId: APP },
    });
    await stack.grantType('_revocation', {
      actions: ['create', 'read-any', 'delete-any'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
    const revocation = await stack.create('_revocation@1', { cid: 'zdpuSibling' });
    const view = stack.asActor({ subjectId: MEMBER, principalId: APP });
    expect((await view.query({ filter: { typeId: '_revocation@1' } })).records).toHaveLength(0);
    await expect(view.delete(revocation.id)).rejects.toThrow();
    // Acting as itself, the same grant reaches it.
    await expect(
      stack.asEntity(APP).create('_revocation@1', { cid: 'zdpuOwn' }),
    ).resolves.toBeDefined();
  });

  test('it carries none of the verbs delegation never carries', async () => {
    const view = stack.asActor({
      subjectId: OWNER,
      principalId: APP,
      delegationChain: chainFor(everything(OWNER)),
    });
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

// A subscription holds its authority for its life. Defining a Type emits
// nothing, so the first Record of a new family is what tells it to look again.
test('a delegated subscription reaches a family defined after it began', async () => {
  const seen: string[] = [];
  await stack
    .asActor({ subjectId: OWNER, principalId: APP, delegationChain: chainFor(everything(OWNER)) })
    .subscribe((change) => void seen.push(change.typeId));
  // Delivering one Record first is what makes it read the families at all.
  await stack.create(COMMENT, { text: 'before' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const LATER = 'com.example.test/later@1';
  await stack.defineType({ id: LATER, name: 'Later', schema: { text: { kind: 'text' } } });
  await stack.create(LATER, { text: 'new family' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen).toEqual([COMMENT, LATER]);
});

describe('Signed delegations — the session carries the chain', () => {
  // A view is had at once; the chain is validated when an operation reaches
  // Records, and every operation does so again.
  test('a chain from another subject, or to another principal, refuses every operation', async () => {
    for (const verified of [
      delegation(OWNER, [['read', fam(COMMENT)]]),
      delegation(MEMBER, [['read', fam(COMMENT)]], 'did:key:z6MkOther'),
    ]) {
      const view = stack.asActor({
        subjectId: MEMBER,
        principalId: APP,
        delegationChain: chainFor(verified),
      });
      await expect(view.query({ filter: { typeId: COMMENT } })).rejects.toThrow(
        DelegationRefusedError,
      );
    }
  });

  test('a chain that does not validate refuses every operation', async () => {
    const view = stack.asActor({
      subjectId: MEMBER,
      principalId: APP,
      delegationChain: [Uint8Array.of(0xff)],
    });
    await expect(view.create(COMMENT, { text: 'hi' })).rejects.toThrow(DelegationRefusedError);
  });

  test('a stack opened without a verifier scopes no delegated session', async () => {
    const plain = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
    expect(() =>
      plain.asActor({
        subjectId: MEMBER,
        principalId: APP,
        delegationChain: chainFor(delegation(MEMBER, [])),
      }),
    ).toThrow(ScopeUnavailableError);
    await expect(plain.verifyDelegationChain([Uint8Array.of(1)], APP)).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  test('an undelegated actor carries no chain', () => {
    expect(() =>
      stack.asActor({
        subjectId: MEMBER,
        principalId: MEMBER,
        delegationChain: chainFor(delegation(MEMBER, [], MEMBER)),
      }),
    ).toThrow(StackBadRequestError);
  });

  test('verifyDelegationChain() refuses a key delegating to itself', async () => {
    await expect(stack.verifyDelegationChain(chainFor(delegation(APP, [])), APP)).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  // Revocation is the stack's own: a verifier is handed core's check, so a
  // _revocation applies whichever verifier the stack was opened with.
  test('the verifier is handed the stack’s own revocation check', async () => {
    const seen: boolean[] = [];
    const checking = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }), {
      verifyDelegation: async (_chain, { isRevoked }) => {
        seen.push(await isRevoked('zdpuRevoked', [MEMBER]));
        return delegation(MEMBER, []);
      },
    });
    await checking.create('_revocation@1', { cid: 'zdpuRevoked' });
    await checking.verifyDelegationChain([Uint8Array.of(1)], APP);
    expect(seen).toEqual([true]);
  });
});

// Whoever grants authority can withdraw it: a revocation counts when the
// owner wrote it, or an identity that issued the delegation or one upstream
// of it. Like a grant, it is recoverable.
describe('_revocation — refusing a delegation', () => {
  const CID = 'zdpuAxubXwgEpicLJWrbT37gWJJ4wBpEbbzfQAY8ADo2qy1jJ';
  const REVOCATION = '_revocation@1';
  const ISSUERS = [MEMBER, APP];

  const letMemberRevoke = () =>
    stack.grantType('_revocation', {
      actions: ['create', 'read-own', 'delete-own'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });

  test("the owner's revocation refuses the delegation it names, and only that one", async () => {
    expect(await stack.isDelegationRevoked(CID, ISSUERS)).toBe(false);
    await stack.create(REVOCATION, { cid: CID });
    expect(await stack.isDelegationRevoked(CID, ISSUERS)).toBe(true);
    expect(await stack.isDelegationRevoked(CID, [])).toBe(true);
    expect(await stack.isDelegationRevoked('zdpuOther', ISSUERS)).toBe(false);
  });

  test('an issuer upstream in the chain revokes it too', async () => {
    await letMemberRevoke();
    await stack.asEntity(MEMBER).create(REVOCATION, { cid: CID });
    expect(await stack.isDelegationRevoked(CID, ISSUERS)).toBe(true);
  });

  test('a revocation by anyone else confers nothing', async () => {
    await letMemberRevoke();
    await stack.asEntity(MEMBER).create(REVOCATION, { cid: CID });
    expect(await stack.isDelegationRevoked(CID, [APP])).toBe(false);
    expect(await stack.isDelegationRevoked(CID, [])).toBe(false);
  });

  test('deleting it lifts the refusal, and undeleting restores it', async () => {
    await letMemberRevoke();
    const view = stack.asEntity(MEMBER);
    const record = await view.create(REVOCATION, { cid: CID });
    await view.delete(record.id);
    expect(await stack.isDelegationRevoked(CID, ISSUERS)).toBe(false);
    await stack.undelete(record.id);
    expect(await stack.isDelegationRevoked(CID, ISSUERS)).toBe(true);
  });

  test('an unlisted revocation still refuses', async () => {
    const record = await stack.create(REVOCATION, { cid: CID });
    await stack.setUnlisted(record.id, true);
    expect(await stack.isDelegationRevoked(CID, [])).toBe(true);
  });

  test('the same answer on an adapter that cannot filter by content', async () => {
    const plain = await Stack.open(await IncapableMemoryAdapter.open({ ownerEntityId: OWNER }));
    await plain.create(REVOCATION, { cid: 'zdpuFirst' });
    await plain.create(REVOCATION, { cid: CID });
    expect(await plain.isDelegationRevoked(CID, [])).toBe(true);
    expect(await plain.isDelegationRevoked('zdpuAbsent', [])).toBe(false);
  });

  test('its cid is required and never moves', async () => {
    await expect(stack.create(REVOCATION, {})).rejects.toThrow(StackValidationError);
    const record = await stack.create(REVOCATION, { cid: CID });
    await expect(stack.patchContent(record.id, { cid: 'zdpuOther' })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('writing one takes a grant, like any family', async () => {
    await expect(stack.asEntity(MEMBER).create(REVOCATION, { cid: CID })).rejects.toThrow(
      StackPermissionError,
    );
  });
});
