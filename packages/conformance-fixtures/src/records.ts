import type { WireRecord } from '@haverstack/wire-types';
import type { ConformanceFixture, ConformanceSequenceFixture } from './types.js';

// -------------------------------------------------------
// Records: create
// -------------------------------------------------------

export const createRecordFixtures: ConformanceFixture<WireRecord, WireRecord>[] = [
  {
    name: 'create-record',
    description: 'POST /records accepts a full record body and echoes it back.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
    },
  },
  {
    name: 'create-record-unlisted',
    description:
      'A create body carrying unlistedAt is honoured verbatim — creating a record already ' +
      'unlisted, so there is no window where it exists and is enumerable before a later ' +
      "change set's `unlisted` key catches up. Excluded from an unfiltered GET/POST /records/query " +
      'and the change feed by default, the same as any other unlisted record. See ' +
      'docs/spec/unlisted.md.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00009',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Link-shared draft' },
      version: 1,
      unlistedAt: '2024-01-01T00:00:00.000Z',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00009',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Link-shared draft' },
      version: 1,
      unlistedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'create-grant-record-group-grantee',
    description:
      'A _grant@1 record names its grantee affirmatively, in one of three tiers: ' +
      "`{ kind: 'entity', entityId }`, `{ kind: 'group', groupId, role }` where `member` is the " +
      "wider set and `admin` the narrower, or `{ kind: 'authenticated' }` for any authenticated " +
      'entity — never an anonymous requester, which is what separates it from a record ' +
      "permission's `{ kind: 'anyone' }`. The field is required, so no tier is reachable by " +
      'omission (see error-validation-grant-without-grantee). Owner-only: a grant is what ' +
      'decides who may write, so nothing a grant confers reaches back to writing one. ' +
      'See docs/spec/access-control.md § Type-level grants.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x0000h',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['create', 'read-any'],
        grantee: { kind: 'group', groupId: '1hk153x0000g', role: 'member' },
      },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x0000h',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['create', 'read-any'],
        grantee: { kind: 'group', groupId: '1hk153x0000g', role: 'member' },
      },
      version: 1,
    },
  },
  {
    name: 'create-record-ignores-client-supplied-entity-and-principal',
    description:
      'createdBy is assigned by the server from the authenticated session, so a body carrying ' +
      'it is ignored rather than honoured — here the session is an undelegated contributor, so ' +
      'the response names that contributor as subjectId and omits principalId entirely, ' +
      'discarding both values the client sent. The pair answers "who did this", and principalId ' +
      'exists to be the half a client cannot assert: honouring it would let any requester dress ' +
      'a write up as a verified app action and defeat the _app cross-check that reads it. ' +
      'updatedBy answers the same question about the mutation rather than the record, so it is ' +
      'assigned and ignored on the same terms. ' +
      'appId is the deliberate exception, self-reported by design. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Forged', body: 'World' },
      version: 1,
      createdBy: {
        subjectId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        principalId: 'did:key:z6MkfNotesAppKeyClaimedByTheClient00000000000000',
      },
      updatedBy: {
        subjectId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        principalId: 'did:key:z6MkfNotesAppKeyClaimedByTheClient00000000000000',
      },
      appId: 'com.example.myapp',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Forged', body: 'World' },
      version: 1,
      createdBy: { subjectId: 'entity-contributor-789' },
      updatedBy: { subjectId: 'entity-contributor-789' },
      appId: 'com.example.myapp',
    },
  },
  {
    name: 'create-record-response-carries-principal-under-delegation',
    description:
      'A write made by a delegated app comes back with createdBy.subjectId naming the subject it ' +
      'acted for and createdBy.principalId naming the app that authenticated — the pair a reader needs to tell ' +
      'verified app attribution from a bare appId self-report. An undelegated write omits ' +
      'principalId (see create-record above), so its presence is itself the signal. ' +
      'See docs/spec/identity.md § Attribution and what can be trusted.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00003',
      typeId: 'com.example/comment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { body: 'Posted through a blog server' },
      version: 1,
      appId: 'com.example.blog',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00003',
      typeId: 'com.example/comment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { body: 'Posted through a blog server' },
      version: 1,
      createdBy: {
        subjectId: 'entity-contributor-789',
        principalId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      },
      updatedBy: {
        subjectId: 'entity-contributor-789',
        principalId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      },
      appId: 'com.example.blog',
    },
  },
  {
    name: 'create-attachment-record-matching-mimetype-succeeds',
    description:
      'mimeType is a property of the fileId, established by the first _attachment@1 ' +
      'record ever created for it. A second upload of the same bytes that declares a matching ' +
      'mimeType succeeds and gets its own record — its own id, createdBy, and filename — rather ' +
      'than being deduplicated away. Assumes the requester is the owner (generic ' +
      'POST /records for _attachment@1 is owner-only — see ' +
      'error-permission-denied-attachment-non-owner-create and ' +
      'create-attachment-record-non-owner-carve-out-succeeds for the non-owner cases) and that ' +
      'an _attachment@1 record already exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with ' +
      '"mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x03004',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'second.png',
      },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x03004',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'second.png',
      },
      version: 1,
    },
  },
  {
    name: 'create-attachment-record-non-owner-carve-out-succeeds',
    description:
      'A non-owner who can already read some record referencing ' +
      'fileId "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" may create an additional _attachment@1 record for it — e.g. their own ' +
      'filename — without re-uploading bytes, since this conveys no access they did not already ' +
      'have. Assumes a record readable by this requester already carries an attachment ' +
      'association or file-ref field for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d". The carve-out is satisfied only ' +
      "by that readable reference, never by the requester's own prior _attachment@1 record for " +
      'the same fileId — see create-attachment-record-non-owner-without-carve-out-refused.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x05006',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'mine.png',
      },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x05006',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'mine.png',
      },
      version: 1,
    },
  },
];

