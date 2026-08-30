import { describe, test, expect, beforeEach } from 'vitest';
import { Stack, isCompatible } from '@haverstack/core';
import type { TypeSchema } from '@haverstack/core';
import { MemoryAdapter } from '@haverstack/core/testing';
import {
  NOTE,
  BOOKMARK,
  TASK,
  CONTACT,
  ARTICLE,
  PLACE,
  PAGE,
  PHOTO,
  POST,
  defineCommonsTypes,
} from '../src/index.js';

const ALL = [NOTE, BOOKMARK, TASK, CONTACT, ARTICLE, PLACE, PAGE, PHOTO, POST];

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
  stack = await Stack.create(adapter);
});

describe('commons type ids', () => {
  test('every type is namespaced under org.haverstack and at version 1', () => {
    for (const type of ALL) {
      expect(type.id).toMatch(/^org\.haverstack\/[a-z]+@1$/);
    }
  });

  test('ids are unique', () => {
    expect(new Set(ALL.map((t) => t.id)).size).toBe(ALL.length);
  });
});

describe('defineCommonsTypes', () => {
  test('registers exactly the given types, unchanged on redefinition', async () => {
    const defined = await defineCommonsTypes(stack, [NOTE, TASK]);
    expect(defined.map((t) => t.id)).toEqual([NOTE.id, TASK.id]);
    expect(await stack.getType(BOOKMARK.id)).toBeNull();

    // Redefining is the idempotent no-op path — StackSchemaDriftError would
    // throw here if the constant ever drifted from what was first written.
    await expect(defineCommonsTypes(stack, [NOTE, TASK])).resolves.toBeDefined();
  });

  test('registers every commons type without drift errors', async () => {
    const defined = await defineCommonsTypes(stack, ALL);
    expect(defined).toHaveLength(ALL.length);
  });
});

describe('read-compat cores', () => {
  const cores: Record<string, TypeSchema> = {
    [NOTE.id]: { text: { kind: 'text', required: true } },
    [BOOKMARK.id]: { url: { kind: 'string', required: true } },
    [TASK.id]: {
      title: { kind: 'string', required: true },
      done: { kind: 'boolean', required: true },
    },
    [CONTACT.id]: { name: { kind: 'string', required: true } },
    [ARTICLE.id]: {
      title: { kind: 'string', required: true },
      text: { kind: 'text', required: true },
    },
    [PLACE.id]: {
      latitude: { kind: 'number', required: true },
      longitude: { kind: 'number', required: true },
    },
    [PAGE.id]: {
      slug: { kind: 'string', required: true },
      text: { kind: 'text', required: true },
    },
    [PHOTO.id]: { image: { kind: 'file-ref', required: true } },
    [POST.id]: { text: { kind: 'text', required: true } },
  };

  test('every schema satisfies its documented read-compat core', () => {
    for (const type of ALL) {
      expect(isCompatible(type.schema, cores[type.id])).toBe(true);
    }
  });
});

describe('PHOTO', () => {
  test('image is a required file-ref field, schema-enforced', async () => {
    const defined = await defineCommonsTypes(stack, [PHOTO]);
    expect(defined[0].schema.image).toEqual({ kind: 'file-ref', required: true });
  });
});
