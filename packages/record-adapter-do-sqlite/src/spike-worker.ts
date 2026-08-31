import { DurableObject } from 'cloudflare:workers';

type ProbeResult = Record<string, unknown>;

export class SpikeDurableObject extends DurableObject {
  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS parent (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
    `);
  }

  async probePragmas(): Promise<ProbeResult> {
    const out: ProbeResult = {};
    try {
      this.sql.exec('PRAGMA foreign_keys = ON;');
      out.foreignKeysPragma = 'ok';
    } catch (err) {
      out.foreignKeysPragma = `error: ${(err as Error).message}`;
    }
    try {
      const rows = this.sql.exec('PRAGMA foreign_keys;').toArray();
      out.foreignKeysValue = rows;
    } catch (err) {
      out.foreignKeysValue = `error: ${(err as Error).message}`;
    }
    try {
      this.sql.exec('PRAGMA journal_mode = WAL;');
      out.journalModeWalPragma = 'ok';
    } catch (err) {
      out.journalModeWalPragma = `error: ${(err as Error).message}`;
    }
    try {
      const rows = this.sql.exec('PRAGMA journal_mode;').toArray();
      out.journalModeValue = rows;
    } catch (err) {
      out.journalModeValue = `error: ${(err as Error).message}`;
    }
    return out;
  }

  async probeForeignKeyEnforcement(): Promise<ProbeResult> {
    this.schema();
    this.sql.exec('PRAGMA foreign_keys = ON;');
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('p1', 'Parent One');`);
    const out: ProbeResult = {};
    try {
      this.sql.exec(`INSERT INTO child (id, parent_id) VALUES ('c1', 'does-not-exist');`);
      out.danglingInsert = 'succeeded (NO enforcement!)';
    } catch (err) {
      out.danglingInsert = 'rejected';
      out.errorMessage = (err as Error).message;
      out.errorConstructorName = (err as Error).constructor?.name;
      out.errorKeys = Object.keys(err as object);
      out.errorJson = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    }
    return out;
  }

  async probeUniqueViolation(): Promise<ProbeResult> {
    this.schema();
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('dup', 'First');`);
    const out: ProbeResult = {};
    try {
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('dup', 'Second');`);
      out.duplicateInsert = 'succeeded (NO uniqueness enforcement!)';
    } catch (err) {
      out.duplicateInsert = 'rejected';
      out.errorMessage = (err as Error).message;
      out.errorConstructorName = (err as Error).constructor?.name;
    }
    return out;
  }

  async probeRawTransaction(): Promise<ProbeResult> {
    this.schema();
    const out: ProbeResult = {};

    // Commit path
    try {
      this.sql.exec('BEGIN');
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('tx-commit', 'Committed');`);
      this.sql.exec('COMMIT');
      const row = this.sql.exec(`SELECT * FROM parent WHERE id = 'tx-commit';`).toArray();
      out.commitPath = 'ok';
      out.commitRow = row;
    } catch (err) {
      out.commitPath = `error: ${(err as Error).message}`;
    }

    // Rollback path
    try {
      this.sql.exec('BEGIN');
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('tx-rollback', 'ShouldNotPersist');`);
      this.sql.exec('ROLLBACK');
      const row = this.sql
        .exec(`SELECT * FROM parent WHERE id = 'tx-rollback';`)
        .toArray();
      out.rollbackPath = 'ok';
      out.rollbackRowCountAfterRollback = row.length;
    } catch (err) {
      out.rollbackPath = `error: ${(err as Error).message}`;
    }

    // Nested/nested nesting sanity — does a second BEGIN before COMMIT error?
    try {
      this.sql.exec('BEGIN');
      this.sql.exec('BEGIN');
      out.nestedBegin = 'second BEGIN did not throw';
      this.sql.exec('ROLLBACK');
    } catch (err) {
      out.nestedBegin = `threw: ${(err as Error).message}`;
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        /* best-effort cleanup */
      }
    }

    return out;
  }

  async probeCursorShape(): Promise<ProbeResult> {
    this.schema();
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('cur1', 'One'), ('cur2', 'Two');`);
    const cursor = this.sql.exec('SELECT * FROM parent ORDER BY id;');
    const out: ProbeResult = {
      hasToArray: typeof (cursor as any).toArray === 'function',
      hasOne: typeof (cursor as any).one === 'function',
      hasRaw: typeof (cursor as any).raw === 'function',
      hasNext: typeof (cursor as any).next === 'function',
      hasSymbolIterator: typeof (cursor as any)[Symbol.iterator] === 'function',
      columnNames: (cursor as any).columnNames,
      rowsRead: (cursor as any).rowsRead,
      rowsWritten: (cursor as any).rowsWritten,
    };
    out.toArrayResult = cursor.toArray();

    const insertCursor = this.sql.exec(
      `INSERT INTO parent (id, name) VALUES ('cur3', 'Three');`,
    );
    out.insertRowsWritten = (insertCursor as any).rowsWritten;
    out.insertRowsRead = (insertCursor as any).rowsRead;

    const updateCursor = this.sql.exec(`UPDATE parent SET name = 'Updated' WHERE id = 'cur1';`);
    out.updateRowsWritten = (updateCursor as any).rowsWritten;

    const deleteCursor = this.sql.exec(`DELETE FROM parent WHERE id = 'cur2';`);
    out.deleteRowsWritten = (deleteCursor as any).rowsWritten;

    return out;
  }

  async probeFts5(): Promise<ProbeResult> {
    const out: ProbeResult = {};
    try {
      this.sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(content);
      `);
      this.sql.exec(`INSERT INTO docs_fts (rowid, content) VALUES (1, 'the quick brown fox');`);
      this.sql.exec(`INSERT INTO docs_fts (rowid, content) VALUES (2, 'lazy dog sleeps');`);
      const rows = this.sql
        .exec(`SELECT rowid, content FROM docs_fts WHERE docs_fts MATCH 'fox';`)
        .toArray();
      out.fts5 = 'ok';
      out.matchRows = rows;
    } catch (err) {
      out.fts5 = `error: ${(err as Error).message}`;
    }
    return out;
  }

  /**
   * The critical question for #161: SharedSqlRecordLogic issues raw
   * BEGIN/COMMIT/ROLLBACK, which DO SQLite rejects outright (see
   * probeRawTransaction). Its error points at automatic "atomic write
   * coalescing" instead. If that coalescing actually undoes writes when
   * an exception unwinds a synchronous stretch of storage calls — even
   * without ROLLBACK ever being called — then BEGIN/COMMIT/ROLLBACK can
   * become no-ops in the executor with zero changes to the shared logic.
   * This probe writes a row, then throws before returning, with no
   * ROLLBACK anywhere, and reports whether the write survived.
   */
  // NOTE: these deliberately do NOT catch — the exception must actually
  // unwind out of the RPC call boundary for this to test what it claims
  // to test. The caller (test file) awaits-and-catches, then makes a
  // *separate* RPC call to check what actually persisted.

  async writeThenThrow_sync(): Promise<void> {
    this.schema();
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('auto-rb-sync', 'x');`);
    throw new Error('simulated business-logic failure, no ROLLBACK issued');
  }

  async writeThenThrow_microtask(): Promise<void> {
    this.schema();
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('auto-rb-micro', 'x');`);
    await Promise.resolve();
    throw new Error('simulated business-logic failure after a microtask hop');
  }

  async writeThenThrow_multiStatement(): Promise<void> {
    this.schema();
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('multi-1', 'x');`);
    this.sql.exec(`INSERT INTO parent (id, name) VALUES ('multi-2', 'x');`);
    this.sql.exec(`UPDATE parent SET name = 'updated' WHERE id = 'multi-1';`);
    throw new Error('fail after three statements, before returning');
  }

  /**
   * If BEGIN/COMMIT/ROLLBACK become no-ops in the executor, atomicity has
   * to come from somewhere else: wrapping the whole adapter method call
   * in ctx.storage.transactionSync(), whose contract explicitly promises
   * auto-rollback on a thrown exception. Confirms that promise holds for
   * a synchronous multi-statement sequence with mixed reads/writes.
   */
  async transactionSyncThenThrow(): Promise<void> {
    this.schema();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('txsync-1', 'x');`);
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('txsync-2', 'x');`);
      const check = this.sql.exec(`SELECT * FROM parent WHERE id = 'txsync-1';`).toArray();
      if (check.length !== 1) throw new Error('unexpected read result');
      throw new Error('simulated business-logic failure inside transactionSync');
    });
  }

  async transactionSyncReturnsValue(): Promise<ProbeResult> {
    this.schema();
    const result = this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('txsync-ret', 'x');`);
      const row = this.sql.exec(`SELECT * FROM parent WHERE id = 'txsync-ret';`).one();
      return { fromInsideTxn: row };
    });
    return { returnedValue: result };
  }

  async transactionSyncCommits(): Promise<ProbeResult> {
    this.schema();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO parent (id, name) VALUES ('txsync-ok', 'x');`);
    });
    const rows = this.sql.exec(`SELECT * FROM parent WHERE id = 'txsync-ok';`).toArray();
    return { rows };
  }

  async checkSurvivors(likePattern: string): Promise<ProbeResult> {
    const rows = this.sql.exec(`SELECT * FROM parent WHERE id LIKE ? ORDER BY id;`, likePattern).toArray();
    return { rows };
  }

  async probeBindingStyle(): Promise<ProbeResult> {
    this.schema();
    const out: ProbeResult = {};
    try {
      this.sql.exec(`INSERT INTO parent (id, name) VALUES (?, ?);`, 'bind1', 'Bound Name');
      const row = this.sql.exec(`SELECT * FROM parent WHERE id = ?;`, 'bind1').toArray();
      out.spreadArgsBinding = 'ok';
      out.row = row;
    } catch (err) {
      out.spreadArgsBinding = `error: ${(err as Error).message}`;
    }
    return out;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('spike worker: no HTTP surface, use RPC stub methods in tests');
  },
};
