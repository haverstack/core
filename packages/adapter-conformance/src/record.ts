/**
 * Record adapter conformance suite
 * -------------------------------------------------------
 * The middle ground docs/spec/adapters.md describes in prose and, until
 * now, nothing runnable checked a third-party StackRecordAdapter against:
 * an adapter author calls runRecordAdapterConformance() with a way to open
 * their adapter and the capabilities it declares, and gets back the
 * invariants every first-party adapter is held to — FTS5-style search
 * consistency, content-path semantics, version snapshots, `_config`
 * protection, cursor stability, and capability honesty.
 *
 * Capability-gated: `capabilities` is read once, before any test is
 * registered, because vitest builds its test tree synchronously at
 * collection time — long before a `beforeEach` opening a fresh adapter
 * instance has ever run. An adapter that doesn't declare a capability is
 * never penalized for lacking it; declaring one wrong (claiming
 * `filter.content: 'path'` while only matching whole field names, say)
 * is caught because every filtering test here includes a record that
 * must NOT match, not just one that should — the same "unfiltered
 * superset presented as a filtered result" failure
 * assertQueryCapabilities() exists to prevent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { SYSTEM_TYPES } from '@haverstack/core';
import type { StackRecordAdapter, AdapterCapabilities } from '@haverstack/core/adapter';
import { expectStackErrorCode } from './errors.js';
import { CONFORMANCE_TYPE_ID, conformanceType, makeRecord, uniqueId } from './helpers.js';

export interface RecordAdapterConformanceOptions {
  /** Used in describe() titles, so pick something that reads well there. */
  name: string;
  /** Produce a fresh, empty adapter instance. Called before every test. */
  open: () => Promise<StackRecordAdapter> | StackRecordAdapter;
  /** Release what `open()` acquired. Called after every test. */
  close?: (adapter: StackRecordAdapter) => Promise<void> | void;
  /**
   * The capabilities this adapter declares — the same object its own
   * `capabilities` getter returns. Passed explicitly rather than read off
   * an opened instance so suite registration stays synchronous; see the
   * module doc above.
   */
  capabilities: AdapterCapabilities;
}

