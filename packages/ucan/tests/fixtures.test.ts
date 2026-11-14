/**
 * The delegation fixtures in @haverstack/conformance-fixtures are real
 * UCAN envelopes, so a server can validate them rather than trust their
 * shape. These pin that they validate, and fail, as the fixtures say.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_FIXTURE_DELEGATION,
  AUTH_FIXTURE_DELEGATION_CID,
  AUTH_FIXTURE_DID,
  AUTH_FIXTURE_FOREIGN_DELEGATION,
  AUTH_FIXTURE_OTHER_DID,
  AUTH_FIXTURE_SUBJECT_DID,
  authTokenFixtures,
  revocationFixtures,
} from '@haverstack/conformance-fixtures';
import { DelegationRefusedError, Stack } from '@haverstack/core';
import { MemoryAdapter } from '@haverstack/core/testing';
import { decodeDelegation, delegationVerifier } from '../src/index.js';

const openStack = async () =>
  Stack.open(await MemoryAdapter.open({ ownerEntityId: 'did:key:z6MkFixtureOwner' }), {
    verifyDelegation: delegationVerifier(),
  });

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'));

describe('delegation fixtures', () => {
  it('the delegated-token fixture carries a chain from its subject to the fixture DID', async () => {
    const fixture = authTokenFixtures.find((f) => f.name === 'auth-token-issues-delegated-token')!;
    expect(fixture.requestBody!.delegationChain).toEqual([AUTH_FIXTURE_DELEGATION]);
    const accepted = await (
      await openStack()
    ).verifyDelegationChain([decode(AUTH_FIXTURE_DELEGATION)], { principalId: AUTH_FIXTURE_DID });
    expect(accepted.subjectId).toBe(AUTH_FIXTURE_SUBJECT_DID);
    expect(accepted.expiresAt).toBeNull();
    expect(accepted.families).toEqual([
      { baseId: 'com.example/note', verbs: ['create', 'read', 'update', 'delete'] },
    ]);
    expect((fixture.responseBody as { subjectId: string }).subjectId).toBe(
      AUTH_FIXTURE_SUBJECT_DID,
    );
  });

  it('the foreign delegation is valid for another key and refused for the fixture DID', async () => {
    const chain = [decode(AUTH_FIXTURE_FOREIGN_DELEGATION)];
    const stack = await openStack();
    await expect(
      stack.verifyDelegationChain(chain, { principalId: AUTH_FIXTURE_OTHER_DID }),
    ).resolves.toMatchObject({
      subjectId: AUTH_FIXTURE_SUBJECT_DID,
    });
    await expect(
      stack.verifyDelegationChain(chain, { principalId: AUTH_FIXTURE_DID }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  it('the revocation fixtures name the fixture delegation by its CID, revoked by its issuer', async () => {
    const d = await decodeDelegation(decode(AUTH_FIXTURE_DELEGATION));
    expect(d.cid).toBe(AUTH_FIXTURE_DELEGATION_CID);
    const stack = await openStack();
    const issued = revocationFixtures.find((f) => f.name === 'revocation-by-issuer')!;
    const record = await stack.asEntity(AUTH_FIXTURE_SUBJECT_DID).revokeDelegation!(
      issued.requestBody!.delegationChain.map(decode),
    );
    expect(record.content).toEqual((issued.responseBody as { content: unknown }).content);
  });
});
