/**
 * Haverstack's commands, and the verifier a stack is opened with
 * -------------------------------------------------------
 * A delegation reaches a stack's records through four commands, one per
 * grant action, all under `/haverstack/record`: `create`, `read`, `update`
 * and `delete`, each invoked with the family it acts on as `{ baseId }`.
 * The set is closed, so a delegation of `/haverstack/record` never gains a
 * verb it wasn't signed for. There is no `-own`/`-any` split, since on the
 * principal's side of a request the two mean the same thing.
 *
 * delegationVerifier() is what `Stack.open({ verifyDelegation })` takes:
 * core hands it each session's chain, once per operation, with the stack's
 * own revocation check, and each chain a revocation names. See
 * docs/spec/access-control.md § Signed delegations.
 */

import type { DelegationVerifier, RecordVerb, VerifiedDelegation } from '@haverstack/core';
import { authorizes, checkChain, type ChainOptions } from './chain.js';
import { decodeDelegation } from './delegation.js';
import { stripFragment } from './did-key.js';

/** Proves every record verb, and only those. */
export const RECORD_COMMAND = '/haverstack/record';

export const recordCommand = (verb: RecordVerb): string => `${RECORD_COMMAND}/${verb}`;

/**
 * A DelegationVerifier for UCAN Delegation 1.0 chains. A did:key link's
 * signature is checked once and remembered by CID, as UCAN recommends, so
 * revalidating on every operation costs time bounds and the revocation
 * check. Pass the same `resolveKey` to didVerifier(), so the handshake
 * authenticates exactly the identities chains accept as issuers.
 */
export const delegationVerifier = (
  options: Omit<ChainOptions, 'isRevoked' | 'now' | 'timeBounds'> = {},
): DelegationVerifier => {
  const verified = new Set<string>();
  return async (chain, { isRevoked, timeBounds }): Promise<VerifiedDelegation> => {
    const valid = await checkChain(
      await Promise.all(chain.map((link) => decodeDelegation(new Uint8Array(link)))),
      { ...options, isRevoked: (cid) => isRevoked(cid), timeBounds },
      verified,
    );
    return {
      subjectId: valid.subject,
      principalId: valid.audience,
      expiresAt: valid.expiresAt === null ? null : new Date(valid.expiresAt * 1000),
      allows: (verb, baseId) => authorizes(valid, recordCommand(verb), { baseId }),
      links: valid.delegations.map((d) => ({ cid: d.cid, issuerId: stripFragment(d.iss) })),
    };
  };
};
