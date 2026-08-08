import type {
  StackRecord,
  StackType,
  RecordVersion,
  Association,
  Permission,
  ValidationError,
  SchemaDriftViolation,
} from '@haverstack/core';
import {
  StackValidationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackMigrationError,
  StackQueryError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
} from '@haverstack/core';

export type WireRecord = {
  id: string;
  typeId: string;
  createdAt: string;
  updatedAt: string;
  content: Record<string, unknown>;
  version: number;
  parentId?: string;
  entityId?: string;
  appId?: string;
  deletedAt?: string;
  permissions?: Permission[];
  associations?: Association[];
};

export type WireType = {
  id: string;
  baseId: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  migratesFrom?: string;
  createdAt: string;
};

export type WireVersion = {
  version: number;
  typeId: string;
  content: Record<string, unknown>;
  updatedAt: string;
  entityId?: string;
  associations?: Association[];
  permissions?: Permission[];
};

export function serializeRecord(r: StackRecord): WireRecord {
  const w: WireRecord = {
    id: r.id,
    typeId: r.typeId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    content: r.content,
    version: r.version,
  };
  if (r.parentId !== undefined) w.parentId = r.parentId;
  if (r.entityId !== undefined) w.entityId = r.entityId;
  if (r.appId !== undefined) w.appId = r.appId;
  if (r.deletedAt !== undefined) w.deletedAt = r.deletedAt.toISOString();
  if (r.permissions !== undefined) w.permissions = r.permissions;
  if (r.associations !== undefined) w.associations = r.associations;
  return w;
}

export function serializeType(t: StackType): WireType {
  const w: WireType = {
    id: t.id,
    baseId: t.baseId,
    version: t.version,
    name: t.name,
    schema: t.schema as Record<string, unknown>,
    schemaHash: t.schemaHash,
    createdAt: t.createdAt.toISOString(),
  };
  if (t.migratesFrom !== undefined) w.migratesFrom = t.migratesFrom;
  return w;
}

export function serializeVersion(v: RecordVersion): WireVersion {
  const w: WireVersion = {
    version: v.version,
    typeId: v.typeId,
    content: v.content,
    updatedAt: v.updatedAt.toISOString(),
  };
  if (v.entityId !== undefined) w.entityId = v.entityId;
  if (v.associations !== undefined) w.associations = v.associations;
  if (v.permissions !== undefined) w.permissions = v.permissions;
  return w;
}

