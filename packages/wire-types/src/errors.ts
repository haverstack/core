/**
 * Error responses
 * -------------------------------------------------------
 * The round-trip contract for core's typed error taxonomy: a server
 * serializes a caught core error via serializeError(), and APIAdapter
 * reconstructs the same class via deserializeError(). `code` is the
 * authoritative discriminator; status is a transport hint. See
 * docs/spec/wire-format.md § Error responses.
 */

import {
  StackError,
  StackValidationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackMigrationError,
  StackBadRequestError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
  StackTimeoutError,
} from '@haverstack/core';
import type { SchemaDriftViolation, StackErrorCode, ValidationError } from '@haverstack/core';

/**
 * Alias of core's StackErrorCode: the vocabulary belongs with the classes
 * that carry it, and StackError.code is typed by it, so re-declaring the
 * union here would be a second copy to drift.
 */
export type WireErrorCode = StackErrorCode;

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
  /**
   * 503, not 408 or 504: the request arrived fine (408 says it didn't) and
   * the server is not a gateway (504 says it is) — it declined to keep
   * spending its own time on this one. Retryable, which is the part a
   * client acts on, and the reason a query timeout must not reuse
   * `bad_request`: that code means "malformed, retrying won't help."
   */
  timeout: 503,
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
  // 503 is deliberately excluded, for the same reason as 500: a bodyless
  // 503 is a load balancer or a restarting process saying "not right now",
  // and reporting that as StackTimeoutError would tell an app its query
  // was too expensive when the server never saw it. The typed body is
  // what distinguishes the two, so `timeout` only reconstructs from one.
};

const KNOWN_CODES = new Set<string>(Object.keys(WIRE_ERROR_STATUS));

/** Whether `body` is `{ error: { code, message } }` with a code from `codes`. */
export function hasErrorBody(body: unknown, codes: ReadonlySet<string>): boolean {
  if (!body || typeof body !== 'object') return false;
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return typeof code === 'string' && codes.has(code) && typeof message === 'string';
}

/** Type guard: does this parsed JSON body look like a WireError? */
export function isWireError(body: unknown): body is WireError {
  return hasErrorBody(body, KNOWN_CODES);
}

/**
 * Convert a thrown core error into its wire response. Used by server
 * implementations. Returns null for anything that isn't a StackError —
 * callers fall back to their own generic error handling, so an ordinary bug
 * stays a bare 500 rather than being dressed as a protocol error.
 */
export function serializeError(err: unknown): { status: number; body: WireError } | null {
  if (!(err instanceof StackError)) return null;
  const error: WireError['error'] = { code: err.code, message: err.message };
  // The three classes carrying structured payload still need instanceof: a
  // literal `code` doesn't narrow a class type to its subclass in TypeScript.
  // Order-independent, since these are leaves with no subtype relation.
  if (err instanceof StackValidationError) {
    error.details = err.errors;
  } else if (err instanceof StackVersionConflictError) {
    error.versionConflict = {
      recordId: err.recordId,
      expectedVersion: err.expectedVersion,
      actualVersion: err.actualVersion,
    };
  } else if (err instanceof StackSchemaDriftError) {
    error.schemaDrift = { typeId: err.typeId, violations: err.violations };
  }
  return { status: WIRE_ERROR_STATUS[err.code], body: { error } };
}

/** Reconstruct the core error a WireError body describes. */
export function deserializeError(body: WireError): Error {
  const { code, message, details, versionConflict, schemaDrift } = body.error;
  switch (code) {
    case 'validation':
      // The header is the message's first line, kept so a reconstructed
      // error still says what the server validated.
      return new StackValidationError(details ?? [], message.split('\n')[0].replace(/:$/, ''));
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
      return new StackBadRequestError(message);
    case 'migration':
      return new StackMigrationError(message);
    case 'schema_drift':
      return new StackSchemaDriftError(schemaDrift?.typeId ?? '', schemaDrift?.violations ?? []);
    case 'payload_too_large':
      return new StackPayloadTooLargeError(message);
    case 'timeout':
      return new StackTimeoutError(message);
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
