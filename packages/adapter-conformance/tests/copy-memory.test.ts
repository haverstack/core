/**
 * Runs the stack copy suite with @haverstack/core's own MemoryAdapter as
 * the target, so the suite's own round trip is checked where it is fastest.
 */
import { MemoryAdapter } from '@haverstack/core/testing';
import { runCopyConformance } from '../src/copy.js';

runCopyConformance({
  name: 'MemoryAdapter',
  open: ({ ownerEntityId, timezone }) => MemoryAdapter.open({ ownerEntityId, timezone }),
});
