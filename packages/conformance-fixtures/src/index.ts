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
  /** Request path, e.g. "/records/rec-1/restore/1". */
  path: string;
  /** JSON request body. Absent for bodiless requests. */
  requestBody?: Req;
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body. Absent for empty (e.g. 204) responses. */
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
      id: 'rec-1',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: 'rec-1',
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
      'than being deduplicated away. Assumes an _attachment@1 record already exists for ' +
      '"fileId": "abc123..." with "mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: 'rec-attachment-2',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { fileId: 'abc123', mimeType: 'image/png', size: 12345, filename: 'second.png' },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: 'rec-attachment-2',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { fileId: 'abc123', mimeType: 'image/png', size: 12345, filename: 'second.png' },
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
    path: '/records/rec-1',
    requestBody: { title: 'Updated title', pinned: true },
    responseStatus: 200,
    responseBody: {
      id: 'rec-1',
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
    path: '/records/rec-2',
    requestBody: { title: null },
    responseStatus: 200,
    responseBody: {
      id: 'rec-2',
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
    path: '/records/rec-1',
    responseStatus: 204,
  },
  {
    name: 'delete-record-hard',
    description: 'DELETE /records/:id?hard=true permanently removes the record and its history.',
    method: 'DELETE',
    path: '/records/rec-1?hard=true',
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
    path: '/records/rec-1/undelete',
    responseStatus: 200,
    responseBody: {
      id: 'rec-1',
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
    path: '/records/rec-1/associations',
    requestBody: { kind: 'tag', label: 'starred' },
    responseStatus: 204,
  },
];

export const dissociateFixtures: ConformanceFixture<Record<string, unknown>, undefined>[] = [
  {
    name: 'dissociate-tag',
    description: 'DELETE /records/:id/associations removes an association and bumps version.',
    method: 'DELETE',
    path: '/records/rec-1/associations',
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
    path: '/records/rec-1/permissions',
    requestBody: { permissions: [{ access: 'public' }] },
    responseStatus: 204,
  },
  {
    name: 'set-permissions-empty-is-private',
    description: 'An empty permissions array makes the record private (owner-only).',
    method: 'PUT',
    path: '/records/rec-1/permissions',
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
    path: '/records/rec-1/restore/1',
    responseStatus: 200,
    responseBody: {
      id: 'rec-1',
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
    path: '/records/rec-1/migrate',
    requestBody: { toTypeId: 'com.example/note@2', content: { title: 'Hello', pinned: false } },
    responseStatus: 200,
    responseBody: {
      id: 'rec-1',
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

export const errorResponseFixtures: ConformanceFixture<unknown, WireError>[] = [
  {
    name: 'error-permission-denied',
    description:
      'A write from a requester without the required grant on the record returns 403 with ' +
      'code "permission" — reconstructed client-side as StackPermissionError.',
    method: 'PATCH',
    path: '/records/rec-1',
    requestBody: { title: 'New title' },
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
    path: '/records/rec-does-not-exist',
    requestBody: { title: 'New title' },
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "rec-does-not-exist" not found.' },
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
      id: 'rec-1',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Duplicate' },
      version: 1,
    },
    responseStatus: 409,
    responseBody: { error: { code: 'conflict', message: 'Record "rec-1" already exists.' } },
  },
  {
    name: 'error-validation-failed',
    description:
      'PATCH content that fails the target type schema returns 422 with code "validation" and ' +
      'field-level details — reconstructed as StackValidationError, with `details` populating ' +
      '`.errors`.',
    method: 'PATCH',
    path: '/records/rec-1',
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
    path: '/records/rec-1/restore/1',
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
      '(#65) POST /records creating an _attachment@1 record whose mimeType conflicts with the ' +
      'mimeType already established (by the first-ever record) for the same fileId returns 422 ' +
      'with code "validation" — reconstructed as StackValidationError. A matching mimeType ' +
      'would instead succeed (see create-attachment-record-matching-mimetype-succeeds). Assumes ' +
      'an _attachment@1 record already exists for "fileId": "abc123..." with ' +
      '"mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: 'rec-attachment-3',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { fileId: 'abc123', mimeType: 'text/html', size: 12345 },
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
            message:
              'mimeType "text/html" conflicts with the mimeType "image/png" already ' +
              'established for fileId "abc123" by an earlier upload',
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
    path: '/records/rec-attachment-1',
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
      'Reconstructed as StackQueryError (see the cursor codec fix in record-adapter-sqljs, #53).',
    method: 'POST',
    path: '/records/query',
    requestBody: { cursor: 'not-a-valid-cursor' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: unknown sort field "not-a-valid-cursor"',
      },
    },
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
  /** Request path including query string, e.g. "/attachments/abc123?contentType=text/html". */
  path: string;
  /** Response headers this GET must produce. Only the headers a fixture pins are listed here; anything else about the response is unconstrained by it. */
  responseHeaders: Record<string, string>;
};

const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' };

export const attachmentDownloadFixtures: AttachmentDownloadFixture[] = [
  {
    name: 'attachment-download-contenttype-param-safe-passes-through',
    description: 'A safe ?contentType is served as given.',
    path: '/attachments/abc123?contentType=image/png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-contenttype-param-dangerous-forced',
    description:
      'A dangerous ?contentType is forced to application/octet-stream — the one case the ' +
      'pre-#66 spec already covered, kept here so the full three-source matrix is in one place.',
    path: '/attachments/abc123?contentType=text/html',
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
    path: '/attachments/abc123?filename=photo.png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-filename-extension-dangerous-forced',
    description:
      '(#66) With no ?contentType, a dangerous type inferred from the ?filename extension must ' +
      "still be forced — this was the spec's silent gap: extension inference had no forcing " +
      'language at all, so `?filename=payload.html` was the unhardened path into the same XSS ' +
      'this policy exists to prevent.',
    path: '/attachments/abc123?filename=payload.html',
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
      'an _attachment@1 record exists for "fileId": "abc123" with "mimeType": "image/png".',
    path: '/attachments/abc123',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-stored-mimetype-dangerous-forced',
    description:
      '(#66) With no query params, a dangerous stored mimeType must still be forced — this was ' +
      "the spec's other silent gap, and the one #65's escalation scenario depends on: a lying " +
      'or dishonest _attachment@1 record must not reach the response header unforced just ' +
      'because it came from storage rather than a query param. Assumes an _attachment@1 record ' +
      'exists for "fileId": "def456" with "mimeType": "text/html".',
    path: '/attachments/def456',
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
    path: '/attachments/no-metadata-file',
    responseHeaders: { 'Content-Type': 'application/octet-stream', ...NOSNIFF },
  },
];

// -------------------------------------------------------
// All fixtures
// -------------------------------------------------------

/**
 * Every fixture across every endpoint, for consumers that want to iterate
 * uniformly. Excludes attachmentDownloadFixtures — a different shape
 * (response headers, not a JSON body), imported separately.
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
