/**
 * Runs @haverstack/adapter-conformance's record suite against this
 * package's own adapter — this is what an adapter author does with the
 * shared suite, applied here first so this package dogfoods it alongside
 * MemoryAdapter and IncapableMemoryAdapter (the suite's own self-tests).
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRecordAdapterConformance } from '@haverstack/adapter-conformance';
import { SQLITE_RECORD_CAPABILITIES } from '@haverstack/sqlite-shared';
import { NativeSQLiteRecordAdapter } from '../src/index.js';

let currentDir: string | undefined;

runRecordAdapterConformance({
  name: 'NativeSQLiteRecordAdapter',
  capabilities: SQLITE_RECORD_CAPABILITIES,
  open: () => {
    currentDir = join(
      tmpdir(),
      `conformance-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(currentDir, { recursive: true });
    return NativeSQLiteRecordAdapter.initialize({
      path: join(currentDir, 'test.db'),
      entityId: 'did:key:conformance-test',
    });
  },
  close: async (adapter) => {
    await adapter.close?.();
    if (currentDir) rmSync(currentDir, { recursive: true, force: true });
  },
});