/** Parse an ISO date string from a wire body, returns undefined if absent or invalid. */
export function parseDate(val: unknown): Date | undefined {
  if (typeof val !== 'string') return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

// -------------------------------------------------------
// Error responses
// -------------------------------------------------------
//
// The round-trip contract for core's typed error taxonomy: a server
// serializes a caught core error via serializeError(), and APIAdapter
// reconstructs the same class via deserializeError(). `code` is the
// authoritative discriminator; status is a transport hint. See
// docs/spec/wire-format.md § Error responses.

export type WireErrorCode =
  | 'bad_request'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'validation'
  | 'migration'
  | 'schema_drift'
  | 'payload_too_large';

export type WireError = {
  error: {
    code: WireErrorCode;
    message: string;
    /** Field-level validation failures. Only present for code: 'validation'. */
    details?: ValidationError[];
    /** ifVersion/If-Match precondition state. Only present for code: 'version_conflict'. */
    versionConflict?: {
      recordId: string;
      expectedVersion: number;
      actualVersion: number;
    };
    /** The rejected defineType() call's target and violations. Only present for code: 'schema_drift'. */
    schemaDrift?: {
      typeId: string;
      violations: SchemaDriftViolation[];
    };
  };
};

/** Canonical HTTP status for each wire error code. */
export const WIRE_ERROR_STATUS: Record<WireErrorCode, number> = {
  bad_request: 400,
  permission: 403,
  not_found: 404,
  conflict: 409,
  // 412 (not 409): RFC 7232's status for a failed If-Match precondition,
  // and distinct from 'conflict' — StackVersionConflictError is not a
  // StackConflictError subtype (see its doc comment), so each code keeps
  // its own unambiguous status, including for the status-only fallback
  // below.
  version_conflict: 412,
  validation: 422,
  /**
   * No core code path currently produces a StackMigrationError over the
   * wire (migration-graph errors are thrown during client-side migration
   * registration, never as a server response) — this entry exists so a
   * future server-side migration-graph check has a defined status to use.
   */
  migration: 500,
  // Shares 409 with 'conflict', so a schema-drift response without a
  // parseable body degrades to a generic StackConflictError in
  // status-only reconstruction. See docs/spec/wire-format.md § Wire error
  // body.
  schema_drift: 409,
  // 413 is unambiguous — no other wire code shares it — so status-only
  // reconstruction (STATUS_TO_CODE below) recovers this class even from a
  // bodyless response (e.g. a reverse proxy's own request-entity-too-large
  // page, not the server's JSON error body).
  payload_too_large: 413,
};

/**
 * Statuses that unambiguously imply a wire error code, for reconstructing
 * an error from status alone when a response has no parseable wire error
 * body. 500 is deliberately excluded — it would misclassify ordinary
 * server bugs as StackMigrationError. See docs/spec/wire-format.md
 * § Wire error body.
 */
export const STATUS_TO_CODE: Partial<Record<number, WireErrorCode>> = {
  400: 'bad_request',
  403: 'permission',
  404: 'not_found',
  409: 'conflict',
  412: 'version_conflict',
  422: 'validation',
  413: 'payload_too_large',
};

const KNOWN_CODES = new Set<string>(Object.keys(WIRE_ERROR_STATUS));

/** Type guard: does this parsed JSON body look like a WireError? */
export function isWireError(body: unknown): body is WireError {
  if (!body || typeof body !== 'object') return false;
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return typeof code === 'string' && KNOWN_CODES.has(code) && typeof message === 'string';
}

/**
 * Convert a thrown core error into its wire response. Used by server
 * implementations. Returns null for errors outside the core taxonomy —
 * callers fall back to their own generic error handling.
 */
export function serializeError(err: unknown): { status: number; body: WireError } | null {
  if (err instanceof StackValidationError) {
    return {
      status: WIRE_ERROR_STATUS.validation,
      body: { error: { code: 'validation', message: err.message, details: err.errors } },
    };
  }
  if (err instanceof StackPermissionError) {
    return {
      status: WIRE_ERROR_STATUS.permission,
      body: { error: { code: 'permission', message: err.message } },
    };
  }
  if (err instanceof StackNotFoundError) {
    return {
      status: WIRE_ERROR_STATUS.not_found,
      body: { error: { code: 'not_found', message: err.message } },
    };
  }
  if (err instanceof StackVersionConflictError) {
    return {
      status: WIRE_ERROR_STATUS.version_conflict,
      body: {
        error: {
          code: 'version_conflict',
          message: err.message,
          versionConflict: {
            recordId: err.recordId,
            expectedVersion: err.expectedVersion,
            actualVersion: err.actualVersion,
          },
        },
      },
    };
  }
  if (err instanceof StackConflictError) {
    return {
      status: WIRE_ERROR_STATUS.conflict,
      body: { error: { code: 'conflict', message: err.message } },
    };
  }
  if (err instanceof StackQueryError) {
    return {
      status: WIRE_ERROR_STATUS.bad_request,
      body: { error: { code: 'bad_request', message: err.message } },
    };
  }
  if (err instanceof StackMigrationError) {
    return {
      status: WIRE_ERROR_STATUS.migration,
      body: { error: { code: 'migration', message: err.message } },
    };
  }
  if (err instanceof StackSchemaDriftError) {
    return {
      status: WIRE_ERROR_STATUS.schema_drift,
      body: {
        error: {
          code: 'schema_drift',
          message: err.message,
          schemaDrift: { typeId: err.typeId, violations: err.violations },
        },
      },
    };
  }
  if (err instanceof StackPayloadTooLargeError) {
    return {
      status: WIRE_ERROR_STATUS.payload_too_large,
      body: { error: { code: 'payload_too_large', message: err.message } },
    };
  }
  return null;
}

/** Reconstruct the core error a WireError body describes. */
export function deserializeError(body: WireError): Error {
  const { code, message, details, versionConflict, schemaDrift } = body.error;
  switch (code) {
    case 'validation':
      return new StackValidationError(details ?? []);
    case 'permission':
      return new StackPermissionError(message);
    case 'not_found':
      return new StackNotFoundError(message);
    case 'conflict':
      return new StackConflictError(message);
    case 'version_conflict':
      return new StackVersionConflictError(
        message,
        versionConflict?.recordId ?? '',
        versionConflict?.expectedVersion ?? -1,
        versionConflict?.actualVersion ?? -1,
      );
    case 'bad_request':
      return new StackQueryError(message);
    case 'migration':
      return new StackMigrationError(message);
    case 'schema_drift':
      return new StackSchemaDriftError(schemaDrift?.typeId ?? '', schemaDrift?.violations ?? []);
    case 'payload_too_large':
      return new StackPayloadTooLargeError(message);
  }
}

/**
 * Reconstruct a core error from an HTTP status alone (no usable wire error
 * body). Returns null for statuses with no unambiguous code — callers
 * should fall back to a generic adapter-level error.
 */
export function errorForStatus(status: number, message: string): Error | null {
  const code = STATUS_TO_CODE[status];
  return code ? deserializeError({ error: { code, message } }) : null;
}
