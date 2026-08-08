/**
 * Stack — API Conformance Fixtures
 * -------------------------------------------------------
 * Request/response pairs for every record-mutation endpoint in the Stack
 * API wire format (docs/spec.md § API Adapter Wire Format). These pin down
 * the exact wire shape each endpoint accepts and returns — in particular,
 * that PATCH /records/:id carries a content-only merge patch, never
 * record fields like typeId/version/updatedAt (see #52).
 *
 * This package is pure data: no test framework, no adapter, no server.
 * Two independent consumers exercise the same fixtures against their own
 * implementation:
 *
 *  - @haverstack/adapter-api tests that APIAdapter produces the documented
 *    request for each method call and parses the documented response.
 *  - haverstack/server (or any other server implementation) tests that its
 *    HTTP handlers accept the documented request and produce the documented
 *    response.
 *
 * A fixture is self-contained: `responseBody` reflects the state that
 * results from applying `requestBody` to whatever prior state the fixture's
 * description assumes. Fixtures don't prescribe how a server seeds that
 * prior state — that's the consumer's test setup.
 */

import type { WireRecord, WireError } from '@haverstack/wire-types';

export type WireMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ConformanceFixture<Req = unknown, Res = unknown> = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. */
  description: string;
  method: WireMethod;
  /** Request path, e.g. "/records/1hk153x00001/restore/1". */
  path: string;
  /** Request headers this call must send, beyond Authorization (omitted throughout — every fixture assumes a valid bearer token unless its description says otherwise). Absent when the endpoint has none, e.g. If-Match for the ifVersion precondition. */
  requestHeaders?: Record<string, string>;
  /** JSON request body. Absent for bodiless requests. */
  requestBody?: Req;
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body. Absent for empty (e.g. 204, or a bodyless 401) responses. */
  responseBody?: Res;
};

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
    name: 'create-attachment-record-matching-mimetype-succeeds',
    description:
      '(#65) mimeType is a property of the fileId, established by the first _attachment@1 ' +
      'record ever created for it. A second upload of the same bytes that declares a matching ' +
      'mimeType succeeds and gets its own record — its own id, entityId, and filename — rather ' +
      'than being deduplicated away. Assumes the requester is the owner (#106 restricts generic ' +
      'POST /records for _attachment@1 to owner-only — see ' +
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
      '(#106 residual decision 1) A non-owner who can already read some record referencing ' +
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
    name: 'patch-content-merges-and-adds-fields',
    description:
      'The PATCH body carries only the content patch — never typeId, version, or updatedAt. ' +
      'The server merges it against current content and assigns the new version/updatedAt itself.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'Updated title', pinned: true },
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
    requestBody: { title: null },
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

