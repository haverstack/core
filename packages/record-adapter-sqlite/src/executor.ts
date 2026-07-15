import type { SqlExecutor } from '@haverstack/sqlite-shared';
import { DatabaseSync } from './node-sqlite.js';

/** Normalizes node:sqlite's spread-args run/get/all calls to SqlExecutor. */
export class NativeSqliteExecutor implements SqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []): number {
    const result = this.db.prepare(sql).run(...(params as (string | number | null)[]));
    return Number(result.changes);
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as (string | number | null)[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as (string | number | null)[])) as T[];
  }
}