// -------------------------------------------------------
// Records: patchContent — PATCH /records/:id
// -------------------------------------------------------

export const patchContentFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] = [
  {
    name: 'patch-record-restamps-the-actor',
    description:
      'A write by someone other than the author moves updatedBy to the requester and leaves ' +
      'createdBy alone — the record keeps its author, and gains a record of who last changed ' +
      'it. Under delegation updatedBy.principalId names the app alongside it, exactly as ' +
      'createdBy.principalId does for the create. Both are assigned from the session and ' +
      'ignored on input. See docs/spec/data-model.md § Authorship and attribution.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { title: 'edited by a contributor' } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'edited by a contributor' },
      version: 2,
      createdBy: { subjectId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' },
      updatedBy: { subjectId: 'entity-contributor-789' },
    },
  },
  {
    name: 'patch-content-merges-and-adds-fields',
    description:
      'The PATCH body carries only the content patch — never typeId, version, or updatedAt. ' +
      'The server merges it against current content and assigns the new version/updatedAt itself.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { title: 'Updated title', pinned: true } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Updated title', pinned: true, body: 'original body' },
      version: 2,
    },
  },
  {
    name: 'patch-content-null-deletes-a-field',
    description:
      'A field set to null is removed from stored content (RFC 7396 merge-patch delete). ' +
      'Fields omitted from the patch are left untouched.',
    method: 'PATCH',
    path: '/records/1hk153x01002',
    requestBody: { contentPatch: { title: null } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x01002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { body: 'kept' },
      version: 2,
    },
  },
];

// -------------------------------------------------------
// Records: delete / undelete
// -------------------------------------------------------

