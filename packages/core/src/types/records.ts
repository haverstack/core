/**
 * The Record itself and its version snapshots.
 */

import type { AuthorityAssociation, DataAssociation } from './associations.js';
import type { RecordId, TypeId, AppId, Actor } from './ids.js';

export type StackRecord = {
  // Core — always present, managed by the library
  id: RecordId;
  typeId: TypeId;
  createdAt: Date;
  updatedAt: Date;
  content: Record<string, unknown>;
  /**
   * Ordinal of the snapshot history, not a count of changes: associations,
   * permissions, parent and listing moves leave it alone. See
   * docs/spec/versioning.md § Version history.
   */
  version: number;

  // Optional native fields
  parentId?: RecordId; // Parent record (hierarchy/folders)
  appId?: AppId; // App that created this record — self-reported, see AppId
  /**
   * The record's author, stamped once by the create. A `principalId` here
   * is what lets `appId` be checked against the `_app` record naming that
   * DID; without one, `appId` is an unverifiable self-report.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  createdBy?: Actor;
  /**
   * Who performed the mutation this version records — unlike `createdBy`,
   * it moves with every write. Absent means an unscoped `Stack` wrote it,
   * which names no requester.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  updatedBy?: Actor;
  deletedAt?: Date; // Present if soft-deleted
  /**
   * Present when the record is withheld from enumeration: absent from
   * `query()` and the change feed by default, but reachable by `get()` for
   * anyone who may read it. Says nothing about who that is.
   * See docs/spec/unlisted.md.
   */
  unlistedAt?: Date;
  /**
   * Who reaches this Record, projected from the association table's
   * authority kinds. Absent or empty means private — readable only by the
   * stack owner. Declarative intent; enforcement is `ScopedStack`'s.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
};

export type RecordVersion = {
  version: number;
  /** The record's typeId at the moment this version was snapshotted. */
  typeId: TypeId;
  content: Record<string, unknown>;
  updatedAt: Date;
  /**
   * The record's author, carried through from `record.createdBy` — not the
   * actor of the change this version records.
   * See docs/spec/versioning.md § Version history.
   */
  createdBy?: Actor;
  /** Who performed the mutation that produced this version. */
  updatedBy?: Actor;
};

/**
 * Window into a record's version history. Newest first, the reverse of
 * JournalQuery; omitting both reads every version.
 * See docs/spec/versioning.md § Version history.
 */
export type VersionsQuery = {
  /** Versions strictly older than this, exclusive. */
  beforeVersion?: number;
  limit?: number;
};
