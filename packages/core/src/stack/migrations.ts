/**
 * Migration registry
 * -------------------------------------------------------
 * The migrations a Stack was opened with, and what this app process
 * understands of each type family. Answers two questions for the Stack:
 * which chain carries a record from one TypeId to another (for
 * migrateAll()), and how a stored record reads at `presentAt: 'latest'`
 * — never written back. See docs/spec/data-model.md § Type migrations.
 */

import { parseTypeId } from '../schema.js';
import { StackMigrationError } from '../errors.js';
import type { StackRecord, TypeId } from '../types/index.js';
import type { Migration } from '../type-handle.js';

export class MigrationRegistry {
  private readonly steps = new Map<TypeId, Migration>();
  /**
   * Highest version this instance has defineType()'d, per baseId — what
   * this app process understands, as distinct from what exists in shared
   * storage. Used to detect the stale-writer case in presentAtLatest().
   */
  private readonly maxDefinedVersion = new Map<string, number>();

  /**
   * Refuses anything the walkers below could not follow. Each TypeId has at
   * most one step out, so the graph is a set of chains, and a walk that
   * comes back to a TypeId it already passed is a cycle.
   */
  constructor(migrations: readonly Migration[]) {
    for (const m of migrations) {
      const from = parseTypeId(m.from);
      const to = parseTypeId(m.to);
      if (!from || !to) {
        throw new StackMigrationError(
          `Migration "${m.from}" → "${m.to}" must name two versioned TypeIds.`,
        );
      }
      if (from.baseId === to.baseId && to.version <= from.version) {
        throw new StackMigrationError(
          `Migration "${m.from}" → "${m.to}" must go to a later version of its family.`,
        );
      }
      if (this.steps.has(m.from)) {
        throw new StackMigrationError(`More than one migration from "${m.from}" was passed.`);
      }
      this.steps.set(m.from, m);
    }
    const acyclic = new Set<TypeId>();
    for (const start of this.steps.keys()) {
      const walked = new Set<TypeId>();
      for (let at: TypeId | undefined = start; at && !acyclic.has(at); ) {
        if (walked.has(at)) {
          throw new StackMigrationError(`The migrations passed form a cycle through "${at}".`);
        }
        walked.add(at);
        at = this.steps.get(at)?.to;
      }
      for (const id of walked) acyclic.add(id);
    }
  }

  /**
   * Record that this instance has defined `version` of `baseId` — on the
   * idempotent-no-op path too, since presentAtLatest()'s stale-writer
   * detection depends on it.
   */
  noteDefined(baseId: string, version: number): void {
    const priorMax = this.maxDefinedVersion.get(baseId) ?? 0;
    if (version > priorMax) this.maxDefinedVersion.set(baseId, version);
  }

  /**
   * Find and compose a migration path from one TypeId to another.
   * Returns null if no path exists.
   */
  path(fromId: TypeId, toId: TypeId): Migration['migrate'] | null {
    if (fromId === toId) return (content) => content;

    const steps: Migration[] = [];
    let current = fromId;

    while (current !== toId) {
      const step = this.steps.get(current);
      if (!step) return null;
      steps.push(step);
      current = step.to;
    }

    return (content) => steps.reduce((c, step) => step.migrate(c), content);
  }

  /**
   * Find the latest registered version of a type family.
   * Follows the migration chain from the given typeId to the end.
   */
  latest(fromId: TypeId): TypeId {
    let current = fromId;
    for (let step = this.steps.get(current); step; step = this.steps.get(current)) {
      current = step.to;
    }
    return current;
  }

  /**
   * Apply the registered migration chain in memory, for presentAt:
   * 'latest'. Never writes back. Throws StackMigrationError when the
   * record's version can't be reconciled with what this instance has
   * registered — the stale-writer case.
   */
  presentAtLatest(record: StackRecord): StackRecord {
    const latestId = this.latest(record.typeId);

    if (latestId !== record.typeId) {
      // latest() found this by walking the same migration graph path()
      // walks, from the same starting point, so a path is always
      // resolvable here.
      const migrateFn = this.path(record.typeId, latestId)!;
      return { ...record, typeId: latestId, content: migrateFn(record.content) };
    }

    const parsed = parseTypeId(record.typeId);
    const knownMax = parsed ? this.maxDefinedVersion.get(parsed.baseId) : undefined;
    if (parsed && knownMax !== undefined && parsed.version !== knownMax) {
      const direction =
        parsed.version > knownMax
          ? `the record is newer than this app instance understands — update the app, or pass it the missing migrations`
          : `no migration passed to Stack.open() bridges the gap`;
      throw new StackMigrationError(
        `Record "${record.id}" is at "${record.typeId}", but this app instance has defined ` +
          `up to "${parsed.baseId}@${knownMax}": ${direction}. Omit presentAt: "latest" to ` +
          `read the record as stored.`,
      );
    }

    return record;
  }
}
