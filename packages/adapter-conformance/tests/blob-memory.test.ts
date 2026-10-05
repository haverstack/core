/**
 * Runs the blob conformance suite against MemoryAdapter's blob half —
 * MemoryAdapter implements the full StackAdapter, blob storage included.
 */
import { MemoryAdapter } from '@haverstack/core/testing';
import { runBlobAdapterConformance } from '../src/blob.js';

runBlobAdapterConformance({
  name: 'MemoryAdapter',
  open: () => MemoryAdapter.open({ ownerEntityId: 'did:key:test' }),
  listBlobs: true,
});