export function runRecordAdapterConformance(options: RecordAdapterConformanceOptions): void {
  const { name, open, close, capabilities } = options;

  describe(`record adapter conformance: ${name}`, () => {
    let adapter: StackRecordAdapter;

    // `open()` can reject; `adapter` is then unset (or still holds the
    // previous test's, already closed). Closing either way throws over
    // the top of the real initialization error and hides it.
    let opened = false;

    beforeEach(async () => {
      opened = false;
      adapter = await open();
      opened = true;
    });

    afterEach(async () => {
      if (!opened) return;
      opened = false;
      await close?.(adapter);
    });

    // -----------------------------------------------------------------
    // Capabilities
    // -----------------------------------------------------------------
    describe('capabilities', () => {
      test('declares a well-formed AdapterCapabilities object', () => {
        expect(['none', 'field', 'path']).toContain(capabilities.filter.content);
        expect(typeof capabilities.filter.contentPresent).toBe('boolean');
        expect(typeof capabilities.filter.search).toBe('boolean');
        expect(Array.isArray(capabilities.sort.fields)).toBe(true);
        expect(typeof capabilities.sort.contentField).toBe('boolean');
      });

      test('filter.contentPresent is false whenever filter.content is "none"', () => {
        // contentPresent asks whether a value is there at all — meaningless
        // to promise from an adapter that reaches no content to look at.
        if (capabilities.filter.content === 'none') {
          expect(capabilities.filter.contentPresent).toBe(false);
        }
      });
    });

    // -----------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------
    describe('types', () => {
      test('saveType and getType roundtrip', async () => {
        const type = conformanceType();
        await adapter.saveType(type);
        const stored = await adapter.getType(type.id);
        expect(stored?.id).toBe(type.id);
        expect(stored?.schema).toEqual(type.schema);
      });

      test('getType returns null for an unknown id', async () => {
        expect(await adapter.getType('org.haverstack.conformance/nope@1')).toBeNull();
      });

      test('listTypes returns every saved type', async () => {
        await adapter.saveType(conformanceType());
        await adapter.saveType(conformanceType({ id: 'org.haverstack.conformance/other@1' }));
        const types = await adapter.listTypes();
        expect(types.map((t) => t.id).sort()).toEqual(
          ['org.haverstack.conformance/other@1', CONFORMANCE_TYPE_ID].sort(),
        );
      });
    });

    // -----------------------------------------------------------------
    // CRUD
    // -----------------------------------------------------------------
    describe('records — CRUD', () => {
      test('createRecord and getRecord roundtrip', async () => {
        const record = makeRecord({ content: { title: 'Hello' } });
        await adapter.createRecord(record);
        const stored = await adapter.getRecord(record.id);
        expect(stored?.id).toBe(record.id);
        expect(stored?.content).toEqual({ title: 'Hello' });
      });

      test('getRecord returns null for an unknown id', async () => {
        expect(await adapter.getRecord(uniqueId('missing'))).toBeNull();
      });

      test('createRecord throws a conflict for a duplicate id, never a silent overwrite', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await expectStackErrorCode(adapter.createRecord(makeRecord({ id: record.id })), 'conflict');
        expect((await adapter.getRecord(record.id))?.content).toEqual(record.content);
      });

      test('mutateRecord merges the content patch at the top level and bumps version', async () => {
        const record = makeRecord({ content: { title: 'Before', priority: 1 } });
        await adapter.createRecord(record);
        const updated = await adapter.mutateRecord(record.id, {
          contentPatch: { title: 'After' },
        });
        expect(updated.content).toEqual({ title: 'After', priority: 1 });
        expect(updated.version).toBe(record.version + 1);
      });

      test('soft deleteRecord sets deletedAt; undeleteRecord clears it', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const deleted = await adapter.deleteRecord(record.id);
        expect(deleted?.deletedAt).toBeInstanceOf(Date);

        const undeleted = await adapter.undeleteRecord(record.id);
        expect(undeleted.deletedAt).toBeUndefined();
      });

      test('hard deleteRecord removes the record and its version history', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.saveVersion(record.id, {
          version: record.version,
          typeId: record.typeId,
          content: record.content,
          updatedAt: record.updatedAt,
        });

        await adapter.deleteRecord(record.id, { hard: true });
        expect(await adapter.getRecord(record.id)).toBeNull();
        expect(await adapter.getVersions(record.id)).toEqual([]);
      });
    });

    // -----------------------------------------------------------------
    // The `_config` singleton — reserved, never enumerable
    // -----------------------------------------------------------------
    describe('the `_config` record', () => {
      test('queryRecords never returns a record whose id is the reserved `_config` id', async () => {
        // Every first-party adapter creates this singleton during its own
        // initialization, outside this interface — nothing here writes it.
        // The invariant holds either way: if the adapter under test has one,
        // a generic query must still never surface it.
        const { records } = await adapter.queryRecords({});
        expect(records.some((r) => r.id === SYSTEM_TYPES.CONFIG)).toBe(false);
      });
    });

    // -----------------------------------------------------------------
    // Associations
    // -----------------------------------------------------------------
    describe('associations', () => {
      test('associate adds a tag; dissociate removes it; neither bumps version', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);

        const tagged = await adapter.associate(record.id, { kind: 'tag', label: 'important' });
        expect(tagged.associations).toContainEqual({ kind: 'tag', label: 'important' });
        expect(tagged.version).toBe(record.version);

        const untagged = await adapter.dissociate(record.id, {
          kind: 'tag',
          label: 'important',
        });
        expect(untagged.associations ?? []).not.toContainEqual({
          kind: 'tag',
          label: 'important',
        });
        expect(untagged.version).toBe(record.version);
      });

      test('associate is idempotent — a duplicate does not create a second entry', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.associate(record.id, { kind: 'tag', label: 'dup' });
        const twice = await adapter.associate(record.id, { kind: 'tag', label: 'dup' });
        expect(
          twice.associations?.filter((a) => a.kind === 'tag' && a.label === 'dup'),
        ).toHaveLength(1);
      });

      test('associate on a nonexistent record reports not_found rather than creating an orphan', async () => {
        await expectStackErrorCode(
          adapter.associate(uniqueId('missing'), { kind: 'tag', label: 'x' }),
          'not_found',
        );
      });
    });

    // -----------------------------------------------------------------
    // Versions — snapshots and restore
    // -----------------------------------------------------------------
    describe('versions', () => {
      test('saveVersion and getVersion roundtrip', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.saveVersion(record.id, {
          version: record.version,
          typeId: record.typeId,
          content: record.content,
          updatedAt: record.updatedAt,
        });
        const version = await adapter.getVersion(record.id, record.version);
        expect(version?.content).toEqual(record.content);
      });

      test('restoreVersion restores content and parentId, bumps version, and never touches associations', async () => {
        const record = makeRecord({ content: { title: 'v1' } });
        await adapter.createRecord(record);
        await adapter.saveVersion(record.id, {
          version: record.version,
          typeId: record.typeId,
          content: record.content,
          updatedAt: record.updatedAt,
        });
        await adapter.mutateRecord(record.id, { contentPatch: { title: 'v2' } });
        await adapter.associate(record.id, { kind: 'tag', label: 'keep-me' });

        const restored = await adapter.restoreVersion(record.id, record.version);
        expect(restored.content).toEqual({ title: 'v1' });
        expect(restored.version).toBe(record.version + 2); // patch, then restore
        expect(restored.associations).toContainEqual({ kind: 'tag', label: 'keep-me' });
      });

      test('restoreVersion throws not_found for an unknown version', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await expectStackErrorCode(adapter.restoreVersion(record.id, 999), 'not_found');
      });
    });

    // -----------------------------------------------------------------
    // Migration
    // -----------------------------------------------------------------
    describe('commitMigration', () => {
      test('changes typeId and content together, and bumps version', async () => {
        const record = makeRecord({ typeId: 'org.haverstack.conformance/note@1' });
        await adapter.createRecord(record);
        const migrated = await adapter.commitMigration(
          record.id,
          'org.haverstack.conformance/note@2',
          { title: 'migrated' },
        );
        expect(migrated.typeId).toBe('org.haverstack.conformance/note@2');
        expect(migrated.content).toEqual({ title: 'migrated' });
        expect(migrated.version).toBe(record.version + 1);
      });
    });

    // -----------------------------------------------------------------
    // Cursor pagination
    // -----------------------------------------------------------------
    describe('cursor pagination', () => {
      test('pages through more records than fit in one page', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const record = makeRecord();
          ids.push(record.id);
          await adapter.createRecord(record);
        }

        const seen = new Set<string>();
        let cursor: string | null | undefined;
        do {
          const page = await adapter.queryRecords({ limit: 2, cursor: cursor ?? undefined });
          expect(page.records.length).toBeLessThanOrEqual(2);
          for (const r of page.records) seen.add(r.id);
          cursor = page.cursor;
        } while (cursor);

        for (const id of ids) expect(seen.has(id)).toBe(true);
      });

      test('a malformed cursor is refused rather than misread', async () => {
        await expectStackErrorCode(
          adapter.queryRecords({ cursor: 'not-a-real-cursor' }),
          'bad_request',
        );
      });

      test('a cursor minted under one sort field is refused when replayed under a different one', async () => {
        await adapter.createRecord(makeRecord());
        await adapter.createRecord(makeRecord());
        const minted = await adapter.queryRecords({
          limit: 1,
          sort: { field: 'createdAt' },
        });
        expect(minted.cursor).not.toBeNull();
        await expectStackErrorCode(
          adapter.queryRecords({
            limit: 1,
            cursor: minted.cursor!,
            sort: { field: 'updatedAt' },
          }),
          'bad_request',
        );
      });
    });

    // -----------------------------------------------------------------
    // Content filtering — capability-gated on filter.content
    // -----------------------------------------------------------------
    if (capabilities.filter.content !== 'none') {
      describe('content filtering', () => {
        test('filters by a top-level scalar field, excluding what does not match', async () => {
          const match = makeRecord({ content: { title: 'a', priority: 1 } });
          const decoy = makeRecord({ content: { title: 'b', priority: 2 } });
          await adapter.createRecord(match);
          await adapter.createRecord(decoy);

          const result = await adapter.queryRecords({ filter: { content: { priority: 1 } } });
          // The positive assertion first: `not.toContain` and `every` are
          // both vacuously true on an empty result, so without this an
          // adapter that declares filter.content and returns nothing at
          // all would pass the very test meant to catch it.
          expect(result.records.map((r) => r.id)).toContain(match.id);
          expect(result.records.map((r) => r.id)).not.toContain(decoy.id);
          expect(
            result.records.every((r) => (r.content as { priority: number }).priority === 1),
          ).toBe(true);
        });

        test('a null filter value matches records where the field is absent or stored as null', async () => {
          const absent = makeRecord({ content: { title: 'no priority' } });
          const explicitNull = makeRecord({ content: { title: 'null priority', priority: null } });
          const present = makeRecord({ content: { title: 'has one', priority: 1 } });
          await adapter.createRecord(absent);
          await adapter.createRecord(explicitNull);
          await adapter.createRecord(present);

          const result = await adapter.queryRecords({ filter: { content: { priority: null } } });
          const ids = result.records.map((r) => r.id).sort();
          expect(ids).toEqual([absent.id, explicitNull.id].sort());
          expect(ids).not.toContain(present.id);
        });

        test('a scalar filter value never matches an object or array stored at the same path', async () => {
          const scalarMatch = makeRecord({ content: { title: 'x', priority: 1 } });
          const nested = makeRecord({ content: { title: 'y', priority: { high: true } } });
          await adapter.createRecord(scalarMatch);
          await adapter.createRecord(nested);

          const result = await adapter.queryRecords({ filter: { content: { priority: 1 } } });
          expect(result.records.map((r) => r.id)).toContain(scalarMatch.id);
          expect(result.records.map((r) => r.id)).not.toContain(nested.id);
        });

        if (capabilities.filter.contentPresent) {
          test('contentPresent matches records holding a non-null value at the path', async () => {
            const present = makeRecord({ content: { title: 'x', priority: 1 } });
            const absent = makeRecord({ content: { title: 'y' } });
            const nullValue = makeRecord({ content: { title: 'z', priority: null } });
            await adapter.createRecord(present);
            await adapter.createRecord(absent);
            await adapter.createRecord(nullValue);

            const result = await adapter.queryRecords({ filter: { contentPresent: ['priority'] } });
            expect(result.records.map((r) => r.id)).toEqual([present.id]);
          });
        }

        if (capabilities.filter.content === 'path') {
          test('an array is spread element-wise when filtering a nested path', async () => {
            const match = makeRecord({
              content: { title: 'x', emails: [{ value: 'a@b.c' }, { value: 'd@e.f' }] },
            });
            const noMatch = makeRecord({
              content: { title: 'y', emails: [{ value: 'other@x.y' }] },
            });
            await adapter.createRecord(match);
            await adapter.createRecord(noMatch);

            const result = await adapter.queryRecords({
              filter: { content: { 'emails.value': 'a@b.c' } },
            });
            expect(result.records.map((r) => r.id)).toEqual([match.id]);
          });

          test('a nested path filter reaches a property inside a plain (non-array) object', async () => {
            const match = makeRecord({ content: { title: 'x', address: { city: 'Berlin' } } });
            const noMatch = makeRecord({ content: { title: 'y', address: { city: 'Lyon' } } });
            await adapter.createRecord(match);
            await adapter.createRecord(noMatch);

            const result = await adapter.queryRecords({
              filter: { content: { 'address.city': 'Berlin' } },
            });
            expect(result.records.map((r) => r.id)).toEqual([match.id]);
          });

          test('a filter path descending through a scalar matches nothing, rather than throwing', async () => {
            await adapter.createRecord(makeRecord({ content: { title: 'x', priority: 1 } }));
            const result = await adapter.queryRecords({
              filter: { content: { 'priority.nested': 'anything' } },
            });
            expect(result.records).toEqual([]);
          });
        }
      });
    }

    // -----------------------------------------------------------------
    // Sort by content field — capability-gated on sort.contentField
    // -----------------------------------------------------------------
    if (capabilities.sort.contentField) {
      describe('sort by content field', () => {
        test('orders records by a declared content field', async () => {
          // Registered so an adapter that resolves the field's sort kind
          // through the type schema (rather than off the raw JSON value)
          // sorts numerically instead of falling back to no ordering.
          await adapter.saveType(conformanceType());
          await adapter.createRecord(makeRecord({ content: { title: 'x', priority: 3 } }));
          await adapter.createRecord(makeRecord({ content: { title: 'y', priority: 1 } }));
          await adapter.createRecord(makeRecord({ content: { title: 'z', priority: 2 } }));

          const result = await adapter.queryRecords({
            sort: { contentField: 'priority', direction: 'asc' },
          });
          expect(result.records.map((r) => (r.content as { priority: number }).priority)).toEqual([
            1, 2, 3,
          ]);
        });
      });
    }

    // -----------------------------------------------------------------
    // Full-text search — capability-gated on filter.search
    // -----------------------------------------------------------------
    if (capabilities.filter.search) {
      describe('full-text search', () => {
        test('finds a record containing the search term', async () => {
          const match = makeRecord({ content: { title: 'the quick brown fox' } });
          const noMatch = makeRecord({ content: { title: 'something unrelated' } });
          await adapter.createRecord(match);
          await adapter.createRecord(noMatch);

          const result = await adapter.queryRecords({ filter: { search: 'brown' } });
          expect(result.records.map((r) => r.id)).toContain(match.id);
          expect(result.records.map((r) => r.id)).not.toContain(noMatch.id);
        });

        // The invariant the issue's docs/spec/adapters.md § FTS5 names
        // explicitly: an external-content index's remove step must run
        // before the row's content changes, or a stale entry stays
        // searchable under content the record no longer holds.
        test('a content patch is reflected in search — the old content is no longer searchable', async () => {
          const record = makeRecord({ content: { title: 'original wording' } });
          await adapter.createRecord(record);
          await adapter.mutateRecord(record.id, { contentPatch: { title: 'updated wording' } });

          const stale = await adapter.queryRecords({ filter: { search: 'original' } });
          expect(stale.records.map((r) => r.id)).not.toContain(record.id);

          const fresh = await adapter.queryRecords({ filter: { search: 'updated' } });
          expect(fresh.records.map((r) => r.id)).toContain(record.id);
        });

        test('a hard-deleted record is no longer found by search', async () => {
          const record = makeRecord({ content: { title: 'ephemeral content' } });
          await adapter.createRecord(record);
          await adapter.deleteRecord(record.id, { hard: true });

          const result = await adapter.queryRecords({ filter: { search: 'ephemeral' } });
          expect(result.records.map((r) => r.id)).not.toContain(record.id);
        });
      });
    }
  });
}
