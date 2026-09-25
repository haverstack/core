/**
 * @haverstack/core/adapter
 * -------------------------------------------------------
 * The interfaces a storage adapter implements — record storage, blob
 * storage, and the capabilities an adapter declares. Audience: adapter
 * implementers (see the in-repo adapters), not app or plugin code, which
 * reads `stack.features` instead of these directly.
 */

export type {
  StackRecordAdapter,
  StackBlobAdapter,
  AdapterCapabilities,
  ContentFilterReach,
  MissingCapability,
  BlobFileInfo,
  ExpectedVersionOptions,
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
  assertValidRelatedTo,
  assertValidJournalQuery,
  filtersContent,
  parseContentFilterKey,
} from './query-validation.js';
export { contentSortEntry, contentSortKey, compareSortEntries } from './sort.js';
export type { SortEntry } from './sort.js';
