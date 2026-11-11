/**
 * Delegation chains
 * -------------------------------------------------------
 * A chain runs from its subject to the principal holding it: the first
 * delegation is issued by the subject itself, and each one's audience
 * issues the next. Validating it checks every link (signature, time
 * bounds, revocation) and the links between them. Whether the chain
 * authorizes a particular command and arguments is a separate question,
 * asked of a validated chain by authorizes(), since one chain answers many.
 *
 * Powerline delegations (`sub: null`) are refused. A stack grants through
 * its own records rather than by receiving delegations, so a chain always
 * names its subject outright.
 */

import { commandCovers } from './command.js';
import { parseDidKey, stripFragment, type IssuerKey } from './did-key.js';
import type { Delegation } from './delegation.js';
import { UcanError } from './errors.js';
import { evaluatePolicy, type IpldValue } from './policy.js';
import { verifySignature } from './signature.js';

export type ChainOptions = {
  /** Unix seconds; defaults to the current time. */
  now?: number;
  /** Seconds of clock drift tolerated on each bound. UCAN recommends 60. */
  clockSkew?: number;
  /** The key behind a DID that isn't a did:key, or null if it can't be resolved. */
  resolveKey?: (did: string) => Promise<IssuerKey | null>;
  /**
   * Whether a delegation, named by CID, has been revoked by someone entitled
   * to: `issuers` are the identities that issued it and every delegation
   * upstream of it, root first, any of whom may revoke it, as UCAN
   * Revocation has it.
   */
  isRevoked?: (cid: string, issuers: readonly string[]) => boolean | Promise<boolean>;
};

export type ValidChain = {
  /** The DID the chain is about, and whose authority it carries. */
  subject: string;
  /** The DID the last delegation names: who may act under the chain. */
  audience: string;
  /** Latest `nbf` in the chain, in Unix seconds, if any link has one. */
  notBefore?: number;
  /** Earliest `exp` in the chain, in Unix seconds, or null if no link expires. */
  expiresAt: number | null;
  delegations: readonly Delegation[];
};

const DEFAULT_CLOCK_SKEW = 60;

const issuerKey = async (did: string, options: ChainOptions): Promise<IssuerKey> => {
  const key = parseDidKey(did) ?? (await options.resolveKey?.(stripFragment(did))) ?? null;
  if (!key) throw new UcanError('unsupported', `Cannot resolve a key for issuer "${did}".`);
  return key;
};

/** Validate a chain given root first: the subject's own delegation, then each one it led to. */
export const validateChain = (
  chain: readonly Delegation[],
  options: ChainOptions = {},
): Promise<ValidChain> => checkChain(chain, options, null);

/**
 * validateChain(), remembering in `verified` the CIDs whose signatures it
 * checked against a did:key, whose key never changes. A key resolved any
 * other way is checked every time, since its DID's keys can rotate.
 */
export const checkChain = async (
  chain: readonly Delegation[],
  options: ChainOptions,
  verified: Set<string> | null,
): Promise<ValidChain> => {
  if (chain.length === 0) throw new UcanError('misaligned', 'A delegation chain cannot be empty.');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkew ?? DEFAULT_CLOCK_SKEW;

  const root = chain[0]!;
  if (root.sub === null || stripFragment(root.iss) !== stripFragment(root.sub)) {
    throw new UcanError('misaligned', 'The first delegation must be issued by its subject.');
  }
  const subject = stripFragment(root.sub);

  let notBefore: number | undefined;
  let expiresAt: number | null = null;
  const issuers: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i]!;
    issuers.push(stripFragment(link.iss));
    if (link.sub === null) {
      throw new UcanError('misaligned', 'Powerline delegations (sub: null) are not accepted.');
    }
    if (stripFragment(link.sub) !== subject) {
      throw new UcanError('misaligned', 'Every delegation in a chain must name the same subject.');
    }
    if (i > 0 && stripFragment(chain[i - 1]!.aud) !== stripFragment(link.iss)) {
      throw new UcanError(
        'misaligned',
        `Delegation ${i} is not issued by its predecessor's audience.`,
      );
    }
    if (link.nbf !== undefined && now < link.nbf - skew) {
      throw new UcanError(
        'not-yet-valid',
        `Delegation ${link.cid} is not valid until ${link.nbf}.`,
      );
    }
    if (link.exp !== null && now > link.exp + skew) {
      throw new UcanError('expired', `Delegation ${link.cid} expired at ${link.exp}.`);
    }

    if (!verified?.has(link.cid)) {
      const key = await issuerKey(link.iss, options);
      if (key.alg !== link.alg) {
        throw new UcanError(
          'signature',
          `Delegation ${link.cid} is signed with the wrong algorithm.`,
        );
      }
      if (!verifySignature(link.alg, key.publicKey, link.signature, link.signedBytes)) {
        throw new UcanError('signature', `Delegation ${link.cid} has an invalid signature.`);
      }
      if (parseDidKey(link.iss)) verified?.add(link.cid);
    }
    if (await options.isRevoked?.(link.cid, [...issuers])) {
      throw new UcanError('revoked', `Delegation ${link.cid} has been revoked.`);
    }

    if (link.nbf !== undefined) notBefore = Math.max(notBefore ?? link.nbf, link.nbf);
    if (link.exp !== null) expiresAt = Math.min(expiresAt ?? link.exp, link.exp);
  }

  return {
    subject,
    audience: stripFragment(chain[chain.length - 1]!.aud),
    ...(notBefore !== undefined && { notBefore }),
    expiresAt,
    delegations: chain,
  };
};

/**
 * Whether a validated chain authorizes `cmd` with `args`: every delegation
 * in it must prove the command and accept the arguments, since each link
 * can only narrow what the one before it gave.
 */
export const authorizes = (chain: ValidChain, cmd: string, args: IpldValue): boolean =>
  chain.delegations.every((d) => commandCovers(d.cmd, cmd) && evaluatePolicy(d.policy, args));
