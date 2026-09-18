/**
 * Error assertions
 * -------------------------------------------------------
 * Checked against `.code` — the wire discriminator every StackError
 * subclass carries — rather than `instanceof`. An RPC-backed adapter (a
 * Durable Object, a remote server process) reconstructs a thrown error on
 * the far side of that boundary without its original prototype chain, so
 * `instanceof StackConflictError` can fail even when the adapter behaved
 * correctly; `.code` is what survives. Using it here is what lets this
 * suite run unmodified against an adapter that lives behind such a
 * boundary, not just one that shares a process with the test runner.
 */

import { expect } from 'vitest';
import type { StackErrorCode } from '@haverstack/core';

/** Assert `promise` rejects with a StackError carrying this `code`. */
export async function expectStackErrorCode(
  promise: Promise<unknown>,
  code: StackErrorCode,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    expect.fail(`expected the call to reject with a StackError coded "${code}", but it resolved`);
  }
  expect((caught as { code?: unknown }).code).toBe(code);
}
