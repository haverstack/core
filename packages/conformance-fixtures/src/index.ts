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

import type { WireRecord } from '@haverstack/wire-types';

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
// All fixtures
// -------------------------------------------------------

/** Every fixture across every endpoint, for consumers that want to iterate uniformly. */
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
];
