/**
 * Normalizes a SQLite binding's call convention (array-bind-then-step,
 * spread-args run/get/all, cursor-returning exec) behind one interface,
 * so the actual CRUD/query/version/type/association/token logic can live
 * once in this package instead of being re-typed per engine. Each adapter
 * package provides a thin SqlExecutor implementation over its own
 * database handle.
 *
 * Deliberately synchronous: every binding this targets executes queries
 * in-process without yielding, and an async interface would force the
 * shared logic's transaction sequences to interleave.
 */
export interface SqlExecutor {
  /** Run DDL, pragmas, or any statement(s) with no bound params and no results needed. */
  exec(sql: string): void;
  /** Run a single parameterized statement. Returns the number of rows affected (INSERT/UPDATE/DELETE). */
  run(sql: string, params?: readonly unknown[]): number;
  /** Run a parameterized statement and return the first result row, or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  /** Run a parameterized statement and return all result rows. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  /**
   * Run `fn` atomically: every statement it issues commits together, or
   * none do if it throws. `fn` must be synchronous and call back into
   * this executor only — not every engine's transaction primitive can
   * straddle a suspended call. A binding with a real multi-statement
   * transaction (BEGIN/COMMIT/ROLLBACK) implements this with one; a
   * binding whose transaction primitive is itself a callback wrapper
   * (e.g. a Durable Object's storage.transactionSync) can pass `fn`
   * straight through to it.
   */
  transaction<T>(fn: () => T): T;
}

/** SQLite reports FK violations with this exact message; verify it holds when adding an engine. */
export const isForeignKeyViolation = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('FOREIGN KEY constraint failed');

/** SQLite reports a PRIMARY KEY/UNIQUE collision with this exact message. */
export const isUniqueConstraintViolation = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('UNIQUE constraint failed');
