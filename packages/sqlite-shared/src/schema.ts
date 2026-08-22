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
    permissions TEXT CHECK (permissions IS NULL OR json_valid(permissions))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS associations (
    record_id  TEXT NOT NULL REFERENCES records(id),
    kind       TEXT NOT NULL CHECK (kind IN ('tag', 'attachment', 'relationship')),
    label      TEXT NOT NULL,
    file_id    TEXT NOT NULL DEFAULT '',
    related_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (record_id, kind, label, file_id, related_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS versions (
    record_id   TEXT NOT NULL REFERENCES records(id),
    version     INTEGER NOT NULL,
    type_id     TEXT NOT NULL,
    content     TEXT NOT NULL CHECK (json_valid(content)),
    updated_at  INTEGER NOT NULL,
    entity_id   TEXT,
    updated_by  TEXT,
    updated_via TEXT,
    associations TEXT CHECK (associations IS NULL OR json_valid(associations)),
    permissions  TEXT CHECK (permissions IS NULL OR json_valid(permissions)),
    PRIMARY KEY (record_id, version)
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

  -- One row per top-level file-ref content field on a record, kept in sync
  -- on every content/typeId write. Lets the attachmentFileId query filter
  -- and deleteAttachment()'s reference check see content-held file
  -- references, not just attachment associations.
  CREATE TABLE IF NOT EXISTS file_refs (
    record_id TEXT NOT NULL REFERENCES records(id),
    field     TEXT NOT NULL,
    file_id   TEXT NOT NULL,
    PRIMARY KEY (record_id, field)
  ) STRICT;

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_records_type_id    ON records(type_id);
  CREATE INDEX IF NOT EXISTS idx_records_parent_id  ON records(parent_id);
  CREATE INDEX IF NOT EXISTS idx_records_entity_id  ON records(entity_id);
  CREATE INDEX IF NOT EXISTS idx_records_app_id     ON records(app_id);
  CREATE INDEX IF NOT EXISTS idx_records_principal_id ON records(principal_id);
  CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
  CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at);
  CREATE INDEX IF NOT EXISTS idx_assoc_record_id    ON associations(record_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_label   ON associations(kind, label);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_file_id ON associations(kind, file_id);
  CREATE INDEX IF NOT EXISTS idx_types_base_id      ON types(base_id);
  CREATE INDEX IF NOT EXISTS idx_file_refs_file_id  ON file_refs(file_id);
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

  CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
`;

/** The full-text index behind `StackQuery.filter.search` (see fts5.ts). */
export const FTS5_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    content,
    content='records',
    content_rowid='rowid'
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
