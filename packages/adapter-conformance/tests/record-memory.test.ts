/**
 * Runs the record conformance suite against @haverstack/core's own
 * MemoryAdapter — proof the suite is adapter-agnostic rather than
 * implicitly SQLite-shaped, and the fastest feedback loop for changes to
 * the suite itself.
 */
import { MemoryAdapter } from '@haverstack/core/testing';
import { runRecordAdapterConformance } from '../src/record.js';

runRecordAdapterConformance({
  name: 'MemoryAdapter',
  open: () => new MemoryAdapter({ ownerEntityId: 'did:key:conformance-test' }),
  capabilities: new MemoryAdapter().capabilities,
});
