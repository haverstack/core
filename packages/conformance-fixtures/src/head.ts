import type { WireError, WireHeadResponse } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// GET /head reports where the store's writes stand, so a client reading
// the store in full can tell whether anything was written while it read
// (docs/spec/wire-format.md § Head). Served to the owner acting alone, as
// GET /blobs is.

const OWNER_ONLY: WireError = {
  error: { code: 'permission', message: 'Only the owner acting alone may read the head' },
};

export const getHeadFixtures: ConformanceFixture<undefined, WireHeadResponse | WireError>[] = [
  {
    name: 'get-head-reports-where-writes-stand',
    description:
      'GET /head from the owner acting alone answers the head: opaque, compared only for ' +
      'equality. It is the same string until anything is written — a Record, a Type or a ' +
      'blob, by anyone — and a different one after, never a value an earlier head held, a ' +
      'server restart included. A head minted per request, or from the clock, makes every ' +
      'copy from this server fail. See docs/spec/portability.md § Copying a stack.',
    method: 'GET',
    path: '/head',
    responseStatus: 200,
    responseBody: { head: '9b1c0f6e-3d2a-4c55-9a7e-2f1d8c3b4a10.42' },
  },
  {
    name: 'get-head-non-owner',
    description:
      'GET /head from anyone but the owner answers 403 / code "permission": a head moves on ' +
      'writes to Records the requester cannot read, so it would report them.',
    method: 'GET',
    path: '/head',
    responseStatus: 403,
    responseBody: OWNER_ONLY,
  },
  {
    name: 'get-head-delegated-session',
    description:
      'GET /head from a delegated session answers 403 / code "permission", as GET /blobs does: ' +
      'the owner acting alone is the gate.',
    method: 'GET',
    path: '/head',
    responseStatus: 403,
    responseBody: OWNER_ONLY,
  },
];
