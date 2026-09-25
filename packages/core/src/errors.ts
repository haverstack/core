/**
 * Stack errors — the error taxonomy
 * -------------------------------------------------------
 * Every error a Stack operation can raise, in one place. The hierarchy has
 * a single root so a server's error middleware can ask one question —
 * `instanceof StackError` — before serializing a wire body, and each
 * subclass carries its wire discriminator as an instance `code`.
 *
 * Several errors sit deliberately outside that root (StackClosedError,
 * StackMisconfigurationError, StackRelayScopeError, and — in their own
 * modules — IdGenerationError and InvalidDidError): they report a local
 * programming error or an assembled topology, not a state a request can be
 * in, so no server ever responds with one.
 */

import { baseIdOf, parseTypeId } from './schema.js';
import type { SchemaDriftViolation } from './schema.js';
import type { ValidationError } from './validate.js';
import type { MissingCapability, TypeId } from './types.js';

/**
 * The wire-protocol discriminator vocabulary, one code per Stack-domain
 * error class. Lives here rather than in @haverstack/wire-types because the
 * classes that carry these codes are defined here; wire-types re-exports it
 * as WireErrorCode. See docs/spec/wire-format.md § Wire error body.
 */
export type StackErrorCode =
  | 'bad_request'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'validation'
  | 'migration'
  | 'schema_drift'
  | 'payload_too_large'
  | 'timeout';

/**
 * Root of the Stack error taxonomy. A single `instanceof StackError` answers
 * "is this a Stack-domain error or a bug?" — the question a server's error
 * middleware asks before serializing a wire body, and one a nine-arm
 * instanceof ladder answers only by exhaustion. Every subclass carries its
 * discriminator as an instance `code`, so serialization is a lookup rather
 * than a chain of class tests.
 *
 * Membership implies a wire mapping: every code has an entry in
 * WIRE_ERROR_STATUS. Errors with no wire representation (IdGenerationError,
 * InvalidDidError) deliberately stay outside this hierarchy.
 *
 * Subclassing adds no hierarchy beyond this root — notably
 * StackVersionConflictError is a sibling of StackConflictError, not a
 * subtype. See docs/spec/wire-format.md § Error responses.
 */
export abstract class StackError extends Error {
  abstract readonly code: StackErrorCode;
}