export const deleteRecordFixtures: ConformanceFixture<undefined, undefined>[] = [
  {
    name: 'delete-record-soft',
    description: 'DELETE /records/:id soft-deletes — record and version history are retained.',
    method: 'DELETE',
    path: '/records/1hk153x00001',
    responseStatus: 204,
  },
  {
    name: 'delete-record-hard',
    description: 'DELETE /records/:id?hard=true permanently removes the record and its history.',
    method: 'DELETE',
    path: '/records/1hk153x00001?hard=true',
    responseStatus: 204,
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
// Associations
// -------------------------------------------------------

export const associateFixtures: ConformanceFixture<Record<string, unknown>, undefined>[] = [
  {
    name: 'associate-tag',
    description: 'POST /records/:id/associations adds an association and bumps version.',
    method: 'POST',
    path: '/records/1hk153x00001/associations',
    requestBody: { kind: 'tag', label: 'starred' },
    responseStatus: 204,
  },
];

export const dissociateFixtures: ConformanceFixture<Record<string, unknown>, undefined>[] = [
  {
    name: 'dissociate-tag',
    description:
      'POST /records/:id/associations/delete removes an association and bumps version. POST, ' +
      'not DELETE — a DELETE request body has no defined semantics (RFC 9110 §9.3.5) and is a ' +
      'portability landmine for proxies/gateways that drop or reject it (#56).',
    method: 'POST',
    path: '/records/1hk153x00001/associations/delete',
    requestBody: { kind: 'tag', label: 'starred' },
    responseStatus: 204,
  },
];

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

export const setPermissionsFixtures: ConformanceFixture<{ permissions: unknown[] }, undefined>[] = [
  {
    name: 'set-permissions-public',
    description:
      'PUT /records/:id/permissions replaces all permissions. Body and (if returned) response ' +
      'both use the { "permissions": [...] } envelope.',
    method: 'PUT',
    path: '/records/1hk153x00001/permissions',
    requestBody: { permissions: [{ access: 'public' }] },
    responseStatus: 204,
  },
  {
    name: 'set-permissions-empty-is-private',
    description: 'An empty permissions array makes the record private (owner-only).',
    method: 'PUT',
    path: '/records/1hk153x00001/permissions',
    requestBody: { permissions: [] },
    responseStatus: 204,
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
      'content (and associations, if present) — never permissions. No request body: the ' +
      'server holds the snapshot already.',
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
];

// -------------------------------------------------------
// Migration commit
// -------------------------------------------------------

export const commitMigrationFixtures: ConformanceFixture<
  { toTypeId: string; content: Record<string, unknown> },
  WireRecord
>[] = [
  {
    name: 'commit-migration',
    description:
      'POST /records/:id/migrate is the only way typeId changes after creation. Body carries ' +
      "the full post-migration content (computed client-side by the type's owning app); the " +
      "server validates it against toTypeId's schema before writing.",
    method: 'POST',
    path: '/records/1hk153x00001/migrate',
    requestBody: { toTypeId: 'com.example/note@2', content: { title: 'Hello', pinned: false } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@2',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-05T00:00:00.000Z',
      content: { title: 'Hello', pinned: false },
      version: 5,
    },
  },
];

// -------------------------------------------------------
// Error responses
// -------------------------------------------------------
//
// Pins the wire error body contract (#53): every failed request returns
// { error: { code, message, details? } }, with `code` as the authoritative
// discriminator — status is a transport hint. Each fixture assumes the
// server is already in the state its description names (a missing record,
// a requester without a grant, ...); these fixtures pin the error shape a
// server must produce and APIAdapter must reconstruct, not how a server
// gets into that state.
//
// One exception: 401 has no wire error body (see error-unauthorized-
// anonymous) — it fires before any DID has verified, so there's no core
// error to serialize yet. `responseBody` is absent for that fixture only.

export const errorResponseFixtures: ConformanceFixture<unknown, WireError>[] = [
  {
    name: 'error-permission-denied',
    description:
      'A write from a requester without the required grant on the record returns 403 with ' +
      'code "permission" — reconstructed client-side as StackPermissionError.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'New title' },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-permission-denied-attachment-non-owner-create',
    description:
      '(#106) POST /records creating an _attachment@1 record is refused for any non-owner ' +
      'requester with 403 / code "permission" — even one holding an otherwise-sufficient ' +
      '"create" grant on the type, and even for a fileId nobody has ever uploaded or referenced. ' +
      'This is not the ordinary missing-grant case (see error-permission-denied): _attachment@1 ' +
      'is access-conveying, and generic create() accepts a caller-supplied fileId with no proof ' +
      'it was ever derived from real bytes, unlike POST /attachments (see Attachments), which ' +
      'computes fileId from bytes it just hashed. Non-owners must use POST /attachments instead. ' +
      'Owner requests for the same body succeed (see create-attachment-record-matching-mimetype-' +
      'succeeds, which assumes an owner requester).',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06007',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: 'd4dc2868d42528f18d9907a239e378564e4106c796f252424a05c9c850089e41',
        mimeType: 'image/png',
        size: 12345,
      },
      version: 1,
    },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'create-attachment-record-non-owner-without-carve-out-refused',
    description:
      '(#106 residual decision 1) The carve-out (see ' +
      'create-attachment-record-non-owner-carve-out-succeeds) is satisfied only by a readable ' +
      "record referencing the fileId — never by the requester's own prior _attachment@1 record " +
      'for the same fileId (the "uploaded it themselves" clause of the getAttachment() access ' +
      'rule). Allowing that would let one successful guess bootstrap unlimited further metadata ' +
      'records for the same fileId, reintroducing the circularity #106 closes. Assumes the ' +
      'requester already holds an _attachment@1 record for "fileId": "d56b0d4d2c35d9d856d06702a6cc4482d4fedbea54a083cfb56cf19bea35d94f" (e.g. from a ' +
      'prior putAttachment() upload) but no readable record references it.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x07008',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: 'd56b0d4d2c35d9d856d06702a6cc4482d4fedbea54a083cfb56cf19bea35d94f',
        mimeType: 'image/png',
        size: 1,
        filename: 'second-name.png',
      },
      version: 1,
    },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-not-found',
    description:
      'A write (e.g. PATCH) against a record id that does not exist — deleted or never ' +
      'created — returns 404 with code "not_found", reconstructed as StackNotFoundError. ' +
      '(GET /records/:id is deliberately excluded here: APIAdapter treats a 404 there as ' +
      '"absent", resolving to null rather than throwing — see nullOn404 in getRecord.) Must be ' +
      'indistinguishable from the "exists but forbidden" case only in error *shape*, never in ' +
      'status/code (see #51 anti-oracle rule).',
    method: 'PATCH',
    path: '/records/1hk153x0a00b',
    requestBody: { title: 'New title' },
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "1hk153x0a00b" not found.' },
    },
  },
  {
    name: 'error-conflict-duplicate-id',
    description:
      'POST /records with a client-supplied id that already exists in the stack returns 409 ' +
      'with code "conflict" — reconstructed as StackConflictError, never a silent overwrite.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Duplicate' },
      version: 1,
    },
    responseStatus: 409,
    responseBody: { error: { code: 'conflict', message: 'Record "1hk153x00001" already exists.' } },
  },
  {
    name: 'error-validation-failed',
    description:
      'PATCH content that fails the target type schema returns 422 with code "validation" and ' +
      'field-level details — reconstructed as StackValidationError, with `details` populating ' +
      '`.errors`.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 42 },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'title', message: 'expected string, got number' }],
      },
    },
  },
  {
    name: 'error-validation-failed-restore',
    description:
      'POST /records/:id/restore/:version against a drifted or corrupted snapshot — content ' +
      'that no longer satisfies the schema of the type it claims — returns 422 with code ' +
      '"validation", identically to a PATCH validation failure. Restore is not a backdoor ' +
      'around schema validation (#62): the snapshot is validated against its own stored ' +
      "typeId, not the record's current one.",
    method: 'POST',
    path: '/records/1hk153x00001/restore/1',
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'title', message: 'expected string, got number' }],
      },
    },
  },
  {
    name: 'error-validation-attachment-mimetype-conflict-on-create',
    description:
      '(#65, message genericized by #106) POST /records creating an _attachment@1 record whose ' +
      'mimeType conflicts with the mimeType already established (by the first-ever record) for ' +
      'the same fileId returns 422 with code "validation" — reconstructed as ' +
      'StackValidationError. A matching mimeType would instead succeed (see ' +
      'create-attachment-record-matching-mimetype-succeeds). The message never names the ' +
      "established mimeType (anti-oracle, #106): stating it would confirm an existing fileId's " +
      'content type to a caller who only guessed the fileId. Assumes the requester is the owner ' +
      '(non-owner POST /records for _attachment@1 is refused outright — see ' +
      'error-permission-denied-attachment-non-owner-create) and that an _attachment@1 record ' +
      'already exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with "mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x04005',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'text/html',
        size: 12345,
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'mimeType',
            message: 'mimeType conflicts with the mimeType already established for this fileId',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-attachment-mimetype-immutable-on-update',
    description:
      '(#65) PATCH /records/:id against an _attachment@1 record is rejected with 422 / code ' +
      '"validation" if the patch touches mimeType at all — even restating the current value. ' +
      'filename is the only field an _attachment@1 update may change; fileId and size are ' +
      'rejected the same way if the patch would actually change their stored value.',
    method: 'PATCH',
    path: '/records/1hk153x02003',
    requestBody: { mimeType: 'image/jpeg' },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'mimeType',
            message: 'mimeType is immutable after creation; delete and re-upload to change it',
          },
        ],
      },
    },
  },
  {
    name: 'error-bad-request-malformed-cursor',
    description:
      'A query with an undecodable pagination cursor returns 400 with code "bad_request" — a ' +
      'structurally malformed request, distinct from a 422 content-validation failure. ' +
      'Reconstructed as StackQueryError. (#115 D3) "not-a-valid-cursor" is not valid base64 ' +
      "(the hyphens aren't in the alphabet), so decoding fails before the sort-field is ever " +
      'inspected — the message names the malformed input itself, not a sort field. See ' +
      'error-bad-request-unknown-sort-field-cursor for the distinct, decodable-but-invalid case.',
    method: 'POST',
    path: '/records/query',
    requestBody: { cursor: 'not-a-valid-cursor' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: malformed "not-a-valid-cursor"',
      },
    },
  },
  {
    name: 'error-bad-request-unknown-sort-field-cursor',
    description:
      '(#115 D3) A cursor that decodes cleanly as base64 but names a sort field the server ' +
      "doesn't recognize is a second, distinct 400 bad_request branch from the malformed-" +
      'base64 case above (see error-bad-request-malformed-cursor) — both map to the same code, ' +
      'but a server that only implements one of the two decode failures is only half-conformant. ' +
      'The cursor here is the base64 encoding of "badfield|123|1hk153x00001".',
    method: 'POST',
    path: '/records/query',
    requestBody: { cursor: 'YmFkZmllbGR8MTIzfDFoazE1M3gwMDAwMQ==' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: unknown sort field "badfield"',
      },
    },
  },

  // -- #115 D2: fixtures for contracts decided since #52/#53, previously unpinned --

  {
    name: 'error-version-conflict-if-match-mismatch',
    description:
      '(#48) PATCH /records/:id with an If-Match header whose value does not match the ' +
      'record\'s current version returns 412 with code "version_conflict" — reconstructed as ' +
      'StackVersionConflictError. The versionConflict payload (recordId/expectedVersion/' +
      'actualVersion) is exactly what an ifVersion retry loop needs: which record, what it ' +
      'expected, what actually won the race. Deliberately not 409 / "conflict": the two error ' +
      'types have different recovery stories (fix your input vs. re-read and retry) and get ' +
      'distinct statuses so status-only reconstruction (no parseable body) still recovers the ' +
      'precise error. Assumes the record is currently at version 7.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestHeaders: { 'If-Match': '"5"' },
    requestBody: { title: 'New title' },
    responseStatus: 412,
    responseBody: {
      error: {
        code: 'version_conflict',
        message: 'Record "1hk153x00001" is at version 7, expected 5',
        versionConflict: { recordId: '1hk153x00001', expectedVersion: 5, actualVersion: 7 },
      },
    },
  },
  {
    name: 'error-schema-drift-non-additive-redefinition',
    description:
      '(#68) POST /types on an id that already has a stored Type runs the same drift check as ' +
      'Stack.defineType(): a schema-hash mismatch is only legal if the change is purely ' +
      'additive (new optional fields, recursively, nothing removed/retyped/newly-required). ' +
      "Changing an existing field's kind is not additive, so this returns 409 with code " +
      '"schema_drift" — reconstructed as StackSchemaDriftError — never a silent REPLACE of the ' +
      'stored definition. The duplicate-id 409 (code "conflict") and this one deliberately share ' +
      'a status but not a code (#115 D2) — status-only reconstruction of a bodyless 409 degrades ' +
      'to the generic StackConflictError; only a parseable body recovers this specific class. ' +
      'Assumes "com.example/note@1" is already stored with { title: { kind: "string", ' +
      'required: true } }.',
    method: 'POST',
    path: '/types',
    requestBody: {
      id: 'com.example/note@1',
      baseId: 'com.example/note',
      version: 1,
      name: 'Note',
      schema: { title: { kind: 'number', required: true } },
      schemaHash: 'b2c9f7a1e6d4805c3f19a8e2b7d6c4a1908f5e3d2c1b0a9f8e7d6c5b4a392817',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'schema_drift',
        message:
          'Schema drift detected for type "com.example/note@1": the stored schema and the new ' +
          'definition differ beyond additive evolution (new optional fields only). Bump the ' +
          'version instead of redefining "com.example/note@1" in place.',
        schemaDrift: {
          typeId: 'com.example/note@1',
          violations: [{ path: 'title', message: 'field kind changed from "string" to "number"' }],
        },
      },
    },
  },
  {
    name: 'error-bad-request-id-invalid-charset',
    description:
      '(#55, #115 D2) POST /records with a client-supplied id containing a character outside ' +
      'lowercase Crockford base-32 (0-9, a-z excluding i/l/o/u) returns 400 with code ' +
      '"bad_request" — structurally malformed input, not a 422 content-validation failure (the ' +
      'id never reaches type-schema validation). Reconstructed as StackQueryError.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x0000!',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid ID "1hk153x0000!": expected 12 lowercase Crockford base-32 characters.',
      },
    },
  },
  {
    name: 'error-bad-request-id-invalid-length',
    description:
      '(#55, #115 D2) POST /records with a client-supplied id that is not exactly 12 characters ' +
      'returns 400 with code "bad_request", the same structural-malformed-input class as the ' +
      'invalid-charset case above.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: 'short-id',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid ID "short-id": expected 12 lowercase Crockford base-32 characters.',
      },
    },
  },
  {
    name: 'error-bad-request-id-reserved-prefix',
    description:
      '(#55, #115 D2) POST /records with a client-supplied id beginning with "_" returns 400 ' +
      'with code "bad_request" — that namespace is reserved for system records (_config, ' +
      '_entity, ...). Checked before the charset/length check (the Crockford alphabet already ' +
      'excludes "_", so a reserved-looking id would otherwise fail as a generic format error ' +
      'instead of this specific, actionable one). The duplicate-id 409 case (error-conflict-' +
      'duplicate-id) is unaffected — this is about ids that were never legal to submit at all.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '_hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'ID "_hk153x00001" uses the reserved "_" prefix.',
      },
    },
  },
  {
    name: 'error-conflict-delete-config',
    description:
      '(#67, #115 D2) DELETE /records/_config — soft or hard — is always refused with 409 / ' +
      'code "conflict": _config holds the stack\'s identity (ownerEntityId, read at open and ' +
      'consulted by every permission check) and deleting it either bricks the stack (hard) or ' +
      'makes it unreadable through normal paths (soft). Reconstructed as StackConflictError.',
    method: 'DELETE',
    path: '/records/_config',
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          "Cannot delete the _config record: it holds the stack's identity and is required " +
          'for every permission check.',
      },
    },
  },
  {
    name: 'error-conflict-config-entityid-change',
    description:
      '(#67, #115 D2) PATCH /records/_config that would change entityId returns 409 / code ' +
      '"conflict" — entityId defines stack ownership, read once at open and consulted by every ' +
      'permission check thereafter; a write that silently re-anchored it would desync every ' +
      'already-running owner check. Other _config fields (e.g. timezone) update normally through ' +
      'the same endpoint — only an entityId change is refused.',
    method: 'PATCH',
    path: '/records/_config',
    requestBody: { entityId: 'did:key:z6MkvVv7EXm3g3XZ8k4hqYqK5zqfSj6pS4KvL5s6cQzYzZq3' },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          'Cannot change _config.entityId: it defines stack ownership. Ownership transfer is ' +
          'not a supported operation.',
      },
    },
  },
  {
    name: 'error-unauthorized-anonymous',
    description:
      '(#49, #115 D2) A request with no bearer token, or an invalid/expired one, returns 401 ' +
      'with no wire error body at all — there is no verified DID behind the request at all ' +
      '("who are you?"). This is distinct from error-permission-denied\'s 403, which means the ' +
      "requester's DID *did* verify but their permissions/grants don't cover the operation " +
      '("your claim is genuine; no") — a server must keep the two statuses apart, never collapse ' +
      'unverified and verified-but-ungranted into one. Unlike every other code in this file, 401 ' +
      'carries no JSON body: APIAdapter checks response status before ever attempting to parse ' +
      'one, and reconstructs APIAdapterAuthError from status alone.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'New title' },
    responseStatus: 401,
  },
];

