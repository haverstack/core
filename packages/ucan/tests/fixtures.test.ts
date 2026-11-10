/**
 * The delegation fixtures in @haverstack/conformance-fixtures are real
 * UCAN envelopes, so a server can validate them rather than trust their
 * shape. These pin that they validate, and fail, as the fixtures say.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_FIXTURE_DELEGATION,
  AUTH_FIXTURE_DID,
  AUTH_FIXTURE_FOREIGN_DELEGATION,
  AUTH_FIXTURE_OTHER_DID,
  AUTH_FIXTURE_SUBJECT_DID,
  authTokenFixtures,
} from '@haverstack/conformance-fixtures';
import { acceptDelegation, UcanError } from '../src/index.js';

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'));

describe('delegation fixtures', () => {
  it('the delegated-token fixture carries a chain from its subject to the fixture DID', async () => {
    const fixture = authTokenFixtures.find((f) => f.name === 'auth-token-issues-delegated-token')!;
    expect(fixture.requestBody!.delegationChain).toEqual([AUTH_FIXTURE_DELEGATION]);
    const accepted = await acceptDelegation([decode(AUTH_FIXTURE_DELEGATION)], AUTH_FIXTURE_DID);
    expect(accepted.subjectId).toBe(AUTH_FIXTURE_SUBJECT_DID);
    expect(accepted.expiresAt).toBeNull();
    for (const verb of ['create', 'read', 'update', 'delete'] as const) {
      expect(accepted.delegation.allows(verb, 'com.example/note')).toBe(true);
    }
    expect((fixture.responseBody as { subjectId: string }).subjectId).toBe(
      AUTH_FIXTURE_SUBJECT_DID,
    );
  });

  it('the foreign delegation is valid for another key and refused for the fixture DID', async () => {
    const chain = [decode(AUTH_FIXTURE_FOREIGN_DELEGATION)];
    await expect(acceptDelegation(chain, AUTH_FIXTURE_OTHER_DID)).resolves.toMatchObject({
      subjectId: AUTH_FIXTURE_SUBJECT_DID,
    });
    await expect(acceptDelegation(chain, AUTH_FIXTURE_DID)).rejects.toMatchObject({
      code: 'misaligned',
    });
    await expect(acceptDelegation(chain, AUTH_FIXTURE_DID)).rejects.toBeInstanceOf(UcanError);
  });
});
