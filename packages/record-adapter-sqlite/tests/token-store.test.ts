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

  test('an undelegated token resolves both identities to the authenticated DID', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('entity-abc');
    const result = await store.lookupToken(token);
    expect(result).toEqual({ principalId: 'entity-abc', subjectId: 'entity-abc' });
  });

  // The binding no handshake can establish: proving key possession proves
  // the principal and nothing about whom it may act for, so the owner
  // asserts it at issuance. See docs/spec/wire-format.md § Authentication.
  test('a delegated token keeps the two identities distinct', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('did:key:zApp', { onBehalfOf: 'did:key:zBob' });
    expect(await store.lookupToken(token)).toEqual({
      principalId: 'did:key:zApp',
      subjectId: 'did:key:zBob',
    });
  });

  test('listTokens reports the delegation a token carries', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    await store.createToken('did:key:zApp', { onBehalfOf: 'did:key:zBob', label: 'Blog' });
    const [info] = await store.listTokens();
    expect(info).toMatchObject({
      principalId: 'did:key:zApp',
      subjectId: 'did:key:zBob',
      label: 'Blog',
    });
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

  test('lookupToken resolves a non-expired token', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    const { token } = await store.createToken('entity-abc', {
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await store.lookupToken(token))?.principalId).toBe('entity-abc');
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
    expect((await store2.lookupToken(token))?.principalId).toBe('entity-abc');
  });

  test('close() releases the storage lock', async () => {
    const store = await NativeTokenStore.open({ path: tokenPath });
    await store.close();
    await expect(NativeTokenStore.open({ path: tokenPath })).resolves.toBeDefined();
  });
});
