import { describe, test, expect } from 'vitest';
import { familyPolicy, ownerFieldRefusal } from '../src/scoped-stack/family-policy.js';
import { SYSTEM_TYPES } from '../src/types/index.js';

// One entry per system family decides what a scoped writer is held to
// beyond the ordinary gates, for every verb that writes what it governs.
// See docs/spec/access-control.md § Per-verb gates.

const OWNER = 'did:key:owner';
const OTHER = 'did:key:other';

describe('who may write each family', () => {
  test.each([
    [SYSTEM_TYPES.GRANT, 'owner-alone'],
    [SYSTEM_TYPES.INSTALL, 'owner-alone'],
    [SYSTEM_TYPES.GROUP, 'group-managers'],
    [SYSTEM_TYPES.APP, 'ordinary'],
    [SYSTEM_TYPES.ENTITY, 'ordinary'],
    [SYSTEM_TYPES.ATTACHMENT, 'ordinary'],
    ['com.example/note', 'ordinary'],
  ])('%s: %s', (family, writers) => {
    expect(familyPolicy(`${family}@1`).writers).toBe(writers);
  });

  test('only a _group roster is exempt from the relationship reference gate', () => {
    expect(familyPolicy(`${SYSTEM_TYPES.GROUP}@1`).rosterAssociations).toBe(true);
    expect(familyPolicy('com.example/note@1').rosterAssociations).toBeUndefined();
  });

  test('only an _attachment create must already reach the file it names', () => {
    expect(familyPolicy(`${SYSTEM_TYPES.ATTACHMENT}@1`).createNamesFile).toBe('fileId');
    expect(familyPolicy('com.example/note@1').createNamesFile).toBeUndefined();
  });
});

describe('content only the owner acting alone may set', () => {
  const app = `${SYSTEM_TYPES.APP}@1`;
  const entity = `${SYSTEM_TYPES.ENTITY}@1`;

  test('any change to an _app binding, at create or after', () => {
    expect(ownerFieldRefusal(app, undefined, { did: OTHER }, OWNER)).not.toBeNull();
    expect(ownerFieldRefusal(app, { appId: 'a' }, { appId: 'b' }, OWNER)).not.toBeNull();
    expect(ownerFieldRefusal(app, { did: OTHER }, { did: null }, OWNER)).not.toBeNull();
  });

  test('re-sending the value a card holds moves nothing', () => {
    expect(
      ownerFieldRefusal(app, { did: OTHER, name: 'a' }, { did: OTHER, name: 'b' }, OWNER),
    ).toBeNull();
    expect(ownerFieldRefusal(entity, { did: OWNER }, { did: OWNER }, OWNER)).toBeNull();
  });

  test("an _entity card claiming the owner's own DID, and no other", () => {
    expect(ownerFieldRefusal(entity, undefined, { did: OWNER }, OWNER)).not.toBeNull();
    expect(ownerFieldRefusal(entity, {}, { did: OWNER }, OWNER)).not.toBeNull();
    expect(ownerFieldRefusal(entity, undefined, { did: OTHER }, OWNER)).toBeNull();
  });

  test('an ordinary family reserves nothing', () => {
    expect(ownerFieldRefusal('com.example/note@1', undefined, { did: OWNER }, OWNER)).toBeNull();
  });
});
