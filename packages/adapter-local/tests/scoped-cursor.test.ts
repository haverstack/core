import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Stack } from '@haverstack/core';
import { LocalAdapter } from '../src/index.js';

// The SQLite cursor carries the sort value of the last record a page
// scanned. A scoped query scans records its requester cannot read, so what
// it hands back must carry none of theirs.
// See docs/spec/disclosure.md § Scoped cursors are sealed.

const SECRET = 'com.example.test/secret@1';

let dir: string;
let stack: Stack;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scoped-cursor-'));
  const adapter = await LocalAdapter.open({
    create: 'exclusive',
    path: join(dir, 'stack.db'),
    ownerEntityId: 'did:key:owner',
  });
  stack = await Stack.open(adapter);
  await stack.defineType({ id: SECRET, name: 'Secret', schema: { code: { kind: 'string' } } });
  for (let i = 0; i < 20; i++) await stack.create(SECRET, { code: `code-${i}` });
});

afterEach(async () => {
  await stack.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a scoped content-sorted cursor carries no value of a record the requester cannot read', async () => {
  const page = await stack.asEntity(null).query({
    filter: { typeId: SECRET },
    sort: { contentField: 'code' },
    limit: 1,
  });
  expect(page.records).toEqual([]);
  expect(page.cursor).not.toBeNull();
  const decoded = Buffer.from(page.cursor!, 'base64url').toString('latin1');
  expect(decoded).not.toContain('code-');
  expect(decoded).not.toContain('"i"');
});
