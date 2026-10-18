import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { StackBadRequestError, StackConflictError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { ConfigContent, StackRecord } from '../src/index.js';

// A scoped query's cursor is sealed under `_config.cursorKey`: it names no
// record the requester cannot read, and only a cursor the stack sealed
// resumes. See docs/spec/disclosure.md § Scoped cursors are sealed.

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:owner';
const READER = 'did:key:reader';

let adapter: MemoryAdapter;
let stack: Stack;
let shared: StackRecord[];

beforeEach(async () => {
  adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.open(adapter);
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  shared = [];
  for (let i = 0; i < 30; i++) {
    const permissions =
      i % 3 === 0
        ? [
            {
              kind: 'permission' as const,
              label: 'read' as const,
              grantee: { kind: 'entity' as const, entityId: READER },
            },
          ]
        : [];
    const record = await stack.create(NOTE, { text: `note ${i}` }, { permissions });
    if (permissions.length) shared.push(record);
  }
});

const cursorKey = async (): Promise<string | undefined> =>
  ((await adapter.getRecord('_config'))?.content as ConfigContent).cursorKey;

/** Every page a scope answers, followed by its own cursors to the end. */
const pageThrough = async (scope: ReturnType<Stack['asEntity']>, limit: number) => {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await scope.query({ filter: { typeId: NOTE }, limit, ...(cursor && { cursor }) });
    ids.push(...page.records.map((r) => r.id));
    cursor = page.cursor ?? undefined;
    if (cursor) cursors.push(cursor);
  } while (cursor);
  return { ids, cursors };
};

describe('a scoped cursor is sealed', () => {
  test('it is not the adapter cursor, and pages still reach every readable record', async () => {
    const { ids, cursors } = await pageThrough(stack.asEntity(READER), 1);
    expect(ids.sort()).toEqual(shared.map((r) => r.id).sort());
    expect(cursors.length).toBeGreaterThan(0);
  });

  test('an anonymous page that reads nothing still hands back only a sealed cursor', async () => {
    const page = await stack.asEntity(null).query({ filter: { typeId: NOTE }, limit: 1 });
    expect(page.records).toEqual([]);
    expect(page.cursor).not.toBeNull();
    const raw = (await adapter.queryRecords({ filter: { typeId: NOTE }, limit: 10 })).cursor;
    expect(page.cursor).not.toBe(raw);
  });

  test('a cursor the stack did not seal is refused, not resumed', async () => {
    const raw = (await adapter.queryRecords({ filter: { typeId: NOTE }, limit: 1 })).cursor!;
    const scope = stack.asEntity(READER);
    await expect(scope.query({ filter: { typeId: NOTE }, cursor: raw })).rejects.toBeInstanceOf(
      StackBadRequestError,
    );
    const page = await scope.query({ filter: { typeId: NOTE }, limit: 1 });
    const tampered = page.cursor!.slice(0, -2) + (page.cursor!.endsWith('AA') ? 'BA' : 'AA');
    await expect(
      scope.query({ filter: { typeId: NOTE }, cursor: tampered }),
    ).rejects.toBeInstanceOf(StackBadRequestError);
  });

  test('the key is minted once and persisted, so another Stack over the store resumes it', async () => {
    expect(await cursorKey()).toBeUndefined();
    const page = await stack.asEntity(READER).query({ filter: { typeId: NOTE }, limit: 1 });
    const key = await cursorKey();
    expect(key).toBeDefined();

    const reopened = await Stack.open(adapter);
    await expect(
      reopened.asEntity(READER).query({ filter: { typeId: NOTE }, cursor: page.cursor! }),
    ).resolves.toBeDefined();
    expect(await cursorKey()).toBe(key);
  });

  test('two Stacks minting at once keep one key', async () => {
    const other = await Stack.open(adapter);
    const [a, b] = await Promise.all([
      stack.asEntity(READER).query({ filter: { typeId: NOTE }, limit: 1 }),
      other.asEntity(READER).query({ filter: { typeId: NOTE }, limit: 1 }),
    ]);
    await expect(
      stack.asEntity(READER).query({ filter: { typeId: NOTE }, cursor: b.cursor! }),
    ).resolves.toBeDefined();
    await expect(
      other.asEntity(READER).query({ filter: { typeId: NOTE }, cursor: a.cursor! }),
    ).resolves.toBeDefined();
  });
});

describe('_config keeps its cursor key to the owner', () => {
  const mint = () => stack.asEntity(READER).query({ filter: { typeId: NOTE }, limit: 1 });

  test('cursorKey cannot change once set', async () => {
    await mint();
    await expect(
      stack.patchContent('_config', { cursorKey: 'A'.repeat(43) }),
    ).rejects.toBeInstanceOf(StackConflictError);
    await expect(stack.patchContent('_config', { cursorKey: null })).rejects.toBeInstanceOf(
      StackConflictError,
    );
  });

  test('a cursorKey set by hand must be a well-formed key', async () => {
    await expect(stack.patchContent('_config', { cursorKey: 'short' })).rejects.toBeInstanceOf(
      StackValidationError,
    );
  });

  test('_config cannot be shared', async () => {
    await expect(
      stack.setAccess('_config', [{ kind: 'anyone', label: 'read' }]),
    ).rejects.toBeInstanceOf(StackConflictError);
  });

  test('a permission element stored on _config reaches nobody', async () => {
    const config = (await adapter.getRecord('_config'))!;
    adapter.records.set('_config', { ...config, permissions: [{ kind: 'anyone', label: 'read' }] });
    expect(await stack.asEntity(READER).get('_config')).toBeNull();
    expect(await stack.asEntity(null).get('_config')).toBeNull();
  });
});
