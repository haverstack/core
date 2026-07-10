import { describe, test, expect } from 'vitest';
import { StackQueryError } from '@haverstack/core';
import { encodeCursor, decodeCursor, makeCursor } from '../src/cursor.js';
import type { StackRecord } from '@haverstack/core';

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: 'rec01',
  typeId: 'com.example/note@1',
  createdAt: new Date(1000),
  updatedAt: new Date(2000),
  content: {},
  version: 3,
  ...overrides,
});

describe('encodeCursor / decodeCursor', () => {
  test('roundtrips field, value, and id', () => {
    const cursor = encodeCursor('createdAt', 12345, 'rec01');
    expect(decodeCursor(cursor)).toEqual({ field: 'createdAt', value: 12345, id: 'rec01' });
  });

  test('accepts the legacy 2-part (value|id) format as createdAt', () => {
    const legacy = btoa('12345|rec01');
    expect(decodeCursor(legacy)).toEqual({ field: 'createdAt', value: 12345, id: 'rec01' });
  });

  test('throws StackQueryError for non-base64 garbage', () => {
    expect(() => decodeCursor('!!!not-a-cursor!!!')).toThrow(StackQueryError);
  });

  test('throws StackQueryError for an unknown sort field', () => {
    expect(() => decodeCursor(btoa('bogusField|123|r1'))).toThrow(StackQueryError);
  });

  test('throws StackQueryError for a non-numeric sort value', () => {
    expect(() => decodeCursor(btoa('createdAt|not-a-number|r1'))).toThrow(StackQueryError);
  });
});

describe('makeCursor', () => {
  test('encodes createdAt by default field selection', () => {
    const cursor = makeCursor(makeRecord(), 'createdAt');
    expect(decodeCursor(cursor)).toEqual({ field: 'createdAt', value: 1000, id: 'rec01' });
  });

  test('encodes updatedAt', () => {
    const cursor = makeCursor(makeRecord(), 'updatedAt');
    expect(decodeCursor(cursor)).toEqual({ field: 'updatedAt', value: 2000, id: 'rec01' });
  });

  test('encodes version', () => {
    const cursor = makeCursor(makeRecord(), 'version');
    expect(decodeCursor(cursor)).toEqual({ field: 'version', value: 3, id: 'rec01' });
  });
});
