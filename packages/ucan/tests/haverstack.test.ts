import { beforeEach, describe, expect, it } from 'vitest';
import {
  DelegationRefusedError,
  Stack,
  StackBadRequestError,
  StackPermissionError,
} from '@haverstack/core';
import { MemoryAdapter } from '@haverstack/core/testing';
import { delegationVerifier } from '../src/index.js';
import { issue as issueAny, makeSigner, type TestSigner } from './helpers.js';
import type { DelegationOptions } from '../src/index.js';

const NOTE = 'com.example.test/note@1';
const COMMENT = 'com.example.test/comment@1';

/** A delegation naming both test families, as every accepted chain must name its own. */
const BOTH = [
  [
    'or',
    [
      ['==', '.baseId', 'com.example.test/note'],
      ['==', '.baseId', 'com.example.test/comment'],
    ],
  ],
];
const issue = (issuer: TestSigner, overrides: Partial<DelegationOptions> = {}) =>
  issueAny(issuer, { pol: BOTH, ...overrides });

const openStack = async (ownerDid: string) =>
  Stack.open(await MemoryAdapter.open({ ownerEntityId: ownerDid }), {
    verifyDelegation: delegationVerifier(),
  });

describe('a stack opened with delegationVerifier()', () => {
  const owner = makeSigner();
  const member = makeSigner();
  const app = makeSigner();
  let stack: Stack;

  beforeEach(async () => {
    stack = await openStack(owner.did);
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
    const view = stack.asActor({
      subjectId: member.did,
      principalId: app.did,
      delegationChain: [d.bytes],
    });
    const record = await view.create(COMMENT, { text: 'hi' });
    expect(record.createdBy).toEqual({ subjectId: member.did, principalId: app.did });
    await expect(view.create(NOTE, { text: 'hi' })).rejects.toThrow(StackPermissionError);
  });

  it('reports the subject and earliest expiry for the key that authenticated', async () => {
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record', exp: 2e9 });
    const verified = await stack.verifyDelegationChain([d.bytes], { principalId: app.did });
    expect(verified).toMatchObject({
      subjectId: member.did,
      principalId: app.did,
      expiresAt: new Date(2e9 * 1000),
    });
    expect(verified.families).toEqual([
      { baseId: 'com.example.test/note', verbs: ['create', 'read', 'update', 'delete'] },
      { baseId: 'com.example.test/comment', verbs: ['create', 'read', 'update', 'delete'] },
    ]);
  });

  it('refuses a chain to another key, a key delegating to itself, and bytes that are no chain', async () => {
    const toOther = await issue(member, { audience: makeSigner().did });
    await expect(
      stack.verifyDelegationChain([toOther.bytes], { principalId: app.did }),
    ).rejects.toThrow(DelegationRefusedError);
    const self = await issue(app, { audience: app.did });
    await expect(
      stack.verifyDelegationChain([self.bytes], { principalId: app.did }),
    ).rejects.toThrow(DelegationRefusedError);
    await expect(
      stack.verifyDelegationChain([Uint8Array.of(1, 2, 3)], { principalId: app.did }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  // Expiry and revocation reach a view already in hand: each operation
  // validates the chain again, so a server can't forget to.
  it('refuses every operation of a held view once its chain expires', async () => {
    const soon = Math.floor(Date.now() / 1000) + 61;
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record', exp: soon });
    const view = stack.asActor({
      subjectId: member.did,
      principalId: app.did,
      delegationChain: [d.bytes],
    });
    await expect(view.query({ filter: { typeId: COMMENT } })).resolves.toBeDefined();
    const realNow = Date.now;
    Date.now = () => (soon + 120) * 1000;
    try {
      await expect(view.query({ filter: { typeId: COMMENT } })).rejects.toThrow(
        DelegationRefusedError,
      );
    } finally {
      Date.now = realNow;
    }
  });

  it('a session whose chain names another subject is refused', async () => {
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const view = stack.asActor({
      subjectId: makeSigner().did,
      principalId: app.did,
      delegationChain: [d.bytes],
    });
    await expect(view.query({ filter: { typeId: COMMENT } })).rejects.toThrow(
      DelegationRefusedError,
    );
  });
});

describe('revoking through the stack', () => {
  it('the owner revokes the delegation a chain ends at, until the revocation is deleted', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const device = makeSigner();
    const stack = await openStack(owner.did);
    const root = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issue(app, {
      audience: device.did,
      subject: member.did,
      cmd: '/haverstack/record',
    });
    const chain = [root.bytes, leaf.bytes];

    await expect(
      stack.verifyDelegationChain(chain, { principalId: device.did }),
    ).resolves.toBeDefined();
    const revocation = await stack.revokeDelegation!([root.bytes]);
    expect(revocation.content).toEqual({ cid: root.cid });
    await expect(stack.verifyDelegationChain(chain, { principalId: device.did })).rejects.toThrow(
      DelegationRefusedError,
    );
    await stack.delete(revocation.id);
    await expect(
      stack.verifyDelegationChain(chain, { principalId: device.did }),
    ).resolves.toBeDefined();
  });

  // Whoever granted the authority can withdraw it, not only the owner.
  it('every issuer in the chain may revoke it; a stranger may not', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const device = makeSigner();
    const stack = await openStack(owner.did);
    const root = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issue(app, {
      audience: device.did,
      subject: member.did,
      cmd: '/haverstack/record',
    });
    const chain = [root.bytes, leaf.bytes];

    await expect(stack.asEntity(makeSigner().did).revokeDelegation!(chain)).rejects.toThrow(
      StackPermissionError,
    );
    await expect(
      stack.verifyDelegationChain(chain, { principalId: device.did }),
    ).resolves.toBeDefined();
    for (const issuer of [member, app]) {
      const record = await stack.asEntity(issuer.did).revokeDelegation!(chain);
      expect(record.content).toEqual({ cid: leaf.cid });
    }
    await expect(stack.verifyDelegationChain(chain, { principalId: device.did })).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  // Withdrawing a delegation is still withdrawing it before it starts or
  // after it ends, so a revocation's chain is checked but for time bounds.
  it('a delegation can be revoked outside its time bounds', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const stack = await openStack(owner.did);
    const now = Math.floor(Date.now() / 1000);
    const later = await issue(member, { audience: app.did, nbf: now + 3600 });
    const past = await issue(member, { audience: app.did, exp: now - 3600 });
    for (const d of [later, past]) {
      const record = await stack.asEntity(member.did).revokeDelegation!([d.bytes]);
      expect(record.content).toEqual({ cid: d.cid });
    }
    const forged = new Uint8Array(later.bytes);
    forged[forged.length - 1]! ^= 1;
    await expect(stack.asEntity(member.did).revokeDelegation!([forged])).rejects.toThrow(
      StackBadRequestError,
    );
  });

  it('revoking reaches a subscription already open', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const stack = await openStack(owner.did);
    await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: member.did },
    });
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const seen: string[] = [];
    const errors: unknown[] = [];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await stack
      .asActor({ subjectId: member.did, principalId: app.did, delegationChain: [d.bytes] })
      .subscribe((change) => void seen.push(change.recordId), {
        onError: (err) => void errors.push(err),
      });
    const before = await stack.create(NOTE, { text: 'before' });
    await settle();
    await stack.asEntity(member.did).revokeDelegation!([d.bytes]);
    await stack.create(NOTE, { text: 'after' });
    await settle();
    expect(seen).toEqual([before.id]);
    expect(errors.some((e) => e instanceof DelegationRefusedError)).toBe(true);
  });

  // A subscription holds its snapshot for its life, so expiry has to be
  // checked against the time, not left to the next operation.
  it('expiry reaches a subscription already open', async () => {
    const owner = makeSigner();
    const member = makeSigner();
    const app = makeSigner();
    const stack = await openStack(owner.did);
    await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: member.did },
    });
    const soon = Math.floor(Date.now() / 1000) + 61;
    const d = await issue(member, { audience: app.did, cmd: '/haverstack/record', exp: soon });
    const seen: string[] = [];
    const errors: unknown[] = [];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await stack
      .asActor({ subjectId: member.did, principalId: app.did, delegationChain: [d.bytes] })
      .subscribe((change) => void seen.push(change.recordId), {
        onError: (err) => void errors.push(err),
      });
    const before = await stack.create(NOTE, { text: 'before' });
    await settle();
    const realNow = Date.now;
    Date.now = () => (soon + 120) * 1000;
    try {
      await stack.create(NOTE, { text: 'after' });
      await settle();
    } finally {
      Date.now = realNow;
    }
    expect(seen).toEqual([before.id]);
    expect(errors.some((e) => e instanceof DelegationRefusedError)).toBe(true);
  });
});

