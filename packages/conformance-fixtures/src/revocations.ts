import type { WireError, WireRecord, WireRevocationRequest } from '@haverstack/wire-types';
import { AUTH_FIXTURE_DELEGATION, AUTH_FIXTURE_SUBJECT_DID } from './auth.js';
import type { ConformanceFixture } from './types.js';

// POST /revocations withdraws a delegation: the owner, or an identity that
// issued a link of its chain, acting as itself, names the chain ending at
// it (docs/spec/wire-format.md § Revocations). A server that advertises
// delegations takes these. Each fixture assumes the session is the key
// its description names.

/** The CID of AUTH_FIXTURE_DELEGATION, which a revocation of it names. */
export const AUTH_FIXTURE_DELEGATION_CID = 'zdpuAyHgSVWpaZyMo36Pfq4oanEXU1CMNi67EagHapZ3jvBp5';

export const revocationFixtures: ConformanceFixture<
  WireRevocationRequest,
  WireRecord | WireError
>[] = [
  {
    name: 'revocation-by-issuer',
    description:
      'POST /revocations from AUTH_FIXTURE_SUBJECT_DID, which issued AUTH_FIXTURE_DELEGATION, ' +
      'answers 201 with the _revocation record naming its CID, attributed to the revoker. From ' +
      'then on no chain through that delegation validates on this stack, and every session ' +
      'resting on one is refused with 401. The record is the stack owner’s to delete; the ' +
      'revoker cannot lift it. The chain must validate but for its time bounds, so a ' +
      'delegation can be revoked before it starts or after it ends.',
    method: 'POST',
    path: '/revocations',
    requestBody: { delegationChain: [AUTH_FIXTURE_DELEGATION] },
    responseStatus: 201,
    responseBody: {
      id: '1hk153x0000r',
      typeId: '_revocation@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { cid: AUTH_FIXTURE_DELEGATION_CID },
      version: 1,
      createdBy: { subjectId: AUTH_FIXTURE_SUBJECT_DID },
      updatedBy: { subjectId: AUTH_FIXTURE_SUBJECT_DID },
    },
  },
  {
    name: 'revocation-not-an-issuer',
    description:
      'POST /revocations from a key that is neither the stack owner nor an issuer of any link ' +
      'in the chain, or from a session acting for someone else, answers 403 with code ' +
      '"permission". Withdrawing a delegation is the standing of whoever granted it.',
    method: 'POST',
    path: '/revocations',
    requestBody: { delegationChain: [AUTH_FIXTURE_DELEGATION] },
    responseStatus: 403,
    responseBody: {
      error: {
        code: 'permission',
        message: 'Only the owner or an issuer in its chain may revoke a delegation',
      },
    },
  },
  {
    name: 'revocation-chain-invalid',
    description:
      'POST /revocations whose chain does not validate — malformed, badly signed, or not ' +
      'linked from its subject — answers 400 with code "bad_request". A revoker never names ' +
      'links it could not have signed. A refused chain here is a bad request, not a 401: the ' +
      'session itself authenticated.',
    method: 'POST',
    path: '/revocations',
    requestBody: { delegationChain: ['glhA'] },
    responseStatus: 400,
    responseBody: {
      error: { code: 'bad_request', message: 'The delegation chain does not validate' },
    },
  },
];