export const deleteRecordFixtures: ConformanceFixture<undefined, WireRecord | undefined>[] = [
  {
    name: 'delete-record-soft',
    description:
      'DELETE /records/:id soft-deletes — record and version history are retained — and answers ' +
      'with the record it produced, carrying deletedAt and the bumped version. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'DELETE',
    path: '/records/1hk153x00001',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      deletedAt: '2024-01-02T00:00:00.000Z',
    },
  },
  {
    name: 'delete-record-purge',
    description:
      'DELETE /records/:id?purge=true permanently removes the record, its history and its ' +
      'journal, and answers 200 with the record as it last stood. It is the one response that ' +
      'is not the record a write produced, because this write produces none: the body is the ' +
      "purge's only report of what it destroyed, and a client reads the files it stranded — " +
      'the attachment associations and file-ref fields — off it. Every other row naming those ' +
      'files is gone by the time the response lands. A purged frame still carries nothing: ' +
      'that fans out to every subscriber, this goes to the owner who authorized the purge. ' +
      'See docs/spec/attachments.md § A purge strands the bytes it referenced.',
    method: 'DELETE',
    path: '/records/1hk153x00001?purge=true',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      associations: [
        {
          kind: 'attachment',
          label: 'cover',
          fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        },
      ],
    },
  },
];

/**
 * A single request/response pair pins the shape of a purge's body,
 * but not that the body was produced by reading and destroying the record
 * as one operation rather than by a read taken earlier and a destroy that
 * followed it — the gap a server bridging the two with two separate calls
 * (or a cached read) can leave open, and the one true concurrency would
 * exploit: a write landing in that gap gets destroyed by the purge without
 * ever being reported. See docs/spec/wire-format.md § Records and
 * docs/spec/attachments.md § A purge strands the bytes it referenced.
 */
export const deleteRecordSequenceFixtures: ConformanceSequenceFixture[] = [
  {
    name: 'purge-under-concurrent-write',
    description:
      'A write lands on a record — here, an association with no If-Match to fence it, the kind ' +
      "a concurrent request makes — immediately before that record is purged. The purge's " +
      'response MUST carry that association: a server whose purge reads the record and ' +
      'destroys it in two separate steps would satisfy the single delete-record-purge fixture ' +
      'while still losing this write whenever it lands between the two — read early, land late, ' +
      'destroyed unreported. Nothing about the request sequence below is itself concurrent; what ' +
      "it pins is that the purge's response reflects the record as stored at the moment of " +
      'destruction, current as of whatever the last write before it was, not a snapshot taken ' +
      'earlier in the request. Assumes a record readable and purgeable by this requester at ' +
      '"1hk153x0000c", already carrying one attachment association: {"kind": "attachment", ' +
      '"label": "cover", "fileId": ' +
      '"933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d"}.',
    steps: [
      {
        name: 'purge-under-concurrent-write-late-association',
        description:
          'The write that must not be lost: a second attachment association added to the ' +
          'record the very next step purges. Ordinary POST /records/:id/associations ' +
          'semantics apply — no version bump, no If-Match read.',
        method: 'POST',
        path: '/records/1hk153x0000c/associations',
        requestBody: {
          changes: [
            {
              op: 'add',
              association: {
                kind: 'attachment',
                label: 'late-arrival',
                fileId: 'a1c9c3f2b6d84e0f9a7c5b3d1e8f6042a1c9c3f2b6d84e0f9a7c5b3d1e8f6042',
              },
            },
          ],
        },
        responseStatus: 200,
        responseBody: {
          id: '1hk153x0000c',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Hello', body: 'World' },
          version: 1,
          associations: [
            {
              kind: 'attachment',
              label: 'cover',
              fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
            },
            {
              kind: 'attachment',
              label: 'late-arrival',
              fileId: 'a1c9c3f2b6d84e0f9a7c5b3d1e8f6042a1c9c3f2b6d84e0f9a7c5b3d1e8f6042',
            },
          ],
        },
      },
      {
        name: 'purge-under-concurrent-write-purge-reports-both',
        description:
          "The purge that follows: its response's associations MUST name both files — the " +
          'original and the one the previous step just added — proving the body came from ' +
          'reading the record at destruction time rather than from a copy read before that step.',
        method: 'DELETE',
        path: '/records/1hk153x0000c?purge=true',
        responseStatus: 200,
        responseBody: {
          id: '1hk153x0000c',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Hello', body: 'World' },
          version: 1,
          associations: [
            {
              kind: 'attachment',
              label: 'cover',
              fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
            },
            {
              kind: 'attachment',
              label: 'late-arrival',
              fileId: 'a1c9c3f2b6d84e0f9a7c5b3d1e8f6042a1c9c3f2b6d84e0f9a7c5b3d1e8f6042',
            },
          ],
        },
      },
    ],
  },
];