// -------------------------------------------------------
// Attachment download: dangerous-type forcing (#66)
// -------------------------------------------------------
//
// GET /attachments/:fileId doesn't fit ConformanceFixture: there's no JSON
// request or response body (it's a binary download), and what's actually
// being pinned here is response *headers* — Content-Type, Content-
// Disposition, and X-Content-Type-Options — not a body shape. Hence a
// separate, narrower fixture type.
//
// The candidate Content-Type is computed source-by-source (?contentType,
// then extension inference from ?filename, then the stored _attachment@1
// mimeType, then application/octet-stream) and the safe-list is applied to
// *that result*, never to the source — so each fixture below pins one
// (source, type) pair, and forcing must catch the dangerous ones
// regardless of which source produced them. See
// resolveAttachmentDownloadContentType() in @haverstack/core, which is the
// canonical implementation of this same table.

export type AttachmentDownloadFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. Also states any assumed prior state (e.g. an existing _attachment@1 record), since GET takes no body. */
  description: string;
  /** Request path including query string, e.g. "/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=text/html". */
  path: string;
  /** Response headers this GET must produce. Only the headers a fixture pins are listed here; anything else about the response is unconstrained by it. */
  responseHeaders: Record<string, string>;
};

const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' };

export const attachmentDownloadFixtures: AttachmentDownloadFixture[] = [
  {
    name: 'attachment-download-contenttype-param-safe-passes-through',
    description: 'A safe ?contentType is served as given.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=image/png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-contenttype-param-dangerous-forced',
    description:
      'A dangerous ?contentType is forced to application/octet-stream — the one case the ' +
      'pre-#66 spec already covered, kept here so the full three-source matrix is in one place.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=text/html',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-filename-extension-safe-passes-through',
    description:
      'With no ?contentType, a safe type inferred from the ?filename extension is served as given.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?filename=photo.png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-filename-extension-dangerous-forced',
    description:
      '(#66) With no ?contentType, a dangerous type inferred from the ?filename extension must ' +
      "still be forced — this was the spec's silent gap: extension inference had no forcing " +
      'language at all, so `?filename=payload.html` was the unhardened path into the same XSS ' +
      'this policy exists to prevent.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?filename=payload.html',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-stored-mimetype-safe-passes-through',
    description:
      'With no query params, a safe stored _attachment@1 mimeType is served as given. Assumes ' +
      'an _attachment@1 record exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with "mimeType": "image/png".',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-stored-mimetype-dangerous-forced',
    description:
      '(#66) With no query params, a dangerous stored mimeType must still be forced — this was ' +
      "the spec's other silent gap, and the one #65's escalation scenario depends on: a lying " +
      'or dishonest _attachment@1 record must not reach the response header unforced just ' +
      'because it came from storage rather than a query param. Assumes an _attachment@1 record ' +
      'exists for "fileId": "0c313c16bde1bf6c37ad8f2d64caa1eda306cb566a19f9bf74a94e69ca46a737" with "mimeType": "text/html".',
    path: '/attachments/0c313c16bde1bf6c37ad8f2d64caa1eda306cb566a19f9bf74a94e69ca46a737',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-no-metadata-defaults-to-octet-stream',
    description:
      'With no query params and no _attachment@1 record for the fileId, the response falls ' +
      'back to application/octet-stream — already the safe default, so unforced in the sense ' +
      'that nothing needed overriding, but nosniff is still present.',
    path: '/attachments/55e6bec88d703985030c5822286b105ead73d7bb8ffa1927a28a69e3acd0ba2a',
    responseHeaders: { 'Content-Type': 'application/octet-stream', ...NOSNIFF },
  },
];

