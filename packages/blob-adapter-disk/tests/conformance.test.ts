/**
 * Runs @haverstack/adapter-conformance's blob suite against this package's
 * own adapter — the same suite a third-party blob adapter author would
 * run against theirs.
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runBlobAdapterConformance } from '@haverstack/adapter-conformance';
import { DiskBlobAdapter } from '../src/index.js';

let currentDir: string | undefined;

runBlobAdapterConformance({
  name: 'DiskBlobAdapter',
  listFiles: true,
  open: () => {
    currentDir = join(
      tmpdir(),
      `conformance-blob-disk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(currentDir, { recursive: true });
    return new DiskBlobAdapter(currentDir);
  },
  close: () => {
    if (currentDir) rmSync(currentDir, { recursive: true, force: true });
  },
});
