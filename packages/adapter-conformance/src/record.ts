/**
 * Record adapter conformance suite
 * -------------------------------------------------------
 * A runnable check of what docs/spec/adapters.md describes in prose for a
 * third-party StackRecordAdapter: an adapter author calls runRecordAdapterConformance() with a way to open
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
import type {
  AuthorityAssociation,
  DataAssociation,
  RecordFilter,
  RecordJournalEntry,
  StackCapabilities,
  StackQuery,
  StackRecord,
} from '@haverstack/core';
import { ElementSetMovedError, inReach, resolveQuery } from '@haverstack/core/adapter';
import type { Reach, StackRecordAdapter } from '@haverstack/core/adapter';

type PermissionElement = Extract<AuthorityAssociation, { kind: 'permission' }>;
import { expectStackErrorCode } from './errors.js';
import {
  CONFORMANCE_TYPE_ID,
  conformanceType,
  makeRecord,
  snapshotOf,
  uniqueId,
} from './helpers.js';

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
  capabilities: StackCapabilities;
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

    /**
     * Patch `record` `count` times, each patch snapshotting the version it
     * replaces, as Stack does: versions 1 through `count` end up stored.
     */
    const patchWithSnapshots = async (record: StackRecord, count: number) => {
      let current = record;
      for (let i = 0; i < count; i++) {
        current = await adapter.patchContent(
          current.id,
          { title: `v${current.version + 1}` },
          { snapshot: snapshotOf(current) },
        );
      }
      return current;
    };

    // -----------------------------------------------------------------
    // Capabilities
    // -----------------------------------------------------------------
    describe('capabilities', () => {
      test('declares a well-formed StackCapabilities object', () => {
        expect(['none', 'field', 'path']).toContain(capabilities.filter.content);
        for (const flag of [
          capabilities.filter.contentPresent,
          capabilities.filter.contentByType,
          capabilities.filter.search,
          capabilities.sort.contentField,
          capabilities.sort.contentFieldByType,
        ]) {
          expect(typeof flag).toBe('boolean');
        }
        expect(Array.isArray(capabilities.sort.fields)).toBe(true);
      });

      // Each travels only in the POST /records/query body, which a reach of
      // "none" does not serve.
      test('what needs the query body is false whenever filter.content is "none"', () => {
        if (capabilities.filter.content === 'none') {
          expect(capabilities.filter.contentPresent).toBe(false);
          expect(capabilities.filter.contentByType).toBe(false);
          expect(capabilities.sort.contentFieldByType).toBe(false);
        }
      });

      // A query naming no sort reads `createdAt`, newest first, so every
      // adapter already orders by it.
      test('sort.fields includes createdAt', () => {
        expect(capabilities.sort.fields).toContain('createdAt');
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

      test('a content field set to undefined reads back absent', async () => {
        const record = makeRecord({ content: { title: 'Hello', priority: undefined } });
        await adapter.createRecord(record);
        const stored = await adapter.getRecord(record.id);
        expect(Object.keys(stored?.content ?? {})).toEqual(['title']);
        expect(stored?.content).not.toHaveProperty('priority');
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

      test('patchContent merges the patch at the top level and bumps version', async () => {
        const record = makeRecord({ content: { title: 'Before', priority: 1 } });
        await adapter.createRecord(record);
        const updated = await adapter.patchContent(record.id, { title: 'After' });
        expect(updated.content).toEqual({ title: 'After', priority: 1 });
        expect(updated.version).toBe(record.version + 1);
      });

      // The aspects the journal keeps in full never bump: the column lands,
      // and `version`, `updatedAt` and the actor stamps do not move.
      // See docs/spec/versioning.md § Version history.
      test('setParent and setUnlisted write their column without moving version', async () => {
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const record = makeRecord({ content: { title: 'Hello' } });
        await adapter.createRecord(record);

        const moved = await adapter.setParent(record.id, parent.id);
        expect(moved.parentId).toBe(parent.id);
        expect(moved.version).toBe(record.version);
        expect(moved.updatedAt).toEqual(record.updatedAt);

        const unlisted = await adapter.setUnlisted(record.id, true);
        expect(unlisted.unlistedAt).toBeInstanceOf(Date);
        expect(unlisted.version).toBe(record.version);
        expect(unlisted.parentId).toBe(parent.id);

        const listed = await adapter.setUnlisted(record.id, false);
        expect(listed.unlistedAt).toBeUndefined();
        expect(listed.version).toBe(record.version);

        const rooted = await adapter.setParent(record.id, null);
        expect(rooted.parentId).toBeUndefined();
      });

      test('a write that does not bump takes no snapshot', async () => {
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.setParent(record.id, parent.id);
        await adapter.setUnlisted(record.id, true);
        await adapter.setAssociations(record.id, [{ kind: 'tag', label: 'x' }]);
        await adapter.setAccess(record.id, [{ kind: 'anyone', label: 'read' }]);
        expect(await adapter.getVersions(record.id)).toEqual([]);
      });

      // Every write checks its precondition inside its own write, whether
      // or not it bumps. See docs/spec/versioning.md § Optimistic concurrency.
      test('every write refuses a stale ifVersion and changes nothing', async () => {
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const record = makeRecord({ content: { title: 'v1' } });
        await adapter.createRecord(record);
        const stale = { ifVersion: record.version + 1 };
        const tag = { kind: 'tag' as const, label: 'x' };
        const anyone: AuthorityAssociation = { kind: 'anyone', label: 'read' };

        for (const write of [
          () => adapter.patchContent(record.id, { title: 'v2' }, stale),
          () => adapter.setParent(record.id, parent.id, stale),
          () => adapter.setUnlisted(record.id, true, stale),
          () => adapter.editAssociations(record.id, [{ op: 'add', association: tag }], stale),
          () => adapter.setAssociations(record.id, [tag], stale),
          () => adapter.editAccess(record.id, [{ op: 'add', association: anyone }], stale),
          () => adapter.setAccess(record.id, [anyone], stale),
        ]) {
          await expectStackErrorCode(write(), 'version_conflict');
        }
        const after = await adapter.getRecord(record.id);
        expect(after!.content).toEqual({ title: 'v1' });
        expect(after!.parentId).toBeUndefined();
        expect(after!.unlistedAt).toBeUndefined();
        expect(after!.associations ?? []).toEqual([]);
        expect(after!.permissions ?? []).toEqual([]);

        const current = { ifVersion: record.version };
        expect((await adapter.setParent(record.id, parent.id, current)).parentId).toBe(parent.id);
        expect((await adapter.setAccess(record.id, [anyone], current)).permissions).toEqual([
          anyone,
        ]);
      });

      test('soft deleteRecord sets deletedAt; undeleteRecord clears it', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const deleted = await adapter.deleteRecord(record.id);
        expect(deleted?.deletedAt).toBeInstanceOf(Date);

        const undeleted = await adapter.undeleteRecord(record.id);
        expect(undeleted.deletedAt).toBeUndefined();
      });

      test('getVersions returns snapshots oldest first', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await patchWithSnapshots(record, 3);
        expect((await adapter.getVersions(record.id)).map((v) => v.version)).toEqual([1, 2, 3]);
      });

      test('getVersions pages walk every version exactly once, oldest first', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await patchWithSnapshots(record, 5);
        const seen: number[] = [];
        let afterVersion: number | undefined;
        for (;;) {
          const page = await adapter.getVersions(record.id, { afterVersion, limit: 2 });
          if (page.length === 0) break;
          expect(page.length).toBeLessThanOrEqual(2);
          seen.push(...page.map((v) => v.version));
          afterVersion = page[page.length - 1].version;
        }
        expect(seen).toEqual([1, 2, 3, 4, 5]);
      });

      test('getVersions afterVersion is exclusive and limit bounds the result', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await patchWithSnapshots(record, 3);
        const versionsOf = async (query: { afterVersion?: number; limit?: number }) =>
          (await adapter.getVersions(record.id, query)).map((v) => v.version);
        expect(await versionsOf({ afterVersion: 1 })).toEqual([2, 3]);
        expect(await versionsOf({ afterVersion: 3 })).toEqual([]);
        expect(await versionsOf({ afterVersion: 0 })).toEqual([1, 2, 3]);
        expect(await versionsOf({ limit: 1 })).toEqual([1]);
        expect(await versionsOf({ afterVersion: 1, limit: 1 })).toEqual([2]);
        expect(await versionsOf({})).toEqual([1, 2, 3]);
      });

      test('purging deleteRecord removes the record and its version history', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await patchWithSnapshots(record, 1);

        await adapter.deleteRecord(record.id, { purge: true });
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
        const { records } = await adapter.queryRecords(resolveQuery({}));
        expect(records.some((r) => r.id === SYSTEM_TYPES.CONFIG)).toBe(false);
      });
    });

    // -----------------------------------------------------------------
    // Associations
    // -----------------------------------------------------------------
    describe('associations', () => {
      const tag = (label: string) => ({ kind: 'tag' as const, label });

      // A tag filter is conjunctive, and its length is the caller's — far
      // past any statement's parameter cap (100 on Durable Object SQLite).
      test('a tag filter matches the records carrying every tag named, however many', async () => {
        const labels = Array.from({ length: 120 }, (_, i) => `tag-${i}`);
        const all = makeRecord({ associations: labels.map((label) => ({ kind: 'tag', label })) });
        const allButOne = makeRecord({
          associations: labels.slice(1).map((label) => ({ kind: 'tag', label })),
        });
        await adapter.createRecord(all);
        await adapter.createRecord(allButOne);

        const result = await adapter.queryRecords(
          resolveQuery({ filter: { tags: [...labels, labels[0]!] } }),
        );
        expect(result.records.map((r) => r.id)).toEqual([all.id]);
      });

      test('an add puts a tag on the record and a remove takes it off; neither bumps version', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);

        const tagged = await adapter.editAssociations(record.id, [
          { op: 'add', association: { kind: 'tag', label: 'important' } },
        ]);
        expect(tagged.associations).toContainEqual({ kind: 'tag', label: 'important' });
        expect(tagged.version).toBe(record.version);

        const untagged = await adapter.editAssociations(record.id, [
          {
            op: 'remove',
            association: {
              kind: 'tag',
              label: 'important',
            },
          },
        ]);
        expect(untagged.associations ?? []).not.toContainEqual({
          kind: 'tag',
          label: 'important',
        });
        expect(untagged.version).toBe(record.version);
      });

      test('an add is idempotent — a duplicate does not create a second entry', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.editAssociations(record.id, [
          { op: 'add', association: { kind: 'tag', label: 'dup' } },
        ]);
        const twice = await adapter.editAssociations(record.id, [
          { op: 'add', association: { kind: 'tag', label: 'dup' } },
        ]);
        expect(
          twice.associations?.filter((a) => a.kind === 'tag' && a.label === 'dup'),
        ).toHaveLength(1);
      });

      test('an edit on a nonexistent record reports not_found rather than creating an orphan', async () => {
        await expectStackErrorCode(
          adapter.editAssociations(uniqueId('missing'), [
            { op: 'add', association: { kind: 'tag', label: 'x' } },
          ]),
          'not_found',
        );
      });

      // Data associations and permissions are two aspects, stored apart:
      // a write to one never reads or moves the other.
      // See docs/spec/access-control.md § Record-level permissions.
      test('permissions are their own aspect, edited and replaced apart from associations', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const grant: AuthorityAssociation = {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkConformance' },
        };
        // A grantee and a relationship target naming the same entity are
        // two different facts.
        const related = {
          kind: 'relationship' as const,
          label: 'read',
          target: { kind: 'entity' as const, entityId: 'did:key:z6MkConformance' },
        };

        await adapter.editAssociations(record.id, [{ op: 'add', association: related }]);
        const granted = await adapter.editAccess(record.id, [{ op: 'add', association: grant }]);
        expect(granted.permissions).toEqual([grant]);
        expect(granted.associations).toEqual([related]);
        expect(granted.version).toBe(record.version);

        const revoked = await adapter.editAccess(record.id, [{ op: 'remove', association: grant }]);
        expect(revoked.permissions ?? []).toEqual([]);
        expect(revoked.associations).toEqual([related]);
      });

      test('a group grantee keeps its role — member and admin are two entries', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const groupId = uniqueId('grp');
        const forRole = (role: 'member' | 'admin'): AuthorityAssociation => ({
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId, role },
        });
        const member = forRole('member');
        const admin = forRole('admin');

        await adapter.editAccess(record.id, [{ op: 'add', association: member }]);
        const both = await adapter.editAccess(record.id, [{ op: 'add', association: admin }]);
        expect(both.permissions).toEqual(expect.arrayContaining([member, admin]));
        expect(both.permissions).toHaveLength(2);
      });

      test('a list of adds and removes lands as one write that bumps no version', async () => {
        const record = makeRecord();
        await adapter.createRecord(record, { journal: { ops: ['create'], kind: 'created' } });
        await adapter.editAssociations(record.id, [{ op: 'add', association: tag('old') }]);

        const amended = await adapter.editAssociations(
          record.id,
          [
            { op: 'remove', association: tag('old') },
            { op: 'add', association: tag('new') },
            { op: 'add', association: tag('extra') },
          ],
          { journal: { ops: ['associate', 'dissociate'], kind: 'changed' } },
        );

        expect(amended.associations).toEqual(expect.arrayContaining([tag('new'), tag('extra')]));
        expect(amended.associations).toHaveLength(2);
        expect(amended.version).toBe(record.version);
        expect(amended.updatedAt).toEqual(record.updatedAt);
        expect(await adapter.getJournal(record.id)).toHaveLength(2);
      });

      // The compare-and-swap Stack retries on: the set its rules were asked
      // of must be the set the write lands on. Order is not part of a set.
      // See docs/spec/adapters.md § Editing associations.
      test('an element write refuses an expectSet the stored set no longer matches, and changes nothing', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const anyone: AuthorityAssociation = { kind: 'anyone', label: 'read' };
        await adapter.setAssociations(record.id, [tag('a'), tag('b')]);
        await adapter.setAccess(record.id, [anyone]);

        const journal = { ops: ['associate' as const], kind: 'changed' as const };
        const staleTags = { expectSet: [tag('a')], journal };
        const stalePermissions = { expectSet: [], journal };
        for (const write of [
          () =>
            adapter.editAssociations(record.id, [{ op: 'add', association: tag('c') }], staleTags),
          () => adapter.setAssociations(record.id, [tag('c')], staleTags),
          () =>
            adapter.editAccess(
              record.id,
              [{ op: 'remove', association: anyone }],
              stalePermissions,
            ),
          () => adapter.setAccess(record.id, [], stalePermissions),
        ]) {
          await expect(write()).rejects.toBeInstanceOf(ElementSetMovedError);
        }
        const after = await adapter.getRecord(record.id);
        expect(after!.associations).toEqual(expect.arrayContaining([tag('a'), tag('b')]));
        expect(after!.associations).toHaveLength(2);
        expect(after!.permissions).toEqual([anyone]);
        expect(await adapter.getJournal(record.id)).toHaveLength(0);

        const held = await adapter.editAssociations(
          record.id,
          [{ op: 'add', association: tag('c') }],
          { expectSet: [tag('b'), tag('a')] },
        );
        expect(held.associations).toHaveLength(3);
        const cleared = await adapter.setAccess(record.id, [], { expectSet: [anyone] });
        expect(cleared.permissions ?? []).toEqual([]);
      });

      // Asked before ifVersion: the stale version here would otherwise
      // answer 412 for a record whose state is the reason for refusing.
      // See docs/spec/adapters.md § Interface split.
      test('an aspect write refuses a soft-deleted record, and changes nothing', async () => {
        const parent = makeRecord();
        const record = makeRecord();
        await adapter.createRecord(parent);
        await adapter.createRecord(record);
        await adapter.deleteRecord(record.id);
        const before = await adapter.getRecord(record.id);
        const journalBefore = await adapter.getJournal(record.id);

        const anyone: AuthorityAssociation = { kind: 'anyone', label: 'read' };
        const journal = { ops: ['associate' as const], kind: 'changed' as const };
        const opts = { ifVersion: record.version, journal };
        for (const write of [
          () => adapter.setParent(record.id, parent.id, opts),
          () => adapter.setUnlisted(record.id, true, opts),
          () => adapter.editAssociations(record.id, [{ op: 'add', association: tag('a') }], opts),
          () => adapter.setAssociations(record.id, [tag('a')], opts),
          () => adapter.editAccess(record.id, [{ op: 'add', association: anyone }], opts),
          () => adapter.setAccess(record.id, [anyone], opts),
        ]) {
          await expectStackErrorCode(write(), 'conflict');
        }
        expect(await adapter.getRecord(record.id)).toEqual(before);
        expect(await adapter.getJournal(record.id)).toEqual(journalBefore);
      });

      // Stack's expectSet is what getRecord() answered, so a set read back
      // must match itself in every shape an element can take.
      test('a set read back through getRecord matches itself as expectSet', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const associations: DataAssociation[] = [
          tag('t'),
          { kind: 'attachment', label: 'cover', fileId: 'a'.repeat(64) },
          {
            kind: 'attachment',
            label: 'cover',
            fileId: 'b'.repeat(64),
            attachmentRecordId: uniqueId('att'),
          },
          { kind: 'relationship', label: 'cites', target: { kind: 'record', recordId: 'r1' } },
          {
            kind: 'relationship',
            label: 'cites',
            target: { kind: 'record', recordId: 'r1', stackUrl: 'https://example.com' },
          },
          {
            kind: 'relationship',
            label: 'about',
            target: { kind: 'entity', entityId: 'did:key:z6MkConformance' },
          },
          {
            kind: 'relationship',
            label: 'link',
            target: { kind: 'external', ns: 'isbn', id: '1' },
          },
        ];
        const permissions: AuthorityAssociation[] = [
          { kind: 'anyone', label: 'read' },
          {
            kind: 'permission',
            label: 'read',
            grantee: { kind: 'entity', entityId: 'did:key:z6MkConformance' },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { kind: 'group', groupId: uniqueId('grp'), role: 'admin' },
          },
        ];
        await adapter.setAssociations(record.id, associations);
        await adapter.setAccess(record.id, permissions);

        const read = (await adapter.getRecord(record.id))!;
        const tagged = await adapter.editAssociations(
          record.id,
          [{ op: 'add', association: tag('u') }],
          { expectSet: read.associations ?? [] },
        );
        expect(tagged.associations).toHaveLength(associations.length + 1);
        const shared = await adapter.setAccess(record.id, permissions.slice(1), {
          expectSet: read.permissions ?? [],
        });
        expect(shared.permissions).toHaveLength(permissions.length - 1);
      });

      test('each set verb replaces only its own aspect', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        const anyone: AuthorityAssociation = { kind: 'anyone', label: 'read' };
        await adapter.editAssociations(record.id, [
          { op: 'add', association: { kind: 'tag', label: 'draft' } },
        ]);
        await adapter.editAccess(record.id, [{ op: 'add', association: anyone }]);

        const retagged = await adapter.setAssociations(record.id, [
          { kind: 'tag', label: 'reviewed' },
        ]);
        expect(retagged.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
        expect(retagged.permissions).toEqual([anyone]);

        const cleared = await adapter.setAccess(record.id, []);
        expect(cleared.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
        expect(cleared.permissions ?? []).toEqual([]);
        expect(cleared.version).toBe(record.version);
      });
    });

    // -----------------------------------------------------------------
    // Versions — snapshots and restore
    // -----------------------------------------------------------------
    describe('versions', () => {
      test("a patch's snapshot reads back through getVersion", async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await patchWithSnapshots(record, 1);
        const version = await adapter.getVersion(record.id, record.version);
        expect(version?.content).toEqual(record.content);
      });

      test('restoreVersion restores content, bumps version, and leaves containment and associations where they stand', async () => {
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const record = makeRecord({ content: { title: 'v1' } });
        await adapter.createRecord(record);
        await adapter.patchContent(record.id, { title: 'v2' }, { snapshot: snapshotOf(record) });
        await adapter.setParent(record.id, parent.id);
        await adapter.editAssociations(record.id, [
          { op: 'add', association: { kind: 'tag', label: 'keep-me' } },
        ]);

        const restored = await adapter.restoreVersion(record.id, record.version);
        expect(restored.content).toEqual({ title: 'v1' });
        expect(restored.version).toBe(record.version + 2); // patch, then restore
        expect(restored.parentId).toBe(parent.id);
        expect(restored.associations).toContainEqual({ kind: 'tag', label: 'keep-me' });
      });

      test('restoreVersion throws not_found for an unknown version', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await expectStackErrorCode(adapter.restoreVersion(record.id, 999), 'not_found');
      });
    });

    // -----------------------------------------------------------------
    // Importing a record — optional, so each test asks whether the adapter
    // has importRecord() at all. See docs/spec/portability.md § Writing
    // history.
    // -----------------------------------------------------------------
    describe('importing a record', () => {
      const AUTHOR = { subjectId: 'did:key:conformance-author' };
      const EDITOR = { subjectId: 'did:key:conformance-editor', principalId: 'did:key:app' };
      const at = (day: number) => new Date(Date.UTC(2024, 0, day));
      const pinned: DataAssociation = { kind: 'tag', label: 'pinned' };

      /** A record with a past: two versions, four journal entries, every optional field set. */
      const withPast = (parentId: string) => {
        const record = makeRecord({
          content: { title: 'v2' },
          createdAt: at(1),
          updatedAt: at(2),
          version: 2,
          parentId,
          appId: 'org.haverstack.conformance',
          createdBy: AUTHOR,
          updatedBy: EDITOR,
          unlistedAt: at(3),
          associations: [pinned],
          permissions: [{ kind: 'anyone', label: 'read' }],
        });
        const versions = [
          {
            version: 1,
            typeId: record.typeId,
            content: { title: 'v1' },
            updatedAt: at(1),
            createdBy: AUTHOR,
            updatedBy: AUTHOR,
          },
        ];
        const journal: RecordJournalEntry[] = [
          {
            seq: 1,
            at: at(1),
            kind: 'created',
            ops: ['create'],
            version: 1,
            typeId: record.typeId,
            actor: AUTHOR,
          },
          {
            seq: 2,
            at: at(2),
            kind: 'changed',
            ops: ['patch'],
            version: 2,
            typeId: record.typeId,
            actor: EDITOR,
          },
          {
            seq: 3,
            at: at(3),
            kind: 'changed',
            ops: ['reparent'],
            version: 2,
            typeId: record.typeId,
            parentId,
            previousParentId: null,
            actor: EDITOR,
          },
          {
            seq: 4,
            at: at(3),
            kind: 'changed',
            ops: ['associate', 'unlist'],
            version: 2,
            typeId: record.typeId,
            parentId,
            associations: [{ op: 'add', association: pinned }],
          },
        ];
        return { record, versions, journal };
      };

      test('writes the record, its versions and its journal exactly as recorded', async () => {
        if (!adapter.importRecord) return;
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const { record, versions, journal } = withPast(parent.id);
        expect(await adapter.importRecord(record, { versions, journal })).toEqual(record);
        expect(await adapter.getRecord(record.id)).toEqual(record);
        expect(await adapter.getVersions(record.id)).toEqual(versions);
        expect(await adapter.getJournal(record.id)).toEqual(journal);
      });

      test('appends no journal entry of its own', async () => {
        if (!adapter.importRecord) return;
        const record = makeRecord();
        await adapter.importRecord(record, { versions: [], journal: [] });
        expect(await adapter.getJournal(record.id)).toEqual([]);
      });

      test('refuses an id that already exists', async () => {
        if (!adapter.importRecord) return;
        const record = makeRecord();
        await adapter.createRecord(record);
        await expectStackErrorCode(
          adapter.importRecord(record, { versions: [], journal: [] }),
          'conflict',
        );
      });

      test('an imported record answers queries as a created one does', async () => {
        if (!adapter.importRecord) return;
        const record = makeRecord({ content: { title: 'imported' }, associations: [pinned] });
        await adapter.importRecord(record, { versions: [], journal: [] });
        const byTag = await adapter.queryRecords(resolveQuery({ filter: { tags: ['pinned'] } }));
        expect(byTag.records.map((r) => r.id)).toEqual([record.id]);
        if (capabilities.filter.content !== 'none') {
          const byContent = await adapter.queryRecords(
            resolveQuery({ filter: { content: { title: 'imported' } } }),
          );
          expect(byContent.records.map((r) => r.id)).toEqual([record.id]);
        }
      });

      test('a write after an import continues its history', async () => {
        if (!adapter.importRecord) return;
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const { record, versions, journal } = withPast(parent.id);
        await adapter.importRecord(record, { versions, journal });

        const patched = await adapter.patchContent(
          record.id,
          { title: 'v3' },
          { snapshot: snapshotOf(record), journal: { ops: ['patch'], kind: 'changed' } },
        );
        expect(patched.version).toBe(3);
        expect((await adapter.getVersions(record.id)).map((v) => v.version)).toEqual([1, 2]);
        expect((await adapter.getJournal(record.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      });
    });

    // -----------------------------------------------------------------
    // Change journal — the second durable tier
    // -----------------------------------------------------------------
    describe('change journal', () => {
      test('getJournal is implemented, and an empty log means nothing changed', async () => {
        // Not an optional method: "nothing changed" and "this adapter does
        // not remember" are different answers, and an empty log has to mean
        // the first unconditionally. See docs/spec/journal.md § Reading it.
        expect(typeof adapter.getJournal).toBe('function');
        const record = makeRecord();
        await adapter.createRecord(record);
        expect(await adapter.getJournal(record.id)).toEqual([]);
      });

      test('a record that is not there is refused, never answered empty', async () => {
        // The one case where an empty log would mean something other than
        // "nothing changed". See docs/spec/journal.md § Reading it.
        await expectStackErrorCode(adapter.getJournal(uniqueId('missing')), 'not_found');
      });

      test('an entry is stamped from the row the write produced, not from the caller', async () => {
        const record = makeRecord({ content: { title: 'v1' } });
        await adapter.createRecord(record, {
          journal: { ops: ['create'], kind: 'created' },
        });
        await adapter.patchContent(
          record.id,
          { title: 'v2' },
          { journal: { ops: ['patch'], kind: 'changed' } },
        );

        const log = await adapter.getJournal(record.id);
        expect(log).toHaveLength(2);
        // version, typeId and parentId are the adapter's to stamp: Stack
        // supplies only the half the record cannot report afterwards.
        expect(log[0]!.version).toBe(record.version);
        expect(log[1]!.version).toBe(record.version + 1);
        expect(log[0]!.typeId).toBe(record.typeId);
        expect(log[0]!.at).toBeInstanceOf(Date);
      });

      test('seq is dense from 1, ascending, and counted per record', async () => {
        const first = makeRecord();
        const second = makeRecord();
        await adapter.createRecord(first, { journal: { ops: ['create'], kind: 'created' } });
        await adapter.createRecord(second, { journal: { ops: ['create'], kind: 'created' } });
        await adapter.editAssociations(
          first.id,
          [{ op: 'add', association: { kind: 'tag', label: 'a' } }],
          { journal: { ops: ['associate'], kind: 'changed' } },
        );
        await adapter.editAssociations(
          first.id,
          [{ op: 'add', association: { kind: 'tag', label: 'b' } }],
          { journal: { ops: ['associate'], kind: 'changed' } },
        );

        expect((await adapter.getJournal(first.id)).map((e) => e.seq)).toEqual([1, 2, 3]);
        // Per record, so a busy neighbour never advances this one's log.
        expect((await adapter.getJournal(second.id)).map((e) => e.seq)).toEqual([1]);
      });

      test('an association change journals a version that stands still', async () => {
        const record = makeRecord();
        await adapter.createRecord(record);
        await adapter.editAssociations(
          record.id,
          [{ op: 'add', association: { kind: 'tag', label: 'starred' } }],
          {
            journal: {
              ops: ['associate'],
              kind: 'changed',
              associations: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }],
            },
          },
        );
        await adapter.editAssociations(
          record.id,
          [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }],
          {
            journal: {
              ops: ['dissociate'],
              kind: 'changed',
              associations: [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }],
            },
          },
        );

        const log = await adapter.getJournal(record.id);
        expect(log.map((e) => e.version)).toEqual([record.version, record.version]);
        expect(log[0]!.associations).toEqual([
          { op: 'add', association: { kind: 'tag', label: 'starred' } },
        ]);
        expect(log[1]!.associations).toEqual([
          { op: 'remove', association: { kind: 'tag', label: 'starred' } },
        ]);
      });

      test("a repoint's previous survives the round trip", async () => {
        // The half with no counterpart on the change feed, and the whole
        // reason this tier exists: nothing else retains the
        // attachmentRecordId a re-point discarded.
        const record = makeRecord();
        await adapter.createRecord(record);
        const previous = {
          kind: 'attachment' as const,
          label: 'avatar',
          fileId: 'a'.repeat(64),
          attachmentRecordId: uniqueId('old'),
        };
        const association = {
          kind: 'attachment' as const,
          label: 'avatar',
          fileId: 'a'.repeat(64),
          attachmentRecordId: uniqueId('new'),
        };
        await adapter.editAssociations(record.id, [{ op: 'add', association: association }], {
          journal: {
            ops: ['associate'],
            kind: 'changed',
            associations: [{ op: 'repoint', association, previous }],
          },
        });
        const [entry] = await adapter.getJournal(record.id);
        expect(entry!.associations).toEqual([{ op: 'repoint', association, previous }]);
      });

      test('a removal keeps the annotation it carried', async () => {
        // A removed association is as undoable from the log as a re-pointed
        // one: `previous` is the association in full, attachmentRecordId
        // included, not the identity a change frame reports.
        const record = makeRecord();
        await adapter.createRecord(record);
        const previous = {
          kind: 'attachment' as const,
          label: 'cover',
          fileId: 'b'.repeat(64),
          attachmentRecordId: uniqueId('upload'),
        };
        await adapter.editAssociations(record.id, [{ op: 'add', association: previous }]);
        await adapter.editAssociations(
          record.id,
          [
            {
              op: 'remove',
              association: { kind: 'attachment', label: 'cover', fileId: 'b'.repeat(64) },
            },
          ],
          {
            journal: {
              ops: ['dissociate'],
              kind: 'changed',
              associations: [{ op: 'remove', association: previous }],
            },
          },
        );
        const [entry] = await adapter.getJournal(record.id);
        expect(entry!.associations).toEqual([{ op: 'remove', association: previous }]);
      });

      test('previousParentId tells "did not move" apart from "moved off the root"', async () => {
        // The one field on any entry where null is a value rather than an
        // input spelling. Collapsing both to absent loses which happened —
        // and since a move takes no snapshot, this entry is the only place
        // its origin survives at all.
        const parent = makeRecord();
        await adapter.createRecord(parent);
        const record = makeRecord();
        await adapter.createRecord(record, { journal: { ops: ['create'], kind: 'created' } });
        await adapter.setParent(record.id, parent.id, {
          journal: { ops: ['reparent'], kind: 'changed', previousParentId: null },
        });

        const log = await adapter.getJournal(record.id);
        expect(log[0]!.previousParentId).toBeUndefined();
        expect(log[1]!.previousParentId).toBeNull();
        expect(log[1]!.parentId).toBe(parent.id);
      });

      test('afterSeq is exclusive, limit bounds, and omitting both reads the whole log', async () => {
        const record = makeRecord();
        await adapter.createRecord(record, { journal: { ops: ['create'], kind: 'created' } });
        for (const label of ['a', 'b', 'c']) {
          await adapter.editAssociations(
            record.id,
            [{ op: 'add', association: { kind: 'tag', label } }],
            { journal: { ops: ['associate'], kind: 'changed' } },
          );
        }

        expect(await adapter.getJournal(record.id)).toHaveLength(4);
        expect((await adapter.getJournal(record.id, { afterSeq: 2 })).map((e) => e.seq)).toEqual([
          3, 4,
        ]);
        expect((await adapter.getJournal(record.id, { limit: 2 })).map((e) => e.seq)).toEqual([
          1, 2,
        ]);
        expect(
          (await adapter.getJournal(record.id, { afterSeq: 1, limit: 2 })).map((e) => e.seq),
        ).toEqual([2, 3]);
        expect(await adapter.getJournal(record.id, { afterSeq: 99 })).toEqual([]);
      });

      test('a failed mutation leaves no entry behind', async () => {
        const missing = uniqueId('missing');
        await expectStackErrorCode(
          adapter.patchContent(
            missing,
            { title: 'x' },
            { journal: { ops: ['patch'], kind: 'changed' } },
          ),
          'not_found',
        );
        // The record was never created, so its log is refused rather than
        // read — what matters is that the entry did not land somewhere.
        await expectStackErrorCode(adapter.getJournal(missing), 'not_found');
      });

      test('a soft delete keeps the journal; a purge destroys it', async () => {
        const record = makeRecord();
        await adapter.createRecord(record, { journal: { ops: ['create'], kind: 'created' } });
        await adapter.deleteRecord(record.id, {
          journal: { ops: ['delete'], kind: 'removed' },
        });
        // A tombstone is recoverable, and its journal is part of what
        // recovers it.
        expect(await adapter.getJournal(record.id)).toHaveLength(2);

        await adapter.deleteRecord(record.id, { purge: true });
        // Gone with the record, so the log is refused: an empty one would
        // mean "nothing changed", which is the one reading it must keep.
        await expectStackErrorCode(adapter.getJournal(record.id), 'not_found');

        // And the log restarts: a purge that left rows behind would hand
        // the next record at this id a history that is not its own.
        await adapter.createRecord(makeRecord({ id: record.id }), {
          journal: { ops: ['create'], kind: 'created' },
        });
        expect((await adapter.getJournal(record.id)).map((e) => e.seq)).toEqual([1]);
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
          const page = await adapter.queryRecords(
            resolveQuery({ limit: 2, cursor: cursor ?? undefined }),
          );
          expect(page.records.length).toBeLessThanOrEqual(2);
          for (const r of page.records) seen.add(r.id);
          cursor = page.cursor;
        } while (cursor);

        for (const id of ids) expect(seen.has(id)).toBe(true);
      });

      // A cursor names the last record its page held, so the next page
      // starts after that record wherever it now falls in the order.
      test('a page resumes after its cursor whatever was inserted ahead of it', async () => {
        for (let i = 0; i < 5; i++) {
          await adapter.createRecord(makeRecord({ createdAt: new Date(1_000 + i) }));
        }
        const sort = { field: 'createdAt', direction: 'asc' } as const;
        const first = await adapter.queryRecords(resolveQuery({ limit: 2, sort }));
        await adapter.createRecord(makeRecord({ createdAt: new Date(1) }));
        const second = await adapter.queryRecords(
          resolveQuery({ limit: 2, cursor: first.cursor!, sort }),
        );

        const all = (await adapter.queryRecords(resolveQuery({ limit: 100, sort }))).records.map(
          (r) => r.id,
        );
        const after = all.indexOf(first.records[1]!.id);
        expect(second.records.map((r) => r.id)).toEqual(all.slice(after + 1, after + 3));
      });

      test('a malformed cursor is refused rather than misread', async () => {
        await expectStackErrorCode(
          adapter.queryRecords(resolveQuery({ cursor: 'not-a-real-cursor' })),
          'bad_request',
        );
      });

      test('a cursor minted under one sort field is refused when replayed under a different one', async () => {
        await adapter.createRecord(makeRecord());
        await adapter.createRecord(makeRecord());
        const minted = await adapter.queryRecords(
          resolveQuery({
            limit: 1,
            sort: { field: 'createdAt', direction: 'asc' },
          }),
        );
        expect(minted.cursor).not.toBeNull();
        await expectStackErrorCode(
          adapter.queryRecords(
            resolveQuery({
              limit: 1,
              cursor: minted.cursor!,
              sort: { field: 'updatedAt', direction: 'asc' },
            }),
          ),
          'bad_request',
        );
      });
    });

    // -----------------------------------------------------------------
    // Querying within a reach — optional, so each test asks whether the
    // adapter has queryReadable() at all. The reference reading is core's
    // inReach(); see docs/spec/access-control.md § Reach.
    // -----------------------------------------------------------------
    describe('querying within a reach', () => {
      const NOTE = 'org.haverstack.conformance/note';
      const OTHER = 'org.haverstack.conformance/other';
      const OTHER_TYPE_ID = `${OTHER}@1`;
      const ALICE = 'did:key:conformance-alice';
      const BOB = 'did:key:conformance-bob';
      const anyone: AuthorityAssociation = { kind: 'anyone', label: 'read' };
      const toAlice: PermissionElement = {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'entity', entityId: ALICE },
      };
      const toMembers: PermissionElement = {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'conformance-group', role: 'member' },
      };
      const toAdmins: PermissionElement = {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'conformance-group', role: 'admin' },
      };

      /** One record per route into a reach, and one beside each that misses it. */
      const populate = async (): Promise<StackRecord[]> => {
        const records = [
          makeRecord(),
          makeRecord({ typeId: OTHER_TYPE_ID }),
          makeRecord({ createdBy: { subjectId: ALICE } }),
          makeRecord({ typeId: OTHER_TYPE_ID, createdBy: { subjectId: ALICE } }),
          makeRecord({ createdBy: { subjectId: BOB, principalId: ALICE } }),
          makeRecord({ permissions: [anyone] }),
          makeRecord({ typeId: OTHER_TYPE_ID, permissions: [anyone] }),
          // A family's other versions are in reach with it; one sharing its
          // prefix is not.
          makeRecord({ typeId: `${NOTE}@2` }),
          makeRecord({ typeId: `${NOTE}@2`, createdBy: { subjectId: ALICE } }),
          makeRecord({ typeId: `${NOTE}s@1`, createdBy: { subjectId: ALICE } }),
          makeRecord({ permissions: [toAlice] }),
          makeRecord({ permissions: [{ ...toAlice, label: 'write' }] }),
          makeRecord({ permissions: [toMembers] }),
          makeRecord({ permissions: [toAdmins] }),
          makeRecord({ permissions: [toAlice, toMembers] }),
          makeRecord({ permissions: [toAlice, { ...toAlice, label: 'write' }] }),
          makeRecord({ permissions: [anyone, { ...toAlice, label: 'write' }] }),
          makeRecord({ permissions: [toMembers, toAdmins] }),
        ];
        for (const record of records) await adapter.createRecord(record);
        return records;
      };

      // Far past any statement's parameter cap — 100 on Durable Object SQLite.
      const manyFamilies = Array.from(
        { length: 150 },
        (_, i) => `org.haverstack.conformance/t${i}`,
      );
      const manyGroups = Array.from({ length: 60 }, (_, i) => `conformance-group-${i}`);
      const reaches: [string, Reach][] = [
        ['nothing constrained', {}],
        ['every Record of a family', { within: { baseIds: [OTHER], permissions: [] } }],
        [
          'the Records one subject authored in a family',
          {
            within: {
              baseIds: [],
              authored: { subjectId: ALICE, baseIds: [NOTE] },
              permissions: [],
            },
          },
        ],
        ['Records carrying `anyone`', { within: { baseIds: [], permissions: [[anyone]] } }],
        [
          'Records carrying a read naming an entity',
          { within: { baseIds: [], permissions: [[toAlice]] } },
        ],
        [
          'Records carrying a read naming a group at one role',
          { within: { baseIds: [], permissions: [[toAdmins]] } },
        ],
        [
          'every arm at once',
          {
            within: {
              baseIds: [OTHER],
              authored: { subjectId: ALICE, baseIds: [NOTE] },
              permissions: [[anyone], [toMembers]],
            },
          },
        ],
        ['a fence alone', { fence: [OTHER] }],
        [
          'arms inside a fence',
          {
            fence: [NOTE],
            within: {
              baseIds: [OTHER],
              authored: { subjectId: ALICE, baseIds: [NOTE, OTHER] },
              permissions: [[anyone]],
            },
          },
        ],
        ['an empty fence', { fence: [], within: { baseIds: [NOTE], permissions: [[anyone]] } }],
        ['no arm at all', { within: { baseIds: [], permissions: [] } }],
        [
          'Records carrying every element of a set',
          { within: { baseIds: [], permissions: [[toAlice, { ...toAlice, label: 'write' }]] } },
        ],
        [
          'Records carrying one whole set of several',
          {
            within: {
              baseIds: [],
              permissions: [
                [{ ...toAlice, label: 'write' }, anyone],
                [toMembers, toAdmins],
              ],
            },
          },
        ],
        ['an empty set, which no Record carries', { within: { baseIds: [], permissions: [[]] } }],
        [
          'a reach of any size',
          {
            fence: [NOTE, ...manyFamilies],
            within: {
              baseIds: manyFamilies,
              authored: { subjectId: ALICE, baseIds: [NOTE, ...manyFamilies] },
              permissions: [
                ...manyGroups.flatMap((groupId) => [
                  [{ ...toMembers, grantee: { ...toMembers.grantee, groupId } }],
                  [
                    {
                      ...toAdmins,
                      label: 'write' as const,
                      grantee: { ...toAdmins.grantee, groupId },
                    },
                    anyone,
                  ],
                ]),
                [toAlice],
              ],
            },
          },
        ],
      ];

      test.each(reaches)('returns exactly the Records in reach: %s', async (_name, reach) => {
        if (!adapter.queryReadable) return;
        const records = await populate();
        const result = await adapter.queryReadable(resolveQuery({ limit: 100 }), reach);
        const expected = records.filter((r) => inReach(r, reach)).map((r) => r.id);
        expect(result.records.map((r) => r.id).sort()).toEqual(expected.sort());
        expect(result.cursor).toBeNull();
      });

      test("a reach narrows the query's own filter rather than widening it", async () => {
        if (!adapter.queryReadable) return;
        const pinned: DataAssociation = { kind: 'tag', label: 'pinned' };
        const tagged = makeRecord({ permissions: [anyone], associations: [pinned] });
        await adapter.createRecord(tagged);
        await adapter.createRecord(makeRecord({ permissions: [anyone] }));
        await adapter.createRecord(makeRecord({ associations: [pinned] }));

        const result = await adapter.queryReadable(resolveQuery({ filter: { tags: ['pinned'] } }), {
          within: { baseIds: [], permissions: [[anyone]] },
        });
        expect(result.records.map((r) => r.id)).toEqual([tagged.id]);
      });

      // Paging is decided among the Records in reach alone: every page is
      // full, and no cursor comes back once they are exhausted, however
      // many Records outside the reach remain.
      const pagesWithin = async (sort: StackQuery['sort']): Promise<void> => {
        if (!adapter.queryReadable) return;
        const reach: Reach = { within: { baseIds: [], permissions: [[anyone]] } };
        const inside: string[] = [];
        for (let i = 0; i < 9; i++) {
          const visible = i % 3 === 1;
          const record = makeRecord({
            content: { title: `t${i}`, priority: i },
            ...(visible && { permissions: [anyone] }),
          });
          await adapter.createRecord(record);
          if (visible) inside.push(record.id);
        }

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await adapter.queryReadable(resolveQuery({ limit: 1, cursor, sort }), reach);
          expect(page.records).toHaveLength(1);
          seen.push(page.records[0]!.id);
          cursor = page.cursor ?? undefined;
        } while (cursor);
        expect(seen.sort()).toEqual(inside.sort());
      };

      test('pages through the Records in reach alone, by a native field', () =>
        pagesWithin({ field: 'createdAt', direction: 'asc' }));

      if (capabilities.sort.contentField) {
        test('pages through the Records in reach alone, by a content field', async () => {
          await adapter.saveType(conformanceType());
          await pagesWithin({ contentField: 'priority', direction: 'desc' });
        });
      }
    });

    // -----------------------------------------------------------------
    // Type families
    // -----------------------------------------------------------------
    describe('filter.baseId', () => {
      const NOTE = 'org.haverstack.conformance/note';
      const ids = async (filter: RecordFilter): Promise<string[]> =>
        (await adapter.queryRecords(resolveQuery({ filter }))).records.map((r) => r.id).sort();

      /** One record per TypeId, keyed by it. */
      const seed = async (typeIds: string[]): Promise<Record<string, string>> => {
        const seeded: Record<string, string> = {};
        for (const typeId of typeIds) {
          const record = makeRecord({ typeId });
          await adapter.createRecord(record);
          seeded[typeId] = record.id;
        }
        return seeded;
      };

      test('matches every version of the family and nothing that only shares its prefix', async () => {
        const r = await seed([`${NOTE}@1`, `${NOTE}@2`, `${NOTE}s@1`, `${NOTE}-x@1`, `${NOTE}@10`]);
        expect(await ids({ baseId: NOTE })).toEqual(
          [r[`${NOTE}@1`], r[`${NOTE}@2`], r[`${NOTE}@10`]].sort(),
        );
      });

      test('matches any of several families', async () => {
        const r = await seed([`${NOTE}@1`, `${NOTE}s@1`, 'org.haverstack.conformance/other@1']);
        expect(await ids({ baseId: [NOTE, `${NOTE}s`] })).toEqual(
          [r[`${NOTE}@1`], r[`${NOTE}s@1`]].sort(),
        );
      });

      test('intersects with filter.typeId', async () => {
        const r = await seed([`${NOTE}@1`, `${NOTE}@2`, `${NOTE}s@1`]);
        expect(await ids({ baseId: NOTE, typeId: [`${NOTE}@2`, `${NOTE}s@1`] })).toEqual([
          r[`${NOTE}@2`],
        ]);
      });

      test('an unknown family matches nothing', async () => {
        await seed([`${NOTE}@1`]);
        expect(await ids({ baseId: 'org.haverstack.conformance/none' })).toEqual([]);
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

          const result = await adapter.queryRecords(
            resolveQuery({ filter: { content: { priority: 1 } } }),
          );
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

          const result = await adapter.queryRecords(
            resolveQuery({ filter: { content: { priority: null } } }),
          );
          const ids = result.records.map((r) => r.id).sort();
          expect(ids).toEqual([absent.id, explicitNull.id].sort());
          expect(ids).not.toContain(present.id);
        });

        test('a scalar filter value never matches an object or array stored at the same path', async () => {
          const scalarMatch = makeRecord({ content: { title: 'x', priority: 1 } });
          const nested = makeRecord({ content: { title: 'y', priority: { high: true } } });
          await adapter.createRecord(scalarMatch);
          await adapter.createRecord(nested);

          const result = await adapter.queryRecords(
            resolveQuery({ filter: { content: { priority: 1 } } }),
          );
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

            const result = await adapter.queryRecords(
              resolveQuery({ filter: { contentPresent: ['priority'] } }),
            );
            expect(result.records.map((r) => r.id)).toEqual([present.id]);
          });
        }

        // A value matches as `===` compares it: its JSON type as well as
        // its value. See docs/spec/data-model.md § Filter.
        test('a content filter value matches its own JSON type only', async () => {
          const bool = makeRecord({ content: { title: 'b', flag: true } });
          const num = makeRecord({ content: { title: 'n', flag: 1 } });
          const text = makeRecord({ content: { title: 't', flag: '1' } });
          for (const record of [bool, num, text]) await adapter.createRecord(record);

          for (const [value, record] of [
            [true, bool],
            [1, num],
            ['1', text],
          ] as const) {
            const result = await adapter.queryRecords(
              resolveQuery({ filter: { content: { flag: value } } }),
            );
            expect(result.records.map((r) => r.id)).toEqual([record.id]);
          }
        });

        if (capabilities.filter.contentPresent && capabilities.filter.content === 'path') {
          // Both are element-wise, so a path reaching a null and a value
          // satisfies each. See docs/spec/data-model.md § Filter.
          test('a multi-valued path satisfies both contentPresent and a null filter', async () => {
            const mixed = makeRecord({
              content: { title: 'x', tags: [null, 'a'], emails: [{ value: null }, { value: 1 }] },
            });
            await adapter.createRecord(mixed);

            for (const path of ['tags', 'emails.value']) {
              const present = await adapter.queryRecords(
                resolveQuery({ filter: { contentPresent: [path] } }),
              );
              expect(present.records.map((r) => r.id)).toEqual([mixed.id]);
              const nulls = await adapter.queryRecords(
                resolveQuery({ filter: { content: { [path]: null } } }),
              );
              expect(nulls.records.map((r) => r.id)).toEqual([mixed.id]);
            }
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

            const result = await adapter.queryRecords(
              resolveQuery({
                filter: { content: { 'emails.value': 'a@b.c' } },
              }),
            );
            expect(result.records.map((r) => r.id)).toEqual([match.id]);
          });

          test('a nested path filter reaches a property inside a plain (non-array) object', async () => {
            const match = makeRecord({ content: { title: 'x', address: { city: 'Berlin' } } });
            const noMatch = makeRecord({ content: { title: 'y', address: { city: 'Lyon' } } });
            await adapter.createRecord(match);
            await adapter.createRecord(noMatch);

            const result = await adapter.queryRecords(
              resolveQuery({
                filter: { content: { 'address.city': 'Berlin' } },
              }),
            );
            expect(result.records.map((r) => r.id)).toEqual([match.id]);
          });

          test('a filter path descending through a scalar matches nothing, rather than throwing', async () => {
            await adapter.createRecord(makeRecord({ content: { title: 'x', priority: 1 } }));
            const result = await adapter.queryRecords(
              resolveQuery({
                filter: { content: { 'priority.nested': 'anything' } },
              }),
            );
            expect(result.records).toEqual([]);
          });
        }
      });
    }

    // -----------------------------------------------------------------
    // Content by type — capability-gated on filter.contentByType
    // -----------------------------------------------------------------
    if (capabilities.filter.contentByType) {
      describe('content by type', () => {
        const OTHER = 'org.haverstack.conformance/other@1';
        const THIRD = 'org.haverstack.conformance/third@1';

        test('matches each record against the arm for its own type only', async () => {
          const note = makeRecord({ content: { title: 'a' } });
          const other = makeRecord({ typeId: OTHER, content: { heading: 'a' } });
          const decoys = [
            makeRecord({ content: { title: 'b', heading: 'a' } }),
            makeRecord({ typeId: OTHER, content: { title: 'a', heading: 'b' } }),
            makeRecord({ typeId: THIRD, content: { title: 'a', heading: 'a' } }),
          ];
          for (const record of [note, other, ...decoys]) await adapter.createRecord(record);

          const result = await adapter.queryRecords(
            resolveQuery({
              filter: {
                contentByType: {
                  [CONFORMANCE_TYPE_ID]: { content: { title: 'a' } },
                  [OTHER]: { content: { heading: 'a' } },
                },
              },
            }),
          );
          expect(result.records.map((r) => r.id).sort()).toEqual([note.id, other.id].sort());
        });

        test('an arm naming nothing matches every record of its type', async () => {
          const notes = [makeRecord(), makeRecord({ content: { title: 'x' } })];
          const decoy = makeRecord({ typeId: THIRD });
          for (const record of [...notes, decoy]) await adapter.createRecord(record);

          const result = await adapter.queryRecords(
            resolveQuery({
              filter: {
                contentByType: { [CONFORMANCE_TYPE_ID]: {}, [OTHER]: { content: { a: 1 } } },
              },
            }),
          );
          expect(result.records.map((r) => r.id).sort()).toEqual(notes.map((r) => r.id).sort());
        });

        test('intersects with every other key of the filter', async () => {
          const kept = makeRecord({ content: { title: 'a' }, parentId: undefined });
          const parent = await adapter.createRecord(makeRecord());
          const child = makeRecord({ content: { title: 'a' }, parentId: parent.id });
          await adapter.createRecord(kept);
          await adapter.createRecord(child);

          const result = await adapter.queryRecords(
            resolveQuery({
              filter: {
                parentId: parent.id,
                contentByType: { [CONFORMANCE_TYPE_ID]: { content: { title: 'a' } }, [OTHER]: {} },
              },
            }),
          );
          expect(result.records.map((r) => r.id)).toEqual([child.id]);
        });

        if (capabilities.filter.contentPresent) {
          test("an arm's contentPresent is applied to its own type", async () => {
            const present = makeRecord({ content: { title: 'x', priority: 1 } });
            const absent = makeRecord({ content: { title: 'y' } });
            const other = makeRecord({ typeId: OTHER, content: { priority: 1 } });
            for (const record of [present, absent, other]) await adapter.createRecord(record);

            const result = await adapter.queryRecords(
              resolveQuery({
                filter: {
                  contentByType: {
                    [CONFORMANCE_TYPE_ID]: { contentPresent: ['priority'] },
                    [OTHER]: { contentPresent: ['missing'] },
                  },
                },
              }),
            );
            expect(result.records.map((r) => r.id)).toEqual([present.id]);
          });
        }
      });
    }

    // -----------------------------------------------------------------
    // Sort by content field per type — gated on sort.contentFieldByType
    // -----------------------------------------------------------------
    if (capabilities.sort.contentFieldByType) {
      describe('sort by content field per type', () => {
        const OTHER = 'org.haverstack.conformance/other@1';
        const THIRD = 'org.haverstack.conformance/third@1';
        const UNNAMED = 'org.haverstack.conformance/unnamed@1';
        const BY_TYPE = {
          [CONFORMANCE_TYPE_ID]: { field: 'priority' },
          [OTHER]: { field: 'rank' },
          [THIRD]: { value: 2.5 },
        };

        /** Each title names the position the record sorts to, ascending. */
        const seed = async () => {
          await adapter.saveType(conformanceType());
          await adapter.saveType(
            conformanceType({
              id: OTHER,
              baseId: 'org.haverstack.conformance/other',
              schema: { title: { kind: 'string' }, rank: { kind: 'number' } },
            }),
          );
          for (const record of [
            makeRecord({ content: { title: 'd', priority: 3 } }),
            makeRecord({ typeId: OTHER, content: { title: 'a', rank: 1, priority: 9 } }),
            makeRecord({ typeId: THIRD, content: { title: 'c', priority: 0 } }),
            makeRecord({ content: { title: 'b', priority: 2 } }),
            makeRecord({ typeId: OTHER, content: { title: 'e', rank: 4 } }),
            makeRecord({ content: { title: 'z' } }),
            makeRecord({ typeId: UNNAMED, content: { title: 'z', priority: 1 } }),
          ]) {
            await adapter.createRecord(record);
          }
        };
        const titles = (records: { content: Record<string, unknown> }[]) =>
          records.map((r) => r.content.title);

        test.each(['asc', 'desc'] as const)(
          'orders each type by its own field or constant, %s, holding no value last',
          async (direction) => {
            await seed();
            const result = await adapter.queryRecords(
              resolveQuery({
                sort: { contentFieldByType: BY_TYPE, direction },
              }),
            );
            const ordered = ['a', 'b', 'c', 'd', 'e'];
            expect(titles(result.records)).toEqual([
              ...(direction === 'asc' ? ordered : ordered.reverse()),
              'z',
              'z',
            ]);
          },
        );

        test('pages through the ordering one record at a time', async () => {
          await seed();
          const seen: unknown[] = [];
          let cursor: string | null | undefined;
          do {
            const page = await adapter.queryRecords(
              resolveQuery({
                limit: 1,
                cursor: cursor ?? undefined,
                sort: { contentFieldByType: BY_TYPE, direction: 'asc' },
              }),
            );
            seen.push(...titles(page.records));
            cursor = page.cursor;
          } while (cursor);
          expect(seen).toEqual(['a', 'b', 'c', 'd', 'e', 'z', 'z']);
        });

        if (capabilities.sort.contentField) {
          test('a cursor minted under one field is refused under a map', async () => {
            await seed();
            const minted = await adapter.queryRecords(
              resolveQuery({
                limit: 1,
                sort: { contentField: 'priority', direction: 'asc' },
              }),
            );
            await expectStackErrorCode(
              adapter.queryRecords(
                resolveQuery({
                  limit: 1,
                  cursor: minted.cursor!,
                  sort: { contentFieldByType: BY_TYPE, direction: 'asc' },
                }),
              ),
              'bad_request',
            );
          });
        }
      });
    }

    // -----------------------------------------------------------------
    // Sort by content field — capability-gated on sort.contentField
    // -----------------------------------------------------------------
    describe('sort direction', () => {
      test.each(['asc', 'desc'] as const)(
        'honors an explicit %s on a native field',
        async (direction) => {
          const a = await adapter.createRecord(makeRecord());
          await new Promise((r) => setTimeout(r, 5));
          const b = await adapter.createRecord(makeRecord());
          const result = await adapter.queryRecords(
            resolveQuery({ sort: { field: 'createdAt', direction } }),
          );
          const ids = result.records.map((r) => r.id);
          expect(ids).toEqual(direction === 'asc' ? [a.id, b.id] : [b.id, a.id]);
        },
      );
    });

    if (capabilities.sort.contentField) {
      describe('sort by content field', () => {
        test.each(['asc', 'desc'] as const)(
          'honors an explicit %s on a content field',
          async (direction) => {
            await adapter.saveType(conformanceType());
            await adapter.createRecord(makeRecord({ content: { title: 'x', priority: 1 } }));
            await adapter.createRecord(makeRecord({ content: { title: 'y', priority: 2 } }));

            const result = await adapter.queryRecords(
              resolveQuery({
                sort: { contentField: 'priority', direction },
              }),
            );
            const priorities = result.records.map(
              (r) => (r.content as { priority: number }).priority,
            );
            expect(priorities).toEqual(direction === 'asc' ? [1, 2] : [2, 1]);
          },
        );

        test('orders records by a declared content field', async () => {
          // Registered so an adapter that resolves the field's sort kind
          // through the type schema (rather than off the raw JSON value)
          // sorts numerically instead of falling back to no ordering.
          await adapter.saveType(conformanceType());
          await adapter.createRecord(makeRecord({ content: { title: 'x', priority: 3 } }));
          await adapter.createRecord(makeRecord({ content: { title: 'y', priority: 1 } }));
          await adapter.createRecord(makeRecord({ content: { title: 'z', priority: 2 } }));

          const result = await adapter.queryRecords(
            resolveQuery({
              sort: { contentField: 'priority', direction: 'asc' },
            }),
          );
          expect(result.records.map((r) => (r.content as { priority: number }).priority)).toEqual([
            1, 2, 3,
          ]);
        });

        test('orders an enum field by value, not by its position in values', async () => {
          await adapter.saveType(
            conformanceType({
              schema: {
                title: { kind: 'string' },
                status: { kind: 'enum', values: ['want', 'reading', 'finished'] },
              },
            }),
          );
          for (const status of ['want', 'finished', 'reading']) {
            await adapter.createRecord(makeRecord({ content: { title: status, status } }));
          }

          const result = await adapter.queryRecords(
            resolveQuery({
              sort: { contentField: 'status', direction: 'asc' },
            }),
          );
          expect(result.records.map((r) => (r.content as { status: string }).status)).toEqual([
            'finished',
            'reading',
            'want',
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

          const result = await adapter.queryRecords(resolveQuery({ filter: { search: 'brown' } }));
          expect(result.records.map((r) => r.id)).toContain(match.id);
          expect(result.records.map((r) => r.id)).not.toContain(noMatch.id);
        });

        // An external-content index's unindex step must run before the
        // row's content changes, or a stale entry stays searchable under
        // content the record no longer holds. See docs/spec/adapters.md
        // § The search index is unindexed before the row moves.
        test('a content patch is reflected in search — the old content is no longer searchable', async () => {
          const record = makeRecord({ content: { title: 'original wording' } });
          await adapter.createRecord(record);
          await adapter.patchContent(record.id, { title: 'updated wording' });

          const stale = await adapter.queryRecords(
            resolveQuery({ filter: { search: 'original' } }),
          );
          expect(stale.records.map((r) => r.id)).not.toContain(record.id);

          const fresh = await adapter.queryRecords(resolveQuery({ filter: { search: 'updated' } }));
          expect(fresh.records.map((r) => r.id)).toContain(record.id);
        });

        test('a purged record is no longer found by search', async () => {
          const record = makeRecord({ content: { title: 'ephemeral content' } });
          await adapter.createRecord(record);
          await adapter.deleteRecord(record.id, { purge: true });

          const result = await adapter.queryRecords(
            resolveQuery({ filter: { search: 'ephemeral' } }),
          );
          expect(result.records.map((r) => r.id)).not.toContain(record.id);
        });
      });
    }
  });
}
