import type { WireRecord, WireVersion, WireVersionsResponse } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// -------------------------------------------------------
// Versions: read
// -------------------------------------------------------
//
// GET /records/:id/versions[/:version] require mutate-surface
// authorization, not plain read access (docs/spec/versioning.md
// § History access). These pin the success shape; the 403 case is
// error-permission-denied-versions-read-only.

export const getVersionsFixtures: ConformanceFixture<undefined, WireVersionsResponse>[] = [
  {
    name: 'get-versions-owner',
    description:
      'GET /records/:id/versions for the stack owner returns every snapshot field verbatim.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: {
      versions: [
        {
          version: 1,
          typeId: 'com.example/note@1',
          content: { title: 'original title' },
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'get-versions-non-owner-write-holder-sees-the-same-rows',
    description:
      'GET /records/:id/versions for a non-owner write-holder — who passes the mutate-surface ' +
      'gate above — returns exactly what the owner sees. A snapshot carries content and the ' +
      'typeId it is read under, and nothing a reader who already passed that gate is denied: ' +
      'createdBy and updatedBy are the same class of fact as the author on the live ' +
      'record. See docs/spec/versioning.md § History access.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: {
      versions: [
        {
          version: 1,
          typeId: 'com.example/note@1',
          content: { title: 'original title' },
          updatedAt: '2024-01-01T00:00:00.000Z',
          createdBy: { subjectId: 'entity-contributor-789' },
          updatedBy: { subjectId: 'entity-contributor-789' },
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'get-versions-page-reports-a-cursor-to-resume-from',
    description:
      'Newest first, a page of history starts at the restore points. A server may answer a ' +
      'page shorter than the limit asked for, so cursor is the only end-of-history signal: ' +
      'its value is the version to send back as beforeVersion, which is exclusive. A client ' +
      'reading the whole history follows it rather than taking the first page for the answer. ' +
      'See docs/spec/wire-format.md § Versions.',
    method: 'GET',
    path: '/records/1hk153x00001/versions?limit=1',
    responseStatus: 200,
    responseBody: {
      versions: [
        {
          version: 3,
          typeId: 'com.example/note@1',
          content: { title: 'title before restore' },
          updatedAt: '2024-01-03T00:00:00.000Z',
        },
      ],
      cursor: 3,
    },
  },
  {
    name: 'get-versions-before-version-ends-with-a-null-cursor',
    description:
      'The follow-up page from cursor 3 holds the versions strictly older than 3, and its ' +
      'cursor is null because nothing follows. See docs/spec/wire-format.md § Versions.',
    method: 'GET',
    path: '/records/1hk153x00001/versions?beforeVersion=3&limit=1',
    responseStatus: 200,
    responseBody: {
      versions: [
        {
          version: 2,
          typeId: 'com.example/note@1',
          content: { title: 'original title' },
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
      ],
      cursor: null,
    },
  },
];

export const getVersionFixtures: ConformanceFixture<undefined, WireVersion>[] = [
  {
    name: 'get-version-single',
    description:
      'GET /records/:id/versions/:version applies the same mutate-surface gate as the list ' +
      'endpoint above, for the single-version fetch.',
    method: 'GET',
    path: '/records/1hk153x00001/versions/1',
    responseStatus: 200,
    responseBody: {
      version: 1,
      typeId: 'com.example/note@1',
      content: { title: 'original title' },
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'get-version-carries-no-containment-listing-or-authority-state',
    description:
      'A snapshot carries what only a snapshot preserves: content and the typeId it is read ' +
      'under. It names no parentId, no unlistedAt and no permissions, whatever container the ' +
      'record sat in, whether it was listed, or who reached it at the time — those aspects ' +
      'bump no version, so no version is ever taken of them. A server that emits any of them ' +
      'is writing a key every client drops. Assumes the record was in 1hk153x0000f and ' +
      'unlisted when version 2 was taken. ' +
      'See docs/spec/versioning.md § Version history.',
    method: 'GET',
    path: '/records/1hk153x00001/versions/2',
    responseStatus: 200,
    responseBody: {
      version: 2,
      typeId: 'com.example/note@1',
      content: { title: 'title before restore' },
      updatedAt: '2024-01-02T00:00:00.000Z',
    },
  },
];

// -------------------------------------------------------
// Versions: read after migrate/restore
// -------------------------------------------------------
//
// The server is the only snapshot writer (docs/spec/wire-format.md
// § Versions); these pin that a version row appears after POST /migrate
// and POST /restore/:version specifically. A server-side conformance run
// dispatches the mutating fixture first and asserts the version count
// grew; a mocked-transport run can only assert the response shape parses.

export const getVersionsAfterMutateFixtures: ConformanceFixture<undefined, WireVersionsResponse>[] =
  [
    {
      name: 'get-versions-after-restore-includes-pre-restore-snapshot',
      description:
        'After restore-version (POST /records/1hk153x00001/restore/1, which moves the record to ' +
        'version 4), GET /records/:id/versions includes a version 3 entry — the restore ' +
        "endpoint's own auto-snapshot of the record's state immediately before restoring — " +
        'alongside the pre-existing version 1 snapshot being restored from. Neither entry names ' +
        'a container, whichever one the record sat in when it was taken.',
      method: 'GET',
      path: '/records/1hk153x00001/versions',
      responseStatus: 200,
      responseBody: {
        versions: [
          {
            version: 3,
            typeId: 'com.example/note@1',
            content: { title: 'title before restore' },
            updatedAt: '2024-01-04T00:00:00.000Z',
          },
          {
            version: 1,
            typeId: 'com.example/note@1',
            content: { title: 'original title' },
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        cursor: null,
      },
    },
    {
      name: 'get-versions-after-migrate-includes-pre-migration-snapshot',
      description:
        'After commit-migration (POST /records/1hk153x00001/migrate, which moves the record to ' +
        'version 5), GET /records/:id/versions includes a version 4 entry — the migrate ' +
        "endpoint's own auto-snapshot of the record's pre-migration state, at its pre-migration " +
        'typeId — on top of everything restore-version already produced.',
      method: 'GET',
      path: '/records/1hk153x00001/versions',
      responseStatus: 200,
      responseBody: {
        versions: [
          {
            version: 4,
            typeId: 'com.example/note@1',
            content: { title: 'original title' },
            updatedAt: '2024-01-04T00:00:00.000Z',
          },
          {
            version: 3,
            typeId: 'com.example/note@1',
            content: { title: 'title before restore' },
            updatedAt: '2024-01-04T00:00:00.000Z',
          },
          {
            version: 1,
            typeId: 'com.example/note@1',
            content: { title: 'original title' },
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        cursor: null,
      },
    },
    {
      name: 'get-versions-after-associate-is-unchanged',
      description:
        'The association endpoints are the one pair of mutations that write no version. After ' +
        'associate-tag (POST /records/1hk153x00001/associations), GET /records/:id/versions ' +
        'answers with exactly the list it answered with before — no new entry, and no entry ' +
        'gains an `associations` key, since no snapshot has ever captured one. A server that ' +
        'snapshots here hands every later restore a stale association set to put back. ' +
        'See docs/spec/wire-format.md § Versions.',
      method: 'GET',
      path: '/records/1hk153x00001/versions',
      responseStatus: 200,
      responseBody: {
        versions: [
          {
            version: 4,
            typeId: 'com.example/note@1',
            content: { title: 'original title' },
            updatedAt: '2024-01-04T00:00:00.000Z',
          },
          {
            version: 3,
            typeId: 'com.example/note@1',
            content: { title: 'title before restore' },
            updatedAt: '2024-01-04T00:00:00.000Z',
          },
          {
            version: 1,
            typeId: 'com.example/note@1',
            content: { title: 'original title' },
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        cursor: null,
      },
    },
  ];

// -------------------------------------------------------
// Versions: restore
// -------------------------------------------------------

export const restoreVersionFixtures: ConformanceFixture<undefined, WireRecord>[] = [
  {
    name: 'restore-version',
    description:
      "POST /records/:id/restore/:version creates a new version from an old snapshot's " +
      'content and typeId — never its permissions, and never the containment, listing or ' +
      'associations no snapshot captures, all of which a restore leaves exactly where they ' +
      'stand. No request body: the server holds the snapshot already.',
    method: 'POST',
    path: '/records/1hk153x00001/restore/1',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-04T00:00:00.000Z',
      content: { title: 'original title' },
      version: 4,
    },
  },
  {
    name: 'restore-version-leaves-the-record-where-it-sits',
    description:
      'A restore settles content and nothing else: the record comes back in whatever ' +
      'container it is in now, whichever one the snapshot was taken in. Undoing a move is a ' +
      "change set's `parentId` — the journal entry for the move names where it came from. " +
      'Assumes the record is in 1hk153x0000f and the snapshot at version 2 was taken at the ' +
      'root. See docs/spec/versioning.md § Restore semantics.',
    method: 'POST',
    path: '/records/1hk153x00001/restore/2',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-04T00:00:00.000Z',
      content: { title: 'title before restore' },
      version: 4,
      parentId: '1hk153x0000f',
    },
  },
];
