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
  BlobFileInfo,
  ExpectedVersionOptions,
  SubscribeChangesOptions,
} from './types.js';
export { combineAdapters } from './combine.js';
export {
  assertQueryCapabilities,
  assertValidSort,
  assertValidRelatedTo,
  parseContentFilterKey,
} from './stack.js';
