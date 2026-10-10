/**
 * Stack — API Conformance Fixtures
 * -------------------------------------------------------
 * Request/response pairs for every record-mutation endpoint in the Stack
 * API wire format (docs/spec/wire-format.md). These pin down
 * the exact wire shape each endpoint accepts and returns — in particular,
 * that PATCH /records/:id carries a content-only merge patch, never
 * record fields like typeId/version/updatedAt.
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

import type { ConformanceFixture } from './types.js';
import { discoveryFixtures } from './discovery.js';
import {
  createRecordFixtures,
  patchContentFixtures,
  deleteRecordFixtures,
  undeleteRecordFixtures,
} from './records.js';
import { queryRecordsFixtures } from './query.js';
import {
  amendAssociationsFixtures,
  amendPermissionsFixtures,
  permissionsChangeFixtures,
  unlistedChangeFixtures,
  parentChangeFixtures,
} from './record-metadata.js';
import { getVersionsFixtures, getVersionFixtures, restoreVersionFixtures } from './versions.js';
import { getJournalFixtures } from './journal.js';
import { commitMigrationFixtures } from './migration.js';
import { installRequestFixtures } from './installs.js';
import { errorResponseFixtures } from './errors.js';
import { authChallengeFixtures, authTokenFixtures } from './auth.js';

export * from './types.js';
export * from './discovery.js';
export * from './records.js';
export * from './query.js';
export * from './record-metadata.js';
export * from './versions.js';
export * from './journal.js';
export * from './migration.js';
export * from './installs.js';
export * from './errors.js';
export * from './auth.js';
export * from './attachments.js';
export * from './change-feed.js';

/**
 * Every fixture across every endpoint, for consumers that want to iterate
 * uniformly. Excludes attachmentDownloadFixtures, attachmentUploadFixtures,
 * authSequenceFixtures, deleteRecordSequenceFixtures, getRecordSequenceFixtures,
 * getVersionsSequenceFixtures, changeFeedFixtures and
 * changeFeedSequenceFixtures — each a different shape (binary body,
 * header-focused, or an ordered series rather than a plain JSON
 * request/response pair), imported separately.
 *
 * The auth fixtures are the one group here sent with no bearer token, since
 * they are how a token is earned.
 */
export const allConformanceFixtures: ConformanceFixture[] = [
  ...discoveryFixtures,
  ...authChallengeFixtures,
  ...authTokenFixtures,
  ...createRecordFixtures,
  ...queryRecordsFixtures,
  ...patchContentFixtures,
  ...deleteRecordFixtures,
  ...undeleteRecordFixtures,
  ...amendAssociationsFixtures,
  ...amendPermissionsFixtures,
  ...permissionsChangeFixtures,
  ...unlistedChangeFixtures,
  ...parentChangeFixtures,
  ...getVersionsFixtures,
  ...getVersionFixtures,
  ...restoreVersionFixtures,
  ...getJournalFixtures,
  ...commitMigrationFixtures,
  ...installRequestFixtures,
  ...errorResponseFixtures,
];
