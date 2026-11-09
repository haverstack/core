/**
 * Haverstack's commands
 * -------------------------------------------------------
 * A delegation reaches a stack's records through four commands, one per
 * grant action: `/haverstack/create`, `/haverstack/read`,
 * `/haverstack/update` and `/haverstack/delete`, each invoked with the
 * family it acts on as `{ baseId }`, which `pol` may constrain. `/haverstack`
 * proves all four. There is no `-own`/`-any` split, since on the principal's
 * side of a request the two mean the same thing.
 * See docs/spec/access-control.md § Signed delegations.
 */

import type { DelegatedVerb, SignedDelegation } from '@haverstack/core';
import { authorizes, type ValidChain } from './chain.js';

export const HAVERSTACK_COMMAND = '/haverstack';

export const haverstackCommand = (verb: DelegatedVerb): string => `${HAVERSTACK_COMMAND}/${verb}`;

/**
 * What a validated chain lets its audience do for its subject, in the form
 * `Stack.asActor()` takes. It answers from the chain as validated: a caller
 * holding it across requests revalidates the chain for time bounds and
 * revocation on each one.
 */
export const signedDelegation = (chain: ValidChain): SignedDelegation => ({
  subjectId: chain.subject,
  principalId: chain.audience,
  allows: (verb, baseId) => authorizes(chain, haverstackCommand(verb), { baseId }),
});
