import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import {
  DelegationRefusedError,
  StackBadRequestError,
  StackConflictError,
  StackPermissionError,
  StackValidationError,
} from '../src/errors.js';
import { IncapableMemoryAdapter, MemoryAdapter } from '../src/testing.js';
import type {
  DelegationCheck,
  DelegationVerifier,
  RecordVerb,
  VerifiedDelegation,
} from '../src/types/index.js';

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
const fakeVerifier: DelegationVerifier = async (chain, { isRevoked }) => {
  const delegation = registry.get(keyOf(chain));
  if (!delegation) throw new Error('not a chain this test issued');
  for (const link of delegation.links) {
    if (await isRevoked(link.cid)) throw new Error(`${link.cid} is revoked`);
  }
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
  links = [{ cid: `zdpu${subjectId}`, issuerId: subjectId }],
): VerifiedDelegation => ({
  subjectId,
  principalId,
  expiresAt: null,
  allows: (verb, baseId) => allowed.some(([v, b]) => v === verb && b === baseId),
  links,
});

const everything = (subjectId: string): VerifiedDelegation => ({
  ...delegation(subjectId, []),
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
// nothing, so the snapshot checks the stack's Types itself on each use.
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

  // Every chain check is verifyDelegationChain()'s, so each failure is one
  // refusal from one place, a server's missing verifier included.
  test('a stack opened without a verifier refuses every delegated operation', async () => {
    const plain = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
    const view = plain.asActor({
      subjectId: MEMBER,
      principalId: APP,
      delegationChain: chainFor(delegation(MEMBER, [])),
    });
    await expect(view.query({})).rejects.toThrow(DelegationRefusedError);
    await expect(plain.verifyDelegationChain([Uint8Array.of(1)], APP)).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  test('an undelegated actor presenting a chain is refused', async () => {
    const view = stack.asActor({
      subjectId: MEMBER,
      principalId: MEMBER,
      delegationChain: chainFor(delegation(MEMBER, [], MEMBER)),
    });
    await expect(view.query({})).rejects.toThrow(DelegationRefusedError);
  });

  test('verifyDelegationChain() refuses a key delegating to itself', async () => {
    await expect(stack.verifyDelegationChain(chainFor(delegation(APP, [])), APP)).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  // Revocation is the stack's own: a verifier is handed core's check, so a
  // _revocation applies whichever verifier the stack was opened with.
  test('the verifier is handed the stack’s own revocation check', async () => {
    const seen: [boolean, boolean][] = [];
    const checking = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }), {
      verifyDelegation: async (_chain, { isRevoked, timeBounds }) => {
        seen.push([await isRevoked('zdpuRevoked'), timeBounds]);
        return delegation(MEMBER, []);
      },
    });
    await checking.create('_revocation@1', { cid: 'zdpuRevoked' });
    await checking.verifyDelegationChain([Uint8Array.of(1)], APP);
    expect(seen).toEqual([[true, true]]);
  });

  test('a refused delegation ends a subscription at its next delivery', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const verified = everything(OWNER);
    await stack
      .asActor({ subjectId: OWNER, principalId: APP, delegationChain: chainFor(verified) })
      .subscribe((change) => void seen.push(change.typeId), {
        onError: (err) => void errors.push(err),
      });
    await stack.create(COMMENT, { text: 'before' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stack.revokeDelegation(chainFor(verified));
    await stack.create(COMMENT, { text: 'after' });
    await stack.create(COMMENT, { text: 'later' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([COMMENT]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DelegationRefusedError);
  });
});

// Whoever grants authority can withdraw it: the owner, or an identity that
// issued the delegation or one upstream of it, each acting as itself. The
// rule is checked as the revocation is written, so every one stored counts.
describe('revokeDelegation() — refusing a delegation', () => {
  const REVOCATION = '_revocation@1';
  const ROOT = 'zdpuRoot';
  const LEAF = 'zdpuLeaf';
  const OTHER = 'did:key:z6MkOther';
  const twoLinks = () =>
    chainFor(
      delegation(MEMBER, [], 'did:key:z6MkLeaf', [
        { cid: ROOT, issuerId: MEMBER },
        { cid: LEAF, issuerId: APP },
      ]),
    );

  test('the owner revokes the delegation a chain ends at, and only that one', async () => {
    expect(await stack.isDelegationRevoked(LEAF)).toBe(false);
    const record = await stack.revokeDelegation(twoLinks());
    expect(record.content).toEqual({ cid: LEAF });
    expect(await stack.isDelegationRevoked(LEAF)).toBe(true);
    expect(await stack.isDelegationRevoked(ROOT)).toBe(false);
  });

  test('every issuer in the chain may revoke it, acting as itself', async () => {
    for (const issuer of [MEMBER, APP]) {
      const record = await stack.asEntity(issuer).revokeDelegation(twoLinks());
      expect(record.createdBy).toEqual({ subjectId: issuer });
    }
    expect(await stack.asEntity(OWNER).revokeDelegation(twoLinks())).toBeDefined();
  });

  test('no one else may, nor anyone acting for an issuer', async () => {
    await expect(stack.asEntity(OTHER).revokeDelegation(twoLinks())).rejects.toThrow(
      StackPermissionError,
    );
    const delegated = stack.asActor({ subjectId: MEMBER, principalId: OTHER });
    await expect(delegated.revokeDelegation(twoLinks())).rejects.toThrow(StackPermissionError);
    expect(await stack.isDelegationRevoked(LEAF)).toBe(false);
  });

  // A revoker never names a chain it could not have signed, but revoking a
  // delegation before it starts or after it ends is still withdrawing it.
  test('the chain must validate, but for its time bounds and revocation', async () => {
    const seen: DelegationCheck[] = [];
    const checking = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }), {
      verifyDelegation: async (chain, check) => {
        seen.push(check);
        return fakeVerifier(chain, check);
      },
    });
    await expect(checking.revokeDelegation([Uint8Array.of(0xff)])).rejects.toThrow(
      StackBadRequestError,
    );
    await checking.create(REVOCATION, { cid: LEAF });
    await checking.revokeDelegation(twoLinks());
    expect(seen.map((c) => c.timeBounds)).toEqual([false, false]);
    expect(await seen[1]!.isRevoked(LEAF)).toBe(false);
    const plain = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
    await expect(plain.revokeDelegation(twoLinks())).rejects.toThrow(StackBadRequestError);
  });

  test('only the owner may write or lift one through the ordinary verbs', async () => {
    const record = await stack.asEntity(MEMBER).revokeDelegation(twoLinks());
    await expect(stack.asEntity(MEMBER).delete(record.id)).rejects.toThrow();
    await expect(stack.asEntity(MEMBER).create(REVOCATION, { cid: ROOT })).rejects.toThrow(
      StackPermissionError,
    );
    await expect(
      stack.grantType('_revocation', {
        actions: ['create', 'read-any'],
        grantee: { kind: 'entity', entityId: MEMBER },
      }),
    ).rejects.toThrow(StackValidationError);
    await stack.delete(record.id);
    expect(await stack.isDelegationRevoked(LEAF)).toBe(false);
    await stack.undelete(record.id);
    expect(await stack.isDelegationRevoked(LEAF)).toBe(true);
  });

  test('an unlisted revocation still refuses', async () => {
    const record = await stack.create(REVOCATION, { cid: LEAF });
    await stack.setUnlisted(record.id, true);
    expect(await stack.isDelegationRevoked(LEAF)).toBe(true);
  });

  test('the same answer on an adapter that cannot filter by content', async () => {
    const plain = await Stack.open(await IncapableMemoryAdapter.open({ ownerEntityId: OWNER }));
    await plain.create(REVOCATION, { cid: 'zdpuFirst' });
    await plain.create(REVOCATION, { cid: LEAF });
    expect(await plain.isDelegationRevoked(LEAF)).toBe(true);
    expect(await plain.isDelegationRevoked('zdpuAbsent')).toBe(false);
  });

  test('its cid is required and never moves', async () => {
    await expect(stack.create(REVOCATION, {})).rejects.toThrow(StackValidationError);
    const record = await stack.create(REVOCATION, { cid: LEAF });
    await expect(stack.patchContent(record.id, { cid: 'zdpuOther' })).rejects.toThrow(
      StackConflictError,
    );
  });
});
