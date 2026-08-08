import { describe, it, expect } from 'vitest';
import {
  StackError,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackQueryError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
} from '@haverstack/core';
import {
  serializeError,
  deserializeError,
  errorForStatus,
  isWireError,
  WIRE_ERROR_STATUS,
} from '../src/index.js';

/** One instance per taxonomy member, with the class its code must rebuild. */
const everyStackError = [
  new StackValidationError([{ path: 'title', message: 'expected string' }]),
  new StackMigrationError('no migration path from note@1 to note@3'),
  new StackPermissionError(),
  new StackNotFoundError('Record "1hk153x0a00b" not found.'),
  new StackConflictError('Attachment is still referenced.'),
  new StackVersionConflictError('Version mismatch.', '1hk153x0a00b', 3, 5),
  new StackQueryError('Undecodable pagination cursor.'),
  new StackSchemaDriftError('note@1', [{ path: 'title', message: 'type changed' }]),
  new StackPayloadTooLargeError('Attachment exceeds the 50000000-byte limit.'),
];

describe('serializeError', () => {
  it('serializes every StackError to its declared code and status', () => {
    for (const err of everyStackError) {
      const wire = serializeError(err);
      expect(wire, err.name).not.toBeNull();
      expect(wire!.body.error.code, err.name).toBe(err.code);
      expect(wire!.status, err.name).toBe(WIRE_ERROR_STATUS[err.code]);
      expect(wire!.body.error.message, err.name).toBe(err.message);
      expect(isWireError(wire!.body), err.name).toBe(true);
    }
  });

  it('returns null for errors outside the taxonomy', () => {
    expect(serializeError(new Error('ordinary bug'))).toBeNull();
    expect(serializeError(new TypeError('undefined is not a function'))).toBeNull();
    expect(serializeError('not an error at all')).toBeNull();
    expect(serializeError(undefined)).toBeNull();
  });

  it('keeps version_conflict at 412, distinct from conflict at 409', () => {
    const conflict = serializeError(new StackConflictError('blocked'))!;
    const version = serializeError(
      new StackVersionConflictError('mismatch', '1hk153x0a00b', 3, 5),
    )!;
    expect(conflict.status).toBe(409);
    expect(version.status).toBe(412);
    expect(version.body.error.versionConflict).toEqual({
      recordId: '1hk153x0a00b',
      expectedVersion: 3,
      actualVersion: 5,
    });
  });

  it('carries structured payload only for the codes that define it', () => {
    const validation = serializeError(
      new StackValidationError([{ path: 'title', message: 'expected string' }]),
    )!;
    expect(validation.body.error.details).toEqual([{ path: 'title', message: 'expected string' }]);
    expect(validation.body.error.versionConflict).toBeUndefined();
    expect(validation.body.error.schemaDrift).toBeUndefined();

    const drift = serializeError(
      new StackSchemaDriftError('note@1', [{ path: 'title', message: 'type changed' }]),
    )!;
    expect(drift.body.error.schemaDrift).toEqual({
      typeId: 'note@1',
      violations: [{ path: 'title', message: 'type changed' }],
    });
    expect(drift.body.error.details).toBeUndefined();

    const permission = serializeError(new StackPermissionError())!;
    expect(permission.body.error.details).toBeUndefined();
    expect(permission.body.error.versionConflict).toBeUndefined();
    expect(permission.body.error.schemaDrift).toBeUndefined();
  });
});

describe('error round trip', () => {
  it('rebuilds the same class and code for every taxonomy member', () => {
    for (const err of everyStackError) {
      const rebuilt = deserializeError(serializeError(err)!.body);
      expect(rebuilt.constructor, err.name).toBe(err.constructor);
      expect(rebuilt, err.name).toBeInstanceOf(StackError);
      expect((rebuilt as StackError).code, err.name).toBe(err.code);
    }
  });

  it('preserves the fields an ifVersion retry loop needs', () => {
    const rebuilt = deserializeError(
      serializeError(new StackVersionConflictError('mismatch', '1hk153x0a00b', 3, 5))!.body,
    );
    expect(rebuilt).toBeInstanceOf(StackVersionConflictError);
    const conflict = rebuilt as StackVersionConflictError;
    expect(conflict.recordId).toBe('1hk153x0a00b');
    expect(conflict.expectedVersion).toBe(3);
    expect(conflict.actualVersion).toBe(5);
  });
});

describe('errorForStatus', () => {
  it('recovers a typed error from the unambiguous statuses', () => {
    expect(errorForStatus(403, 'nope')).toBeInstanceOf(StackPermissionError);
    expect(errorForStatus(404, 'nope')).toBeInstanceOf(StackNotFoundError);
    expect(errorForStatus(412, 'nope')).toBeInstanceOf(StackVersionConflictError);
    expect(errorForStatus(413, 'nope')).toBeInstanceOf(StackPayloadTooLargeError);
    expect(errorForStatus(422, 'nope')).toBeInstanceOf(StackValidationError);
    expect(errorForStatus(400, 'nope')).toBeInstanceOf(StackQueryError);
  });

  it('degrades a bodyless 409 to the generic conflict class', () => {
    const err = errorForStatus(409, 'nope');
    expect(err).toBeInstanceOf(StackConflictError);
    expect(err).not.toBeInstanceOf(StackSchemaDriftError);
  });

  it('refuses to infer a migration error from a bare 500', () => {
    expect(errorForStatus(500, 'nope')).toBeNull();
  });
});
