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
 * A chain must name its families, as a grant does: each link's policy is
 * empty or constrains `.baseId` to listed values, with `==` or an `or` of
 * `==`, and at least one link constrains it. Any other policy, and a chain
 * reaching every family, is refused, so what a delegation allows is a
 * list core reads without asking which families the stack defines.
 *
 * delegationVerifier() is what `Stack.open({ verifyDelegation })` takes:
 * core hands it each session's chain, once per operation, with the stack's
 * own revocation check, and each chain a revocation names. See
 * docs/spec/access-control.md § Signed delegations.
 */

import type { DelegationVerifier, RecordVerb, VerifiedDelegation } from '@haverstack/core';
import { commandCovers } from './command.js';
import type { Delegation } from './delegation.js';
import { UcanError } from './errors.js';
import type { Statement } from './policy.js';
import { checkChain, type ChainOptions } from './chain.js';
import { decodeDelegation } from './delegation.js';
import { stripFragment } from './did-key.js';

/** Proves every record verb, and only those. */
export const RECORD_COMMAND = '/haverstack/record';

export const recordCommand = (verb: RecordVerb): string => `${RECORD_COMMAND}/${verb}`;

const RECORD_VERBS: readonly RecordVerb[] = ['create', 'read', 'update', 'delete'];

/** The one family `==` names, or null for any other statement. */
const namedFamily = (statement: Statement): string | null =>
  statement.op === '==' &&
  statement.selector.source === '.baseId' &&
  typeof statement.value === 'string'
    ? statement.value
    : null;

/** The families a link's policy names, or null when it names none. */
const linkFamilies = (link: Delegation): Set<string> | null => {
  if (link.policy.length === 0) return null;
  const statement = link.policy[0]!;
  const named =
    link.policy.length !== 1
      ? []
      : statement.op === 'or'
        ? statement.statements.map(namedFamily)
        : [namedFamily(statement)];
  if (named.length === 0 || named.some((family) => family === null)) {
    throw new UcanError(
      'unsupported',
      `Delegation ${link.cid}'s policy does not name the families it allows.`,
    );
  }
  return new Set(named as string[]);
};

/** What a chain allows, family by family: the intersection of its links. */
const chainFamilies = (chain: readonly Delegation[]): VerifiedDelegation['families'] => {
  const named = chain.map(linkFamilies).filter((set): set is Set<string> => set !== null);
  if (named.length === 0) {
    throw new UcanError('unsupported', 'A delegation chain must name the families it allows.');
  }
  const verbs = RECORD_VERBS.filter((verb) =>
    chain.every((link) => commandCovers(link.cmd, recordCommand(verb))),
  );
  const families = [...named[0]!].filter((family) => named.every((set) => set.has(family)));
  return families.map((baseId) => ({ baseId, verbs }));
};

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
  return async (chain, check): Promise<VerifiedDelegation> => {
    const acting = check.purpose === 'act';
    const valid = await checkChain(
      await Promise.all(chain.map((link) => decodeDelegation(new Uint8Array(link)))),
      acting
        ? { ...options, isRevoked: (cid) => check.isRevoked(cid) }
        : { ...options, timeBounds: false },
      verified,
    );
    return {
      subjectId: valid.subject,
      principalId: valid.audience,
      expiresAt: valid.expiresAt === null ? null : new Date(valid.expiresAt * 1000),
      families: acting ? chainFamilies(valid.delegations) : [],
      links: valid.delegations.map((d) => ({ cid: d.cid, issuerId: stripFragment(d.iss) })),
    };
  };
};
