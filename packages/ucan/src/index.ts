/**
 * @haverstack/ucan
 * -------------------------------------------------------
 * UCAN Delegation 1.0 for Haverstack: issue a delegation, decode one, and
 * validate a chain of them. Verification only, and only what the UCAN
 * specs define: no transport, storage or invocation. Kept out of
 * @haverstack/core so the floor stays dependency-free.
 */

export { UcanError, type UcanErrorCode } from './errors.js';
export { encodeVarsigHeader, decodeVarsigHeader, type SignatureAlgorithm } from './varsig.js';
export {
  parseDidKey,
  didKeyFromPublicKey,
  stripFragment,
  didVerifier,
  type IssuerKey,
} from './did-key.js';
export { verifySignature } from './signature.js';
export { isValidCommand, commandCovers } from './command.js';
export {
  parsePolicy,
  parseSelector,
  resolveSelector,
  evaluatePolicy,
  ipldEquals,
  globMatch,
  type IpldValue,
  type Policy,
  type Selector,
  type Statement,
} from './policy.js';
export {
  DELEGATION_TAG,
  decodeDelegation,
  delegationCid,
  type Delegation,
  type DelegationPayload,
} from './delegation.js';
export { validateChain, authorizes, type ChainOptions, type ValidChain } from './chain.js';
export { issueDelegation, type DelegationOptions, type DelegationSigner } from './issue.js';
export { RECORD_COMMAND, recordCommand, delegationVerifier } from './haverstack.js';