// A chain names its families as a grant does, so what it allows is a list
// rather than a predicate asked of every family the stack defines.
describe('what a chain allows', () => {
  const owner = makeSigner();
  const member = makeSigner();
  const app = makeSigner();
  const device = makeSigner();
  const allowed = async (chain: Uint8Array[], audience = app.did) =>
    (await (await openStack(owner.did)).verifyDelegationChain(chain, { principalId: audience }))
      .families;
  const note = (family: string) => [['==', '.baseId', family]];

  it('is the families its links name, intersected, with the verbs every command covers', async () => {
    const root = await issue(member, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issueAny(app, {
      audience: device.did,
      subject: member.did,
      cmd: '/haverstack/record/read',
      pol: note('com.example.test/note'),
    });
    expect(await allowed([root.bytes, leaf.bytes], device.did)).toEqual([
      { baseId: 'com.example.test/note', verbs: ['read'] },
    ]);
  });

  it('may be named by any one link, the others leaving it alone', async () => {
    const root = await issueAny(member, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issue(app, { audience: device.did, subject: member.did, cmd: '/' });
    expect((await allowed([root.bytes, leaf.bytes], device.did)).length).toBe(2);
  });

  it('refuses a chain naming no family, and a policy that does not list them', async () => {
    const unnamed = await issueAny(member, { audience: app.did, cmd: '/haverstack/record' });
    const pattern = await issueAny(member, {
      audience: app.did,
      cmd: '/haverstack/record',
      pol: [['like', '.baseId', 'com.example.test/*']],
    });
    const twoStatements = await issueAny(member, {
      audience: app.did,
      cmd: '/haverstack/record',
      pol: [...note('com.example.test/note'), ...note('com.example.test/note')],
    });
    for (const d of [unnamed, pattern, twoStatements]) {
      await expect(allowed([d.bytes])).rejects.toThrow(DelegationRefusedError);
    }
  });

  // What a delegation allows has no bearing on withdrawing it, so a root
  // that names no family is revoked like any other.
  it('does not bear on revoking', async () => {
    const stack = await openStack(owner.did);
    const unnamed = await issueAny(member, { audience: app.did, cmd: '/haverstack/record' });
    const record = await stack.asEntity(member.did).revokeDelegation!([unnamed.bytes]);
    expect(record.content).toEqual({ cid: unnamed.cid });
  });
});
