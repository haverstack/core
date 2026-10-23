/**
 * Runs @haverstack/adapter-conformance's stack copy suite with a
 * LocalAdapter as the target: the portable form a stack is exported to
 * and imported from. See docs/spec/portability.md.
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCopyConformance } from '@haverstack/adapter-conformance';
import { LocalAdapter } from '../src/index.js';

let currentDir: string | undefined;

runCopyConformance({
  name: 'LocalAdapter',
  open: ({ ownerEntityId, timezone }) => {
    currentDir = join(tmpdir(), `copy-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(currentDir, { recursive: true });
    return LocalAdapter.open({
      create: 'exclusive',
      path: join(currentDir, 'stack.db'),
      ownerEntityId,
      timezone,
    });
  },
  close: async (adapter) => {
    await adapter.close?.();
    if (currentDir) rmSync(currentDir, { recursive: true, force: true });
  },
});
