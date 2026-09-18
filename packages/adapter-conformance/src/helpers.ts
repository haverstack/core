/**
 * Fixture builders shared by the record and blob suites. Deliberately
 * schema-light: content-path filtering and sorting are exercised against
 * raw `content` shapes without a registered StackType wherever a real
 * adapter's own behavior doesn't require one — see the comments at each
 * call site in record.ts for the one exception (content-field sort, which
 * MemoryAdapter resolves through a registered type's schema).
 */

import type { StackRecord, StackType } from '@haverstack/core';

let counter = 0;

/** A fresh id on every call, unique within a test run. */
export function uniqueId(prefix = 'rec'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export const CONFORMANCE_TYPE_ID = 'org.haverstack.conformance/note@1';

export function conformanceType(overrides: Partial<StackType> = {}): StackType {
  return {
    id: CONFORMANCE_TYPE_ID,
    baseId: 'org.haverstack.conformance/note',
    version: 1,
    name: 'Conformance Note',
    schema: {
      title: { kind: 'string' },
      priority: { kind: 'number' },
    },
    schemaHash: 'conformance-note-v1',
    createdAt: new Date(),
    ...overrides,
  };
}

export function makeRecord(overrides: Partial<StackRecord> = {}): StackRecord {
  return {
    id: uniqueId(),
    typeId: CONFORMANCE_TYPE_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    content: { title: 'Untitled' },
    version: 1,
    ...overrides,
  };
}
