/**
 * @haverstack/core/adapter
 * -------------------------------------------------------
 * The interfaces a storage adapter implements — the full StackAdapter,
 * its record and blob halves, and the options Stack hands them — plus the
 * helpers adapters share. Audience: adapter implementers (see the in-repo
 * adapters). Types an app reads too, such as StackCapabilities, live in
 * the root entry point instead: every export has exactly one home.
 */

export type {
  StackAdapter,
  StackRecordAdapter,
  StackBlobAdapter,
  BlobInfo,
  SnapshotOptions,
  JournalEntryInput,
  JournalOptions,
  MutateOptions,
  AspectWriteOptions,
  ElementWriteOptions,
  Reach,
} from '../types/index.js';
export { sameAssociationSet } from '../associations/identity.js';
export { ElementSetMovedError, OwnerMismatchError, softDeletedRefusal } from '../errors.js';
export { combineAdapters } from './combine.js';
export { inReach } from './reach.js';
export type { ReachedRecord } from './reach.js';
export {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidSort,
  assertValidAssociationFilters,
  assertValidJournalQuery,
  assertValidVersionsQuery,
  filtersContent,
  parseContentFilterKey,
} from '../query-validation.js';
export {
  contentSortEntry,
  contentSortKey,
  compareSortEntries,
  constantSortEntry,
  sortConstant,
} from './sort.js';
export type { SortEntry } from './sort.js';
