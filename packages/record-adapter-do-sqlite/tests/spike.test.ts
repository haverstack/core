import { env } from 'cloudflare:test';
import { describe, test, expect } from 'vitest';

// Spike for #161 — answers questions that determine whether
// SharedSqlRecordLogic's synchronous, raw-BEGIN/COMMIT-based SqlExecutor
// contract can be reused as-is against ctx.storage.sql on a DO, or needs
// a different transaction/pragma strategy. Findings are printed via
// console.log (visible in the workers pool's captured output) rather than
// asserted strictly, since the goal here is discovery, not regression
// coverage — the real adapter's tests replace this file.

const getStub = () => {
  const id = env.SPIKE_DO.idFromName(`spike-${Math.random()}`);
  return env.SPIKE_DO.get(id);
};

describe('DO SQLite spike', () => {
  test('pragmas', async () => {
    const stub = getStub();
    const result = await stub.probePragmas();
    console.log('PRAGMAS:', JSON.stringify(result, null, 2));
  });

  test('foreign key enforcement', async () => {
    const stub = getStub();
    const result = await stub.probeForeignKeyEnforcement();
    console.log('FK ENFORCEMENT:', JSON.stringify(result, null, 2));
  });

  test('unique violation', async () => {
    const stub = getStub();
    const result = await stub.probeUniqueViolation();
    console.log('UNIQUE VIOLATION:', JSON.stringify(result, null, 2));
  });

  test('raw BEGIN/COMMIT/ROLLBACK', async () => {
    const stub = getStub();
    const result = await stub.probeRawTransaction();
    console.log('RAW TRANSACTION:', JSON.stringify(result, null, 2));
  });

  test('cursor shape', async () => {
    const stub = getStub();
    const result = await stub.probeCursorShape();
    console.log('CURSOR SHAPE:', JSON.stringify(result, null, 2));
  });

  test('fts5', async () => {
    const stub = getStub();
    const result = await stub.probeFts5();
    console.log('FTS5:', JSON.stringify(result, null, 2));
  });

  test('spread-args parameter binding', async () => {
    const stub = getStub();
    const result = await stub.probeBindingStyle();
    console.log('BINDING STYLE:', JSON.stringify(result, null, 2));
  });

  test('auto-rollback on throw: synchronous, no ROLLBACK issued', async () => {
    const stub = getStub();
    await expect(stub.writeThenThrow_sync()).rejects.toThrow();
    const result = await stub.checkSurvivors('auto-rb-sync');
    console.log('AUTO-ROLLBACK (sync throw):', JSON.stringify(result, null, 2));
  });

  test('auto-rollback on throw: after a microtask hop', async () => {
    const stub = getStub();
    await expect(stub.writeThenThrow_microtask()).rejects.toThrow();
    const result = await stub.checkSurvivors('auto-rb-micro');
    console.log('AUTO-ROLLBACK (microtask throw):', JSON.stringify(result, null, 2));
  });

  test('auto-rollback on throw: multi-statement sequence', async () => {
    const stub = getStub();
    await expect(stub.writeThenThrow_multiStatement()).rejects.toThrow();
    const result = await stub.checkSurvivors('multi-%');
    console.log('AUTO-ROLLBACK (multi-statement):', JSON.stringify(result, null, 2));
  });

  test('transactionSync rolls back on throw', async () => {
    const stub = getStub();
    await expect(stub.transactionSyncThenThrow()).rejects.toThrow();
    const result = await stub.checkSurvivors('txsync-%');
    console.log('TRANSACTIONSYNC ROLLBACK:', JSON.stringify(result, null, 2));
  });

  test('transactionSync commits on success', async () => {
    const stub = getStub();
    const result = await stub.transactionSyncCommits();
    console.log('TRANSACTIONSYNC COMMIT:', JSON.stringify(result, null, 2));
  });

  test('transactionSync passes return value through', async () => {
    const stub = getStub();
    const result = await stub.transactionSyncReturnsValue();
    console.log('TRANSACTIONSYNC RETURN VALUE:', JSON.stringify(result, null, 2));
  });
});
