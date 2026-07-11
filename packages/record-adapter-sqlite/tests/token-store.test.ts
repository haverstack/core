import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NativeTokenStore, defaultTokenStorePath } from '../src/index.js';

let testDir: string;
let tokenPath: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `sqlite-tokens-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  tokenPath = join(testDir, 'test.db.tokens');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('defaultTokenStorePath', () => {
  test('derives a sibling path from the main db path', () => {
    expect(defaultTokenStorePath('/stacks/my-stack.db')).toBe('/stacks/my-stack.db.tokens');
  });
});

describe('NativeTokenStore', () => {
  test('open() creates the store file', async () => {
    await NativeTokenStore.open({ path: tokenPath });
    expect(existsSync(tokenPath)).toBe(true);
  });

  test('does not create or touch a database at the main stack path', async () => {
    const mainDbPath = join(testDir, 'test.db');
    await NativeTokenStore.open({ path: tokenPath });
    expect(existsSync(mainDbPath)).toBe(false);
  });

  test('createToken returns id and plaintext token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { id, token } = await store.createToken('entity-abc');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  test('lookupToken returns entityId for a valid token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('entity-abc');
    const result = await store.lookupToken(token);
    expect(result?.entityId).toBe('entity-abc');
  });

  test('lookupToken returns null for an invalid token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    expect(await store.lookupToken('not-a-real-token')).toBeNull();
  });

  test('lookupToken returns null for an expired token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('entity-abc', {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await store.lookupToken(token)).toBeNull();
  });

  test('lookupToken returns entityId for a non-expired token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('entity-abc', {
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await store.lookupToken(token))?.entityId).toBe('entity-abc');
  });

  test('listTokens returns all created tokens without plaintext values', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    await store.createToken('entity-a', { label: 'Token A' });
    await store.createToken('entity-b', { label: 'Token B' });
    const tokens = await store.listTokens();
    expect(tokens.length).toBe(2);
    expect(tokens.map((t) => t.label)).toEqual(expect.arrayContaining(['Token A', 'Token B']));
    for (const t of tokens) {
      expect(Object.keys(t)).not.toContain('token');
    }
  });

  test('revokeToken removes the token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { id, token } = await store.createToken('entity-abc');
    await store.revokeToken(id);
    expect(await store.lookupToken(token)).toBeNull();
  });

  test('tokens persist across store instances', async () => {
    const store1 = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store1.createToken('entity-abc');
    await store1.close();

    const store2 = await NativeTokenStore.open({ path: tokenPath });
    expect((await store2.lookupToken(token))?.entityId).toBe('entity-abc');
  });

  test('close() releases the storage lock', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    await store.close();
    await expect(NativeTokenStore.open({ path: tokenPath })).resolves.toBeDefined();
  });
});
