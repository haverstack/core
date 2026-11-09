import { beforeEach, describe, expect, it } from 'vitest';
import { Stack, StackPermissionError } from '@haverstack/core';
import { MemoryAdapter } from '@haverstack/core/testing';
import { signedDelegation, validateChain } from '../src/index.js';
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
      cmd: '/haverstack/create',
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

  it('covers every verb under /haverstack', async () => {
    const d = await issue(member, { audience: app.did, cmd: '/haverstack' });
    const { allows } = signedDelegation(await validateChain([d], { now: NOW }));
    for (const verb of ['create', 'read', 'update', 'delete'] as const) {
      expect(allows(verb, 'com.example.test/note')).toBe(true);
    }
    const narrow = await issue(member, { audience: app.did, cmd: '/haverstack/read' });
    const read = signedDelegation(await validateChain([narrow], { now: NOW }));
    expect(read.allows('read', 'x')).toBe(true);
    expect(read.allows('update', 'x')).toBe(false);
  });
});
