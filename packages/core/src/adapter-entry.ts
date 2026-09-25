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
  BumpVersionOptions,
  SnapshotOptions,
  JournalEntryInput,
  JournalOptions,
  SubscribeChangesOptions,
} from './types.js';
export { combineAdapters } from './combine.js';
export {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidSort,
  assertValidAssociationFilters,
  assertValidJournalQuery,
  filtersContent,
  parseContentFilterKey,
} from './query-validation.js';
export { contentSortEntry, contentSortKey, compareSortEntries } from './sort.js';
export type { SortEntry } from './sort.js';
