/**
 * Schema DDL shared by SQLite-backed record adapters. TOKENS_SCHEMA_SQL
 * is split out from RECORD_SCHEMA_SQL because token storage lives in its
 * own file, never a browser adapter's, and never bundled with records —
 * see NativeTokenStore in record-adapter-sqlite, docs/spec.md § Adapters,
 * and the StackTokenStore portability rationale in #46.
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
    deleted_at  INTEGER,
    permissions TEXT CHECK (permissions IS NULL OR json_valid(permissions))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS associations (
    record_id  TEXT NOT NULL REFERENCES records(id),
    kind       TEXT NOT NULL CHECK (kind IN ('tag', 'attachment', 'relationship')),
    label      TEXT NOT NULL,
    file_id    TEXT NOT NULL DEFAULT '',
    mime_type  TEXT,
    related_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (record_id, kind, label, file_id, related_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS versions (
    record_id   TEXT NOT NULL REFERENCES records(id),
    version     INTEGER NOT NULL,
    content     TEXT NOT NULL CHECK (json_valid(content)),
    updated_at  INTEGER NOT NULL,
    entity_id   TEXT,
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

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_records_type_id    ON records(type_id);
  CREATE INDEX IF NOT EXISTS idx_records_parent_id  ON records(parent_id);
  CREATE INDEX IF NOT EXISTS idx_records_entity_id  ON records(entity_id);
  CREATE INDEX IF NOT EXISTS idx_records_app_id     ON records(app_id);
  CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
  CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at);
  CREATE INDEX IF NOT EXISTS idx_assoc_record_id    ON associations(record_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_label   ON associations(kind, label);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_file_id ON associations(kind, file_id);
  CREATE INDEX IF NOT EXISTS idx_types_base_id      ON types(base_id);
`;

/**
 * Bearer-token storage backing StackTokenStore. Kept separate from
 * RECORD_SCHEMA_SQL so an adapter can put it in its own file — the
 * portable stack file shouldn't also carry a server's auth material.
 */
export const TOKENS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tokens (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    entity_id   TEXT NOT NULL,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
`;

/** FTS4 — compatible with sql.js's WASM SQLite build. */
export const FTS4_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts4(
    content,
    content='records'
  );
`;

/** FTS5 — used by the native (node:sqlite) adapter. */
export const FTS5_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    content,
    content='records',
    content_rowid='rowid'
  );
`;

/**
 * Enforces the REFERENCES constraints declared above (off by default per
 * SQLite connection). Without it, associating/versioning a nonexistent
 * record silently creates an orphan row instead of failing loudly.
 * Adapters that enable this must map the resulting constraint-violation
 * error to StackNotFoundError at the call sites that can trigger it
 * (chiefly `associate()` on a record that doesn't exist).
 */
export const PRAGMA_FOREIGN_KEYS_ON = `PRAGMA foreign_keys = ON;`;

/**
 * WAL journaling: page-level writes, crash-safe without our own
 * temp-file-and-rename dance, and real SQLite file locking. Only
 * meaningful for a real file (a :memory: or sql.js in-memory database
 * silently ignores it).
 */
export const PRAGMA_JOURNAL_MODE_WAL = `PRAGMA journal_mode = WAL;`;
