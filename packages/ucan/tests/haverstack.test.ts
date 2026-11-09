import { beforeEach, describe, expect, it } from 'vitest';
import { Stack, StackPermissionError } from '@haverstack/core';
import { MemoryAdapter } from '@haverstack/core/testing';
import { acceptDelegation, signedDelegation, UcanError, validateChain } from '../src/index.js';
import { issue, makeSigner, NOW } from './helpers.js';

const NOTE = 'com.example.test/note@1';
const COMMENT = 'com.example.test/comment@1';

describe('signedDelegation', () => {
  const owner = makeSigner();
  const member = makeSigner();
  const app = makeSigner();
  let stack: Stack;

  beforeEach(async () => {
    stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: owner.did }));
    for (const id of [NOTE, COMMENT]) {
      await stack.defineType({ id, name: id, schema: { text: { kind: 'text' } } });
      await stack.grantType(id.split('@')[0]!, {
        actions: ['create', 'read-any'],
        grantee: { kind: 'entity', entityId: member.did },
      });
    }
  });

  it('lets an app its subject delegated to act for them, within the delegation', async () => {
    const d = await issue(member, {
      audience: app.did,
      cmd: '/haverstack/record/create',
      pol: [['==', '.baseId', 'com.example.test/comment']],
    });
    const delegation = signedDelegation(await validateChain([d], { now: NOW }));
    const view = stack.asActor({ subjectId: member.did, principalId: app.did }, { delegation });

    const record = await view.create(COMMENT, { text: 'hi' });
    expect(record.createdBy).toEqual({ subjectId: member.did, principalId: app.did });
    await expect(view.create(NOTE, { text: 'hi' })).rejects.toThrow(StackPermissionError);
    await expect(view.query({ filter: { typeId: COMMENT } })).resolves.toMatchObject({
      records: [],
    });
  });

  it('covers every verb under /haverstack/record', async () => {
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const { allows } = signedDelegation(await validateChain([d], { now: NOW }));
    for (const verb of ['create', 'read', 'update', 'delete'] as const) {
      expect(allows(verb, 'com.example.test/note')).toBe(true);
    }
    const narrow = await issue(member, { audience: app.did, cmd: '/haverstack/record/read' });
    const read = signedDelegation(await validateChain([narrow], { now: NOW }));
    expect(read.allows('read', 'x')).toBe(true);
    expect(read.allows('update', 'x')).toBe(false);
  });
});

describe('acceptDelegation', () => {
  const member = makeSigner();
  const app = makeSigner();

  it('reports the subject, the earliest expiry and the delegation for the key that authenticated', async () => {
    const root = await issue(member, {
      audience: app.did,
      cmd: '/haverstack/record/read',
      exp: NOW + 600,
    });
    const accepted = await acceptDelegation([root.bytes], app.did, { now: NOW });
    expect(accepted.subjectId).toBe(member.did);
    expect(accepted.expiresAt).toEqual(new Date((NOW + 600) * 1000));
    expect(accepted.delegation).toMatchObject({ subjectId: member.did, principalId: app.did });
    expect(accepted.delegation.allows('read', 'x')).toBe(true);
  });

  it('refuses a chain delegated to a different key', async () => {
    const root = await issue(member, { audience: makeSigner().did });
    await expect(acceptDelegation([root.bytes], app.did, { now: NOW })).rejects.toThrow(UcanError);
  });

  it('refuses a key delegating to itself', async () => {
    const root = await issue(app, { audience: app.did });
    await expect(acceptDelegation([root.bytes], app.did, { now: NOW })).rejects.toThrow(UcanError);
  });

  it('refuses bytes that are not a delegation', async () => {
    await expect(acceptDelegation([Uint8Array.of(1, 2, 3)], app.did)).rejects.toMatchObject({
      code: 'malformed',
    });
  });
});

describe('revoking through the stack', () => {
  it('a _revocation naming any link refuses the chain until it is deleted', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const device = makeSigner();
    const stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: owner.did }));
    const root = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issue(app, {
      audience: device.did,
      subject: member.did,
      cmd: '/haverstack/record',
    });
    const chain = [root.bytes, leaf.bytes];
    const isRevoked = (cid: string, issuers: readonly string[]) =>
      stack.isDelegationRevoked(cid, issuers);

    await expect(
      acceptDelegation(chain, device.did, { now: NOW, isRevoked }),
    ).resolves.toBeDefined();
    const revocation = await stack.create('_revocation@1', { cid: root.cid });
    await expect(
      acceptDelegation(chain, device.did, { now: NOW, isRevoked }),
    ).rejects.toMatchObject({
      code: 'revoked',
    });
    await stack.delete(revocation.id);
    await expect(
      acceptDelegation(chain, device.did, { now: NOW, isRevoked }),
    ).resolves.toBeDefined();
  });

  // Whoever granted the authority can withdraw it, not only the owner.
  it("the subject who signed revokes their own delegation; a stranger's revocation counts for nothing", async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const stranger = makeSigner();
    const app = makeSigner();
    const stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: owner.did }));
    for (const who of [member, stranger]) {
      await stack.grantType('_revocation', {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: who.did },
      });
    }
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const isRevoked = (cid: string, issuers: readonly string[]) =>
      stack.isDelegationRevoked(cid, issuers);

    await stack.asEntity(stranger.did).create('_revocation@1', { cid: d.cid });
    await expect(
      acceptDelegation([d.bytes], app.did, { now: NOW, isRevoked }),
    ).resolves.toBeDefined();

    await stack.asEntity(member.did).create('_revocation@1', { cid: d.cid });
    await expect(
      acceptDelegation([d.bytes], app.did, { now: NOW, isRevoked }),
    ).rejects.toMatchObject({
      code: 'revoked',
    });
  });
});