export class StackValidationError extends StackError {
  static readonly code = 'validation' as const;
  override readonly code = StackValidationError.code;
  constructor(public readonly errors: ValidationError[]) {
    super(
      `Content validation failed:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
    this.name = 'StackValidationError';
  }
}

export class StackMigrationError extends StackError {
  static readonly code = 'migration' as const;
  override readonly code = StackMigrationError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackMigrationError';
  }
}

/** Thrown by ScopedStack when a requester lacks permission for the operation. */
export class StackPermissionError extends StackError {
  static readonly code = 'permission' as const;
  override readonly code = StackPermissionError.code;
  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'StackPermissionError';
  }
}

/** Thrown when a record (or specific version) does not exist. */
export class StackNotFoundError extends StackError {
  static readonly code = 'not_found' as const;
  override readonly code = StackNotFoundError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackNotFoundError';
  }
}

/** Thrown when an operation cannot proceed due to a constraint violation (e.g. deleting an attachment that is still referenced). */
export class StackConflictError extends StackError {
  static readonly code = 'conflict' as const;
  override readonly code = StackConflictError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackConflictError';
  }
}

/**
 * Thrown when an `ifVersion` precondition doesn't match a record's current
 * version. Deliberately not a StackConflictError subtype — the two have
 * different recovery stories and HTTP statuses (409 vs. 412). See
 * docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
 */
export class StackVersionConflictError extends StackError {
  static readonly code = 'version_conflict' as const;
  override readonly code = StackVersionConflictError.code;
  constructor(
    message: string,
    readonly recordId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(message);
    this.name = 'StackVersionConflictError';
  }
}

/**
 * Thrown when a request is structurally malformed — not a content-validation
 * failure, but input the adapter/server can't even interpret (e.g. an
 * undecodable pagination cursor, a malformed TypeId, search text the engine
 * cannot parse, or a typeId no definition exists for). Distinct from
 * StackValidationError, which means the request was well-formed but content
 * failed schema validation.
 *
 * Naming something absent belongs here rather than under `not_found`: a
 * request whose *type* is undefined never addressed a record, so answering
 * 404 would say a record was missing when none was asked for.
 */
export class StackBadRequestError extends StackError {
  static readonly code = 'bad_request' as const;
  override readonly code = StackBadRequestError.code;
  constructor(
    message: string,
    /**
     * Which declared capability the query asked for and the adapter lacks,
     * or undefined when the query's own shape is what was wrong — a
     * malformed content path is a caller error at every capability level.
     * A client mapping this onto an error of its own reads the name from
     * here rather than re-deriving it from the query, which is how one
     * rule becomes two answers that can disagree.
     */
    public readonly capability?: MissingCapability,
  ) {
    super(message);
    this.name = 'StackBadRequestError';
  }
}

/**
 * Thrown when an attachment upload exceeds the adapter's declared
 * `limits.attachmentBytes` ceiling — checked client-side before any bytes
 * are sent; a server still enforces 413 authoritatively regardless. See
 * docs/spec/wire-format.md § Attachments.
 */
export class StackPayloadTooLargeError extends StackError {
  static readonly code = 'payload_too_large' as const;
  override readonly code = StackPayloadTooLargeError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackPayloadTooLargeError';
  }
}

/**
 * Thrown when a server abandons an operation for taking too long — in
 * practice a full-text search, the one query whose cost the sanitizers
 * bound the *grammar* of but not the execution of (see
 * docs/spec/data-model.md § Capability-gated filters).
 *
 * Never produced in-process: both SQLite engines run synchronously, so
 * there is nothing to interrupt from inside the call. It exists so a
 * server that bounds query time has a class to serialize, and so the app
 * catching it can tell "too expensive, narrow it and retry" from
 * StackBadRequestError's "malformed, don't bother retrying" — the distinction
 * that would be lost if a timeout reused `bad_request`.
 */
export class StackTimeoutError extends StackError {
  static readonly code = 'timeout' as const;
  override readonly code = StackTimeoutError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackTimeoutError';
  }
}

/**
 * Thrown by defineType() when redefining an existing typeId with a schema
 * change beyond additive evolution. The remedy is a new version, never an
 * in-place redefinition. See docs/spec/data-model.md § Schema drift
 * detection.
 */
export class StackSchemaDriftError extends StackError {
  static readonly code = 'schema_drift' as const;
  override readonly code = StackSchemaDriftError.code;
  constructor(
    public readonly typeId: TypeId,
    public readonly violations: SchemaDriftViolation[],
  ) {
    super(
      `Schema drift detected for type "${typeId}": the stored schema and the new definition ` +
        `differ beyond additive evolution (new optional fields only). Bump the version instead ` +
        `of redefining "${typeId}" in place — e.g. defineType({ id: \`${baseIdOf(typeId)}@${(parseTypeId(typeId)?.version ?? 0) + 1}\`, ... }) plus registerMigration().\n` +
        violations.map((v) => `  ${v.path || '(root)'}: ${v.message}`).join('\n'),
    );
    this.name = 'StackSchemaDriftError';
  }
}

/**
 * Thrown when a Stack or ScopedStack is used after close(). Deliberately
 * outside the StackError taxonomy, alongside IdGenerationError and
 * InvalidDidError: a caller holding a closed client is a local programming
 * error with no wire representation — no server ever responds with it.
 * See docs/spec/adapters.md § Lifecycle.
 */
export class StackClosedError extends Error {
  constructor(message = 'This Stack has been closed.') {
    super(message);
    this.name = 'StackClosedError';
  }
}

/**
 * Thrown when Stack.open() is handed an adapter that cannot back a stack.
 * Outside the StackError taxonomy for the same reason StackClosedError is:
 * it reports a local setup mistake, not a state a request can be in.
 * See docs/spec.md § Stack initialization.
 */
export class StackMisconfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackMisconfigurationError';
  }
}

/**
 * Thrown when a scoped view is asked to observe a stack whose adapter
 * relays a remote feed. Outside the StackError taxonomy for the same
 * reason StackClosedError is: it reports a topology the caller assembled,
 * not a state a request can be in.
 *
 * A relayed frame is scoped by the authority that opened the feed, and a
 * narrower scope cannot re-derive that decision — a purge leaves no record
 * to check `canRead` against. Delivering anyway would break the promise
 * that a subscriber never sees what it may not read; delivering only local
 * writes would silently drop every change made elsewhere, which is the
 * failure that looks fine in testing. So it refuses.
 * See docs/spec/events.md § Permission scoping.
 */
export class StackRelayScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackRelayScopeError';
  }
}
