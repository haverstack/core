/**
 * Runs the record conformance suite against IncapableMemoryAdapter — an
 * adapter declaring filter.content/search/sort.contentField all off. Proves
 * the capability-gated suites (content filtering, content-field sort,
 * full-text search) don't run at all here rather than failing, while the
 * always-on suites (CRUD, versions, cursor pagination, associations, the
 * `_config` singleton) still do.
 */
import { IncapableMemoryAdapter } from '@haverstack/core/testing';
import { runRecordAdapterConformance } from '../src/record.js';

runRecordAdapterConformance({
  name: 'IncapableMemoryAdapter',
  open: () => new IncapableMemoryAdapter({ ownerEntityId: 'did:key:conformance-test' }),
  capabilities: new IncapableMemoryAdapter().capabilities,
});
