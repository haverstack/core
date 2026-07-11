/**
 * Normalizes sql.js's and node:sqlite's different call conventions
 * (array-bind-then-step vs. spread-args run/get/all) behind one
 * interface, so the actual CRUD/query/version/type/association/token
 * logic can live once in this package instead of being re-typed per
 * engine. Each adapter package provides a thin SqlExecutor
 * implementation over its own database handle.
 */
export interface SqlExecutor {
  /** Run DDL, pragmas, or any statement(s) with no bound params and no results needed. */
  exec(sql: string): void;
  /** Run a single parameterized statement, discarding any result rows. */
  run(sql: string, params?: readonly unknown[]): void;
  /** Run a parameterized statement and return the first result row, or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  /** Run a parameterized statement and return all result rows. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
}

/** Both sql.js's and node:sqlite's SQLite builds report FK violations with this exact message. */
export const isForeignKeyViolation = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('FOREIGN KEY constraint failed');
