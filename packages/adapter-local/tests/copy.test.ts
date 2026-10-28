/**
 * Runs @haverstack/adapter-conformance's stack copy suite with LocalAdapter,
 * the portable form a stack is exported to and imported from, on each side
 * of a copy and on both: one primitive across engines, in either direction.
 * See docs/spec/portability.md.
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCopyConformance } from '@haverstack/adapter-conformance';
import type { CreateStore, StackAdapter } from '@haverstack/core/adapter';
import { MemoryAdapter } from '@haverstack/core/testing';
import { LocalAdapter } from '../src/index.js';

const dirs = new Map<StackAdapter, string>();

const local: CreateStore = async (seed) => {
  const dir = join(tmpdir(), `copy-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const adapter = await LocalAdapter.open({ path: join(dir, 'stack.db'), seed });
  dirs.set(adapter, dir);
  return adapter;
};

const memory: CreateStore = (seed) => MemoryAdapter.open({ seed });

const close = async (adapter: StackAdapter) => {
  await adapter.close?.();
  const dir = dirs.get(adapter);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dirs.delete(adapter);
};

runCopyConformance({ name: 'LocalAdapter', create: local, close });
runCopyConformance({
  name: 'MemoryAdapter into LocalAdapter',
  create: local,
  source: memory,
  close,
});
runCopyConformance({
  name: 'LocalAdapter into MemoryAdapter',
  create: memory,
  source: local,
  close,
});
