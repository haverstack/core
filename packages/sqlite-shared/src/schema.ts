import type { SqlExecutor } from './executor.js';

/**
 * Schema DDL shared by SQLite-backed record adapters. TOKENS_SCHEMA_SQL
 * is split out from RECORD_SCHEMA_SQL because token storage lives in its
 * own file, never bundled with records — see NativeTokenStore in
 * record-adapter-sqlite and the StackTokenStore portability rationale
 * (docs/spec/wire-format.md § Authentication).
 */

export const RECORD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,
    type_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    content     TEXT NOT NULL CHECK (json_valid(content)),
    version     INTEGER NOT NULL DEFAULT 1,
    parent_id   TEXT,
    entity_id   TEXT,
    app_id      TEXT,
    principal_id TEXT,
    updated_by  TEXT,
    updated_via TEXT,
    deleted_at  INTEGER,
    unlisted_at INTEGER,
    permissions TEXT CHECK (permissions IS NULL OR json_valid(permissions))
  ) STRICT;

  -- A relationship's target is (related_scope, related_id) plus one
  -- qualifier: related_stack for a record in another stack, related_ns for
  -- a foreign namespace. All four are in the primary key, so two targets
  -- differing only by namespace are two associations.
  --
  -- attachment_record_id stays out of the primary key: it annotates a
  -- reference rather than naming one, so re-pointing it updates the row an
  -- associate() lands on instead of writing a second reference to the same
  -- file. See docs/spec/attachments.md § Naming the upload a reference came from.
  --
  -- The primary key leads with record_id, so its implicit index already
  -- serves every by-record read and delete; the indexes below exist only
  -- for the filter directions it cannot answer.
  CREATE TABLE IF NOT EXISTS associations (
    record_id     TEXT NOT NULL REFERENCES records(id),
    kind          TEXT NOT NULL CHECK (kind IN ('tag', 'attachment', 'relationship')),
    label         TEXT NOT NULL,
    file_id       TEXT NOT NULL DEFAULT '',
    related_scope TEXT NOT NULL DEFAULT '' CHECK (related_scope IN ('', 'record', 'entity', 'external')),
    related_id    TEXT NOT NULL DEFAULT '',
    related_ns    TEXT NOT NULL DEFAULT '',
    related_stack TEXT NOT NULL DEFAULT '',
    attachment_record_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (record_id, kind, label, file_id, related_scope, related_id, related_ns, related_stack)
  ) STRICT;

  -- parent_id holds the container the record sat in, NULL for the root --
  -- the same encoding records.parent_id uses, since a snapshot states
  -- where the record was rather than an instruction to apply.
  -- No associations column: associate()/dissociate() don't bump version,
  -- so no version ever snapshots the association set. See
  -- docs/spec/versioning.md § Version history.
  CREATE TABLE IF NOT EXISTS versions (
    record_id   TEXT NOT NULL REFERENCES records(id),
    version     INTEGER NOT NULL,
    type_id     TEXT NOT NULL,
    content     TEXT NOT NULL CHECK (json_valid(content)),
    updated_at  INTEGER NOT NULL,
    entity_id   TEXT,
    updated_by  TEXT,
    updated_via TEXT,
    parent_id   TEXT,
    permissions  TEXT CHECK (permissions IS NULL OR json_valid(permissions)),
    PRIMARY KEY (record_id, version)
  ) STRICT;

  -- The durable half of a change event: which aspects moved, who moved
  -- them, and the association deltas nothing else retains. Envelope-level
  -- by design — content lives on a versions row, and copying it here
  -- would make the journal the larger of the two stores.
  -- See docs/spec/journal.md.
  CREATE TABLE IF NOT EXISTS journal (
    record_id   TEXT NOT NULL REFERENCES records(id),
    seq         INTEGER NOT NULL,
    at          INTEGER NOT NULL,
    -- No 'purged': a purge destroys the log rather than appending to it,
    -- so the constraint names exactly the kinds an entry can carry.
    -- See docs/spec/journal.md § A hard delete destroys the journal.
    kind        TEXT NOT NULL CHECK (kind IN ('created', 'changed', 'deleted')),
    ops         TEXT NOT NULL CHECK (json_valid(ops)),
    version     INTEGER NOT NULL,
    type_id     TEXT NOT NULL,
    parent_id   TEXT,
    -- NULL means the entry names no origin (the record did not move);
    -- '' means it moved off the root. parent_id above needs no such
    -- spelling: it is state, where this is a key that may be absent --
    -- the same input/state split parentId follows everywhere.
    previous_parent_id TEXT,
    actor       TEXT CHECK (actor IS NULL OR json_valid(actor)),
    -- One tagged edit per association the write moved, each carrying the
    -- state it displaced. See docs/spec/journal.md § The entry.
    associations TEXT CHECK (associations IS NULL OR json_valid(associations)),
    PRIMARY KEY (record_id, seq)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS types (
    id            TEXT PRIMARY KEY,
    base_id       TEXT NOT NULL,
    version       INTEGER NOT NULL,
    name          TEXT NOT NULL,
    schema        TEXT NOT NULL CHECK (json_valid(schema)),
    schema_hash   TEXT NOT NULL,
    migrates_from TEXT,
    created_at    INTEGER NOT NULL
  ) STRICT;

  -- One row per top-level scalar content field a record holds a value at:
  -- what it orders as, and the file it references. See
  -- docs/spec/adapters.md § Adapter backends and
  -- docs/spec/data-model.md § Sorting by a content field.
  --
  -- value_rank is 0 for a numeric value and 1 for a text one — the same
  -- split as "num_value IS NULL", but non-null, so one index can carry
  -- the whole ordering. file_id is set only for a 'file-ref' field.
  CREATE TABLE IF NOT EXISTS content_index (
    record_id  TEXT NOT NULL REFERENCES records(id),
    field      TEXT NOT NULL,
    value_rank INTEGER NOT NULL CHECK (value_rank IN (0, 1)),
    num_value  REAL,
    text_key   TEXT,
    text_value TEXT,
    file_id    TEXT,
    PRIMARY KEY (record_id, field)
  ) STRICT;

  -- Indexes. Each filter column continues into (created_at, id) — the
  -- default ordering and its tiebreak — because these columns are
  -- low-cardinality by design, and a narrow index on one leaves the
  -- planner sorting the whole matching set before it can honor LIMIT.
  --
  -- deleted_at and unlisted_at deliberately have none: nothing searches
  -- for the rows they mark, and an index on a column every query tests
  -- for IS NULL only lures the planner off the one answering ORDER BY.
  CREATE INDEX IF NOT EXISTS idx_records_type_id      ON records(type_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_parent_id    ON records(parent_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_entity_id    ON records(entity_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_app_id       ON records(app_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_principal_id ON records(principal_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_created_at   ON records(created_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_updated_at   ON records(updated_at, id);
  CREATE INDEX IF NOT EXISTS idx_records_version      ON records(version, id);

  -- Each association index ends with record_id so the semi-joins in
  -- query.ts read the matching record ids out of the index alone.
  -- idx_assoc_related carries related_ns ahead of related_id because a
  -- record- or entity-scoped target always stores '' there, which
  -- buildQueryPlan states explicitly to keep the prefix contiguous.
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_label   ON associations(kind, label, record_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_file_id ON associations(kind, file_id, record_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_related      ON associations(kind, related_scope, related_ns, related_id, record_id);
  CREATE INDEX IF NOT EXISTS idx_types_base_id      ON types(base_id, version);

  -- The whole content ordering, in index order, for one field at a time:
  -- a content-sorted page is an ordered walk of a slice of this index.
  CREATE INDEX IF NOT EXISTS idx_content_index_sort
    ON content_index(field, value_rank, num_value, text_key, text_value, record_id);
  CREATE INDEX IF NOT EXISTS idx_content_index_file
    ON content_index(file_id, record_id) WHERE file_id IS NOT NULL;
`;

/**
 * Bearer-token storage backing StackTokenStore. Kept separate from
 * RECORD_SCHEMA_SQL so an adapter can put it in its own file — the
 * portable stack file shouldn't also carry a server's auth material.
 */
export const TOKENS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    principal_id TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER
  ) STRICT;
`;

/**
 * The full-text index behind `StackQuery.filter.search` (see fts5.ts).
 * What `columnsize=0` costs a reader is in docs/spec/adapters.md
 * § Adapter backends. `detail` stays at its default: sanitizeFts5Query
 * passes phrase queries through, and a phrase needs the token positions
 * only that setting records.
 */
export const FTS5_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    content,
    content='records',
    content_rowid='rowid',
    columnsize=0
  );
`;

/**
 * Enforces the REFERENCES constraints declared above (off by default per
 * SQLite connection), so touching a nonexistent record fails loudly
 * instead of creating an orphan row. Adapters map the constraint
 * violation to StackNotFoundError at the call sites that can trigger it.
 */
export const PRAGMA_FOREIGN_KEYS_ON = `PRAGMA foreign_keys = ON;`;

/**
 * WAL journaling: page-level writes, crash-safe without our own
 * temp-file-and-rename dance, and real SQLite file locking. Only
 * meaningful for a real file (a :memory: database silently ignores it).
 */
export const PRAGMA_JOURNAL_MODE_WAL = `PRAGMA journal_mode = WAL;`;

export type RecordSchemaOptions = {
  /**
   * Whether to put the connection in WAL mode. False for an engine that
   * owns its own durability and rejects the pragma outright, as Durable
   * Object storage does.
   */
  wal: boolean;
};

/**
 * Brings a records database up to the schema every SQLite record adapter
 * expects: foreign keys on, then the tables and the FTS5 index. Every
 * statement is idempotent, so an engine that has no
 * initialize()/open() split can run this on each attach.
 */
export const applyRecordSchema = (exec: SqlExecutor, opts: RecordSchemaOptions): void => {
  exec.exec(PRAGMA_FOREIGN_KEYS_ON);
  if (opts.wal) exec.exec(PRAGMA_JOURNAL_MODE_WAL);
  exec.exec(RECORD_SCHEMA_SQL);
  exec.exec(FTS5_SCHEMA_SQL);
};