export const undeleteRecordFixtures: ConformanceFixture<undefined, WireRecord>[] = [
  {
    name: 'undelete-record',
    description:
      'POST /records/:id/undelete reverses a soft delete and returns the record as it now ' +
      'stands (deletedAt absent). Idempotent — a second call returns the same result.',
    method: 'POST',
    path: '/records/1hk153x00001/undelete',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-03T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 3,
    },
  },
];

// -------------------------------------------------------
// Records: read after soft delete
// -------------------------------------------------------

/**
 * A soft delete changes what `GET /records/:id` answers, and a single pair
 * cannot pin the change: it is the same path before and after. Hidden by
 * default and returned on request, for a requester who may read the record.
 * See docs/spec/wire-format.md § Records.
 */
export const getRecordSequenceFixtures: ConformanceSequenceFixture[] = [
  {
    name: 'get-record-after-soft-delete',
    description:
      'GET /records/:id hides a soft-deleted record unless ?includeDeleted=true, as ' +
      'GET /records does. Assumes a record readable by this requester at "1hk153x00001".',
    steps: [
      {
        name: 'get-record-after-soft-delete-delete',
        description: 'The soft delete that turns the record into a tombstone.',
        method: 'DELETE',
        path: '/records/1hk153x00001',
        responseStatus: 200,
        responseBody: {
          id: '1hk153x00001',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          content: {},
          version: 2,
          deletedAt: '2024-01-02T00:00:00.000Z',
        },
      },
      {
        name: 'get-record-after-soft-delete-hidden',
        description:
          'Without includeDeleted the tombstone is "not here": 404, the same answer a missing ' +
          'or unreadable record gives.',
        method: 'GET',
        path: '/records/1hk153x00001',
        responseStatus: 404,
        responseBody: {
          error: { code: 'not_found', message: 'Record "1hk153x00001" not found.' },
        },
      },
      {
        name: 'get-record-after-soft-delete-include-deleted',
        description:
          'With ?includeDeleted=true a requester who may read the record gets the tombstone ' +
          'projection back: 200, empty content, deletedAt set.',
        method: 'GET',
        path: '/records/1hk153x00001?includeDeleted=true',
        responseStatus: 200,
        responseBody: {
          id: '1hk153x00001',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          content: {},
          version: 2,
          deletedAt: '2024-01-02T00:00:00.000Z',
        },
      },
    ],
  },
  {
    name: 'get-record-after-soft-delete-unreadable',
    description:
      'A requester with no read access to the soft-deleted record "1hk153x00002" gets 404 ' +
      "whether or not it passes ?includeDeleted=true: the flag discloses nothing the record's " +
      'own permissions would withhold. Assumes that record is soft-deleted and private to its ' +
      'owner, and that this requester holds no grant on it.',
    steps: [
      {
        name: 'get-record-after-soft-delete-unreadable-default',
        description: 'The default read of a tombstone this requester may not read: 404.',
        method: 'GET',
        path: '/records/1hk153x00002',
        responseStatus: 404,
        responseBody: {
          error: { code: 'not_found', message: 'Record "1hk153x00002" not found.' },
        },
      },
      {
        name: 'get-record-after-soft-delete-unreadable-include-deleted',
        description:
          'Opting in changes nothing for an unreadable record: the same 404, so the flag is no ' +
          'probe for guessed IDs.',
        method: 'GET',
        path: '/records/1hk153x00002?includeDeleted=true',
        responseStatus: 404,
        responseBody: {
          error: { code: 'not_found', message: 'Record "1hk153x00002" not found.' },
        },
      },
    ],
  },
];
