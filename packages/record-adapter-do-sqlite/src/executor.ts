import type { SqlExecutor } from '@haverstack/sqlite-shared/record';

/**
 * Normalizes a Durable Object's ctx.storage.sql to SqlExecutor.
 *
 * Two things don't map onto node:sqlite's shape the way the rest of this
 * interface does:
 *
 * - There is no get/all/run split — sql.exec() always returns a cursor.
 *   get()/all() read it via .toArray(); run() reads .rowsWritten for the
 *   affected-row count run()'s contract promises.
 * - Raw BEGIN/COMMIT/ROLLBACK are rejected outright by DO SQLite (verified
 *   against the real Workers runtime, not assumed) — its storage has no
 *   notion of a transaction left open across separate exec() calls, and
 *   each statement auto-commits the instant it runs, so no-op'ing those
 *   three strings would silently break atomicity, not preserve it. The
 *   platform's real primitive is ctx.storage.transactionSync(fn), which
 *   SqlExecutor.transaction() reaches directly — see docs/spec/adapters.md
 *   § Concurrency & storage ownership.
 */
export class DurableObjectSqliteExecutor implements SqlExecutor {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []): number {
    const cursor = this.sql.exec(sql, ...(params as SqlStorageValue[]));
    return cursor.rowsWritten;
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
    const rows = this.sql.exec(sql, ...(params as SqlStorageValue[])).toArray();
    return rows[0] as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.sql.exec(sql, ...(params as SqlStorageValue[])).toArray() as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