// -------------------------------------------------------
// Attachment upload: POST /attachments creates the record (#106)
// -------------------------------------------------------
//
// Like attachmentDownloadFixtures, POST /attachments doesn't fit
// ConformanceFixture: the request body is raw bytes, not JSON. What's
// pinned here is the request Content-Type/Content-Disposition headers going
// in and the created _attachment@1 record coming out — the wire shape of
// the combined, non-owner-safe upload primitive described in the spec's
// Attachments section. This is not an efficiency shortcut: fileId must be
// established from bytes the server actually received in this request, so
// there is no seam where a caller-supplied string could substitute for
// them (see error-permission-denied-attachment-non-owner-create, which
// pins the generic-create path this closes).

export type AttachmentUploadFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. */
  description: string;
  /** Request headers this POST must send. Authorization is omitted — every fixture here assumes a valid bearer token for the described requester. */
  requestHeaders: Record<string, string>;
  /** Raw request body bytes, as an array of byte values (0-255), so the fixture stays plain data with no binary encoding. */
  requestBodyBytes: number[];
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body: the created _attachment@1 record, or a WireError. */
  responseBody: WireRecord | WireError;
};

// SHA-256 of the byte sequence below (the ASCII string "hello").
const HELLO_FILE_ID = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const HELLO_BYTES = [104, 101, 108, 108, 111];

