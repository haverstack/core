/**
 * Haverstack's commands
 * -------------------------------------------------------
 * A delegation reaches a stack's records through four commands, one per
 * grant action, all under `/haverstack/record`: `create`, `read`, `update`
 * and `delete`, each invoked with the family it acts on as `{ baseId }`.
 * The set is closed, so a delegation of `/haverstack/record` never gains a
 * verb it wasn't signed for. There is no `-own`/`-any` split, since on the
 * principal's side of a request the two mean the same thing.
 * See docs/spec/access-control.md § Signed delegations.
 */

import type { DelegatedVerb, SignedDelegation } from '@haverstack/core';
import { authorizes, validateChain, type ChainOptions, type ValidChain } from './chain.js';
import { decodeDelegation } from './delegation.js';
import { stripFragment } from './did-key.js';
import { UcanError } from './errors.js';

/** Proves every record verb, and only those. */
export const RECORD_COMMAND = '/haverstack/record';

export const recordCommand = (verb: DelegatedVerb): string => `${RECORD_COMMAND}/${verb}`;

/**
 * What a validated chain lets its audience do for its subject, in the form
 * `Stack.asActor()` takes. It answers from the chain as validated: a caller
 * holding it across requests revalidates the chain for time bounds and
 * revocation on each one.
 */
export const signedDelegation = (chain: ValidChain): SignedDelegation => ({
  subjectId: chain.subject,
  principalId: chain.audience,
  allows: (verb, baseId) => authorizes(chain, recordCommand(verb), { baseId }),
});

export type AcceptedDelegation = {
  /** Whom the session acts for: the chain's subject. */
  subjectId: string;
  /** The chain's earliest expiry, which a session must not outlive; null if none expires. */
  expiresAt: Date | null;
  /** What to pass to Stack.asActor() as `{ delegation }`. */
  delegation: SignedDelegation;
};

/**
 * Validate a delegation chain presented by the key that authenticated as
 * `principalId`, the way a server does at `/auth/token` and again on every
 * request a delegated token makes. The chain must end at that key and
 * begin at someone else: a key needs no delegation to act as itself.
 * See docs/spec/wire-format.md § The handshake.
 */
export const acceptDelegation = async (
  chain: readonly Uint8Array[],
  principalId: string,
  options: ChainOptions = {},
): Promise<AcceptedDelegation> => {
  const valid = await validateChain(await Promise.all(chain.map(decodeDelegation)), options);
  if (valid.audience !== stripFragment(principalId)) {
    throw new UcanError('misaligned', 'The chain is not delegated to the key that authenticated.');
  }
  if (valid.subject === valid.audience) {
    throw new UcanError('misaligned', 'A key needs no delegation to act as itself.');
  }
  return {
    subjectId: valid.subject,
    expiresAt: valid.expiresAt === null ? null : new Date(valid.expiresAt * 1000),
    delegation: signedDelegation(valid),
  };
};
