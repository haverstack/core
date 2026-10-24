/**
 * Runs @haverstack/adapter-conformance's stack copy suite against
 * LocalAdapter: the portable form a stack is exported to and imported
 * from. See docs/spec/portability.md.
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCopyConformance } from '@haverstack/adapter-conformance';
import type { StackAdapter } from '@haverstack/core/adapter';
import { LocalAdapter } from '../src/index.js';

const dirs = new Map<StackAdapter, string>();

runCopyConformance({
  name: 'LocalAdapter',
  create: async ({ ownerEntityId, timezone }) => {
    const dir = join(tmpdir(), `copy-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const adapter = await LocalAdapter.open({
      create: 'exclusive',
      path: join(dir, 'stack.db'),
      ownerEntityId,
      timezone,
    });
    dirs.set(adapter, dir);
    return adapter;
  },
  close: async (adapter) => {
    await adapter.close?.();
    rmSync(dirs.get(adapter)!, { recursive: true, force: true });
    dirs.delete(adapter);
  },
});
