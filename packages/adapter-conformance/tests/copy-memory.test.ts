/**
 * Runs the stack copy suite against @haverstack/core's own MemoryAdapter,
 * so the suite itself is checked where it is fastest.
 */
import { MemoryAdapter } from '@haverstack/core/testing';
import { runCopyConformance } from '../src/copy.js';

runCopyConformance({
  name: 'MemoryAdapter',
  create: (seed) => MemoryAdapter.open({ seed }),
});
