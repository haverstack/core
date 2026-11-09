import type { WireBlobsResponse, WireError } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// GET /blobs lists every blob the store holds, so a hosted stack can be
// read in full (docs/spec/wire-format.md § Blobs). It is served to the
// owner acting alone: a listing names files no Record the requester
// reaches names.

const FILE_A = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
const FILE_B = '31609426297325bdb28c86ab3ceeed4a3c438966733fd61b8aea00ee8b23b7bc';

const OWNER_ONLY: WireError = {
  error: { code: 'permission', message: 'Only the owner acting alone may list blobs' },
};

export const listBlobsFixtures: ConformanceFixture<undefined, WireBlobsResponse | WireError>[] = [
  {
    name: 'list-blobs-reads-every-blob-in-fileId-order',
    description:
      'GET /blobs from the owner acting alone, with no params, reads every blob the store ' +
      'holds, fileId ascending, named by a Record or not, and answers cursor null because ' +
      'nothing follows. modifiedAt is when this store wrote the bytes. ' +
      'See docs/spec/wire-format.md § Blobs.',
    method: 'GET',
    path: '/blobs',
    responseStatus: 200,
    responseBody: {
      blobs: [
        { fileId: FILE_A, size: 3, modifiedAt: '2024-01-01T00:00:00.000Z' },
        { fileId: FILE_B, size: 2, modifiedAt: '2024-01-02T00:00:00.000Z' },
      ],
      cursor: null,
    },
  },
  {
    name: 'list-blobs-page-reports-a-cursor-to-resume-from',
    description:
      'A page may be shorter than the limit asked for, so cursor is the only end-of-list ' +
      'signal, exactly as on the journal. Its value is the fileId to send back as afterFileId, ' +
      'which is exclusive. A client reading every blob follows it rather than taking the first ' +
      'page for the answer.',
    method: 'GET',
    path: `/blobs?limit=1`,
    responseStatus: 200,
    responseBody: {
      blobs: [{ fileId: FILE_A, size: 3, modifiedAt: '2024-01-01T00:00:00.000Z' }],
      cursor: FILE_A,
    },
  },
  {
    name: 'list-blobs-non-owner',
    description:
      'GET /blobs from anyone but the owner answers 403 / code "permission", whatever grants ' +
      'they hold: a listing reveals files no Record the requester reaches names, so no grant ' +
      'confers it. The gate is the one includeUnlisted, purge and POST /types use.',
    method: 'GET',
    path: '/blobs',
    responseStatus: 403,
    responseBody: OWNER_ONLY,
  },
  {
    name: 'list-blobs-delegated-session',
    description:
      'GET /blobs from a delegated session, even one whose subject is the owner, answers 403 / ' +
      'code "permission". The owner acting alone is the gate; delegated authority is the ' +
      'intersection of two parties, and no grant carries enumeration standing.',
    method: 'GET',
    path: '/blobs',
    responseStatus: 403,
    responseBody: OWNER_ONLY,
  },
];
