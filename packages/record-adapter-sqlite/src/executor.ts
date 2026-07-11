import type { SqlExecutor } from '@haverstack/sqlite-shared';
import { DatabaseSync } from './node-sqlite.js';

/** Normalizes node:sqlite's spread-args run/get/all calls to SqlExecutor. */
export class NativeSqliteExecutor implements SqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []): void {
    this.db.prepare(sql).run(...(params as (string | number | null)[]));
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as (string | number | null)[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as (string | number | null)[])) as T[];
  }
}