export const attachmentUploadFixtures: AttachmentUploadFixture[] = [
  {
    name: 'attachment-upload-creates-metadata-record',
    description:
      '(#106) POST /attachments carries Content-Type and Content-Disposition (filename) and ' +
      'stores the bytes and creates the _attachment@1 record in the same request — the wire ' +
      'counterpart of ScopedStack.putAttachment()/Stack.putAttachment(). The response is the ' +
      'created record (same shape as POST /records), not just { fileId }. fileId is the SHA-256 ' +
      'hex hash of the request body.',
    requestHeaders: {
      'Content-Type': 'text/plain',
      'Content-Disposition': "attachment; filename*=UTF-8''hello.txt",
    },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 200,
    responseBody: {
      id: '1hk153x08009',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: HELLO_FILE_ID,
        mimeType: 'text/plain',
        size: HELLO_BYTES.length,
        filename: 'hello.txt',
      },
      version: 1,
    },
  },
  {
    name: 'attachment-upload-no-content-type-defaults-to-octet-stream',
    description:
      '(#106) Content-Type is optional on upload — when omitted, the server defaults the ' +
      "created record's mimeType to application/octet-stream rather than rejecting the request, " +
      'matching the download-side default (see attachment-download-no-metadata-defaults-to-' +
      'octet-stream).',
    requestHeaders: {},
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 200,
    responseBody: {
      id: '1hk153x0900a',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: HELLO_FILE_ID,
        mimeType: 'application/octet-stream',
        size: HELLO_BYTES.length,
      },
      version: 1,
    },
  },
  {
    name: 'attachment-upload-non-owner-without-create-grant-forbidden',
    description:
      'POST /attachments requires the same authorization as creating an _attachment@1 record: ' +
      '403 / code "permission" if the requester lacks a create grant on _attachment@1. Unlike ' +
      'generic POST /records (see error-permission-denied-attachment-non-owner-create), a ' +
      'non-owner *with* a create grant succeeds here — that grant is exactly what makes this the ' +
      'sanctioned non-owner path.',
    requestHeaders: { 'Content-Type': 'text/plain' },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'attachment-upload-payload-too-large',
    description:
      "(#114 C4) A body exceeding the server's configured MAX_ATTACHMENT_BYTES ceiling " +
      '(exposed ahead of time as maxAttachmentBytes in discovery — see docs/spec.md §Discovery) ' +
      'returns 413 with code "payload_too_large" — reconstructed client-side as ' +
      'StackPayloadTooLargeError. 413 is unambiguous (no other wire code shares it), so this is ' +
      'also recoverable from status alone when the response has no parseable body — e.g. a ' +
      "reverse proxy's own request-entity-too-large page in front of the server. The request " +
      'body below stands in for one that exceeds the ceiling; the fixture pins the error shape, ' +
      'not a specific size.',
    requestHeaders: { 'Content-Type': 'text/plain' },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 413,
    responseBody: {
      error: { code: 'payload_too_large', message: 'Attachment exceeds the server size limit' },
    },
  },
];

// -------------------------------------------------------
// All fixtures
// -------------------------------------------------------

/**
 * Every fixture across every endpoint, for consumers that want to iterate
 * uniformly. Excludes attachmentDownloadFixtures and attachmentUploadFixtures
 * — both a different shape (binary body and/or header-focused, not a plain
 * JSON request/response pair), imported separately.
 */
export const allConformanceFixtures: ConformanceFixture[] = [
  ...createRecordFixtures,
  ...patchContentFixtures,
  ...deleteRecordFixtures,
  ...undeleteRecordFixtures,
  ...associateFixtures,
  ...dissociateFixtures,
  ...setPermissionsFixtures,
  ...restoreVersionFixtures,
  ...commitMigrationFixtures,
  ...errorResponseFixtures,
];
