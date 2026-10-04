import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { StackPermissionError } from '../src/errors.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'owner-123';
const MEMBER = 'member-456';
const APP = 'app-789';
const MISSING_ID = '1hk153xffffz';
const MISSING_FILE = 'ab'.repeat(32);

let stack: Stack;

beforeEach(async () => {
  const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.open(adapter);
  await stack.defineType({
    id: NOTE,
    name: 'Note',
    schema: { text: { kind: 'text' }, file: { kind: 'file-ref' } },
  });
});

async function messageOf(attempt: Promise<unknown>): Promise<string> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StackPermissionError);
  return (err as Error).message;
}

describe('StackPermissionError messages — refusing a readable Record', () => {
  beforeEach(async () => {
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
  });

  test('an update names the verb, the Record, its type and what was missing', async () => {
    const rec = await stack.create(NOTE, { text: 'a' });
    const msg = await messageOf(stack.asEntity(MEMBER).patchContent(rec.id, { text: 'b' }));
    expect(msg).toBe(`Cannot update "${rec.id}" (${NOTE}): requires update-own or update-any`);
  });

  test('a delete names the delete verb', async () => {
    const rec = await stack.create(NOTE, { text: 'a' });
    const msg = await messageOf(stack.asEntity(MEMBER).delete(rec.id));
    expect(msg).toBe(`Cannot delete "${rec.id}" (${NOTE}): requires delete-own or delete-any`);
  });

  test('a delegated refusal says when the acting side lacked the grant', async () => {
    await stack.grantType('com.example.test/note', {
      actions: ['read-any', 'delete-any'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
    await stack.grantType('com.example.test/note', {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: APP },
    });
    const rec = await stack.create(NOTE, { text: 'a' });
    const msg = await messageOf(
      stack.asActor({ principalId: APP, subjectId: MEMBER }).delete(rec.id),
    );
    expect(msg).toBe(
      `Cannot delete "${rec.id}" (${NOTE}): the app acting for this entity holds no delete grant`,
    );
  });

  test('a reshare names the Record and who can reshare it', async () => {
    const rec = await stack.create(NOTE, { text: 'a' });
    const msg = await messageOf(
      stack
        .asEntity(MEMBER)
        .grantAccess(rec.id, [
          { kind: 'permission', label: 'read', grantee: { kind: 'entity', entityId: APP } },
        ]),
    );
    expect(msg).toBe(
      `Cannot change permissions on "${rec.id}": only its author or the stack owner can reshare it`,
    );
  });
});

describe('StackPermissionError messages — refusing a reference', () => {
  beforeEach(async () => {
    await stack.grantType('com.example.test/note', {
      actions: ['create', 'read-own', 'update-own'],
      grantee: { kind: 'entity', entityId: MEMBER },
    });
  });

  test('a parentId reads the same whether the target is missing or unreadable', async () => {
    const hidden = await stack.create(NOTE, { text: 'hidden' });
    const view = stack.asEntity(MEMBER);
    const missing = await messageOf(view.create(NOTE, { text: 'x' }, { parentId: MISSING_ID }));
    const unreadable = await messageOf(view.create(NOTE, { text: 'x' }, { parentId: hidden.id }));
    expect(missing).toBe(
      `Cannot reference record "${MISSING_ID}" as parent: it does not exist or you cannot read it`,
    );
    expect(unreadable).toBe(missing.replace(MISSING_ID, hidden.id));
  });

  test('a parentId move reads the same whether the target is missing or unreadable', async () => {
    const hidden = await stack.create(NOTE, { text: 'hidden' });
    const mine = await stack.asEntity(MEMBER).create(NOTE, { text: 'mine' });
    const view = stack.asEntity(MEMBER);
    const missing = await messageOf(view.mutate(mine.id, { parentId: MISSING_ID }));
    const unreadable = await messageOf(view.mutate(mine.id, { parentId: hidden.id }));
    expect(unreadable).toBe(missing.replace(MISSING_ID, hidden.id));
  });

  test('a relationship names the target the caller passed', async () => {
    const hidden = await stack.create(NOTE, { text: 'hidden' });
    const view = stack.asEntity(MEMBER);
    const rel = (recordId: string) => ({
      kind: 'relationship' as const,
      label: 'see-also',
      target: { kind: 'record' as const, recordId },
    });
    const missing = await messageOf(
      view.create(NOTE, { text: 'x' }, { associations: [rel(MISSING_ID)] }),
    );
    const unreadable = await messageOf(
      view.create(NOTE, { text: 'x' }, { associations: [rel(hidden.id)] }),
    );
    expect(missing).toContain(`"${MISSING_ID}"`);
    expect(unreadable).toBe(missing.replace(MISSING_ID, hidden.id));
  });

  test('a file-ref field names the file and the field', async () => {
    const secret = await stack.putAttachment(new Uint8Array([1, 2, 3]), {
      mimeType: 'text/plain',
      filename: 's.txt',
    });
    const view = stack.asEntity(MEMBER);
    const missing = await messageOf(view.create(NOTE, { text: 'x', file: MISSING_FILE }));
    const unreadable = await messageOf(
      view.create(NOTE, { text: 'x', file: secret.content.fileId }),
    );
    expect(missing).toBe(
      `Cannot reference file "${MISSING_FILE}" in field "file": it does not exist or you cannot read it`,
    );
    expect(unreadable).toBe(missing.replace(MISSING_FILE, secret.content.fileId));
  });

  test('getAttachment names the file whether it is missing or unreadable', async () => {
    const secret = await stack.putAttachment(new Uint8Array([1, 2, 3]), {
      mimeType: 'text/plain',
      filename: 's.txt',
    });
    const view = stack.asEntity(MEMBER);
    const missing = await messageOf(view.getAttachment(MISSING_FILE));
    const unreadable = await messageOf(view.getAttachment(secret.content.fileId));
    expect(missing).toBe(
      `Cannot read file "${MISSING_FILE}": it does not exist or you cannot read it`,
    );
    expect(unreadable).toBe(missing.replace(MISSING_FILE, secret.content.fileId));
  });
});
