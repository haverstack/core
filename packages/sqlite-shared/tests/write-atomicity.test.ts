import { describe, test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SharedSqlRecordLogic } from '../src/record-logic.js';
import type { SqlExecutor } from '../src/executor.js';
import { RECORD_SCHEMA_SQL, FTS5_SCHEMA_SQL, PRAGMA_FOREIGN_KEYS_ON } from '../src/schema.js';
import type { StackRecord, TypeId } from '@haverstack/core';

const NOTE = 'com.example/note@1' as TypeId;

/**
 * A real executor that throws on its Nth `run()`, standing in for a write
 * that dies partway. Every method here issues several statements, and a
 * transaction is the only thing that makes the set of them one fact — so
 * the property is only observable by failing in the middle of one.
 */
const failingExecutor = (db: DatabaseSync, failOnRun: number): SqlExecutor => {
  let runs = 0;
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => {
      if (++runs === failOnRun) throw new Error('simulated mid-write failure');
      return db.prepare(sql).run(...(params as never[])).changes as number;
    },
    get: (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
    transaction: (fn) => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
};

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: 'rec000000001',
  typeId: NOTE,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { text: 'hello', rank: 3 },
  version: 1,
  associations: [{ kind: 'tag', label: 'starred' }],
  ...overrides,
});

const NOTE_TYPE = {
  id: NOTE,
  baseId: 'com.example/note',
  version: 1,
  name: 'Note',
  schema: { text: { kind: 'text' as const, required: true }, rank: { kind: 'number' as const } },
  schemaHash: 'h',
  createdAt: new Date(),
};

/** A logic instance over a fresh in-memory database, failing on its Nth run(). */
const setup = async (failOnRun: number) => {
  const db = new DatabaseSync(':memory:');
  db.exec(PRAGMA_FOREIGN_KEYS_ON);
  db.exec(RECORD_SCHEMA_SQL);
  db.exec(FTS5_SCHEMA_SQL);
  const logic = new SharedSqlRecordLogic({ exec: failingExecutor(db, failOnRun) });
  await logic.saveType(NOTE_TYPE); // one run(), so statement numbering starts at 2
  return { db, logic };
};

const rows = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

const journal = { journal: { ops: ['create' as const], kind: 'created' as const } };

describe('a failed write leaves nothing behind', () => {
  /** Every table a record write can touch, so residue anywhere shows up. */
  const snapshotCounts = (db: DatabaseSync) => ({
    records: rows(db, 'records'),
    associations: rows(db, 'associations'),
    versions: rows(db, 'versions'),
    content_index: rows(db, 'content_index'),
    journal: rows(db, 'journal'),
  });

  // createRecord issues seven statements after saveType's own. Failing on
  // any of them past the first leaves residue without a transaction — and
  // a records row that outlives its own failed create is the worst shape
  // it takes: the call raises, so the caller believes nothing landed,
  // and their retry then fails on the primary key.
  test.each([2, 3, 4, 5, 6, 7, 8])(
    'createRecord failing on statement %i writes nothing',
    async (failOn) => {
      const { db, logic } = await setup(failOn);

      await expect(logic.createRecord(makeRecord(), journal)).rejects.toThrow();

      expect(snapshotCounts(db)).toEqual({
        records: 0,
        associations: 0,
        versions: 0,
        content_index: 0,
        journal: 0,
      });
      db.close();
    },
  );

  test('a successful createRecord writes every table', async () => {
    const { db, logic } = await setup(0); // never fails
    await logic.createRecord(makeRecord(), journal);

    expect(snapshotCounts(db)).toEqual({
      records: 1,
      associations: 1,
      versions: 0,
      content_index: 2, // text + rank
      journal: 1,
    });
    db.close();
  });

  test('mutateRecord failing after it has dropped the association set restores it', async () => {
    const { db, logic } = await setup(0);
    await logic.createRecord(makeRecord(), journal);
    const before = await logic.getRecord('rec000000001');
    const counts = snapshotCounts(db);

    // Statement 5 of mutateRecord is the association re-insert, by which
    // point the snapshot is written, the record row updated, and the old
    // associations deleted.
    const failing = new SharedSqlRecordLogic({ exec: failingExecutor(db, 5) });
    await expect(
      failing.mutateRecord(
        'rec000000001',
        { contentPatch: { text: 'edited' }, associations: [{ kind: 'tag', label: 'moved' }] },
        {
          snapshot: { version: 1, typeId: NOTE, content: before!.content, updatedAt: new Date() },
          journal: { ops: ['patch'], kind: 'changed' },
        },
      ),
    ).rejects.toThrow();

    const after = await logic.getRecord('rec000000001');
    expect(after!.version).toBe(before!.version);
    expect(after!.content).toEqual(before!.content);
    expect(after!.associations).toEqual(before!.associations);
    expect(snapshotCounts(db)).toEqual(counts);
    db.close();
  });

  test('a hard delete failing partway destroys nothing', async () => {
    const { db, logic } = await setup(0);
    await logic.createRecord(makeRecord(), journal);
    const counts = snapshotCounts(db);

    // Statement 5 of the purge, by which point associations, versions and
    // the journal have all been dropped. The verb is irreversible, so a
    // partial one is unrecoverable by definition.
    const failing = new SharedSqlRecordLogic({ exec: failingExecutor(db, 5) });
    await expect(failing.deleteRecord('rec000000001', { hard: true })).rejects.toThrow();

    expect(snapshotCounts(db)).toEqual(counts);
    await expect(logic.getRecord('rec000000001')).resolves.not.toBeNull();
    db.close();
  });
});
