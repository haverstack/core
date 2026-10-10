/**
 * Stack errors — the error taxonomy
 * -------------------------------------------------------
 * Every error a Stack operation can raise, in one place. The hierarchy has
 * a single root so a server's error middleware can ask one question —
 * `instanceof StackError` — before serializing a wire body, and each
 * subclass carries its wire discriminator as an instance `code`.
 *
 * Several errors sit deliberately outside that root (UseAfterCloseError,
 * InvalidAdapterError, OwnerMismatchError, RelayScopeError, and — in their own
 * modules — IdGenerationError, InvalidDidError, InvalidAuthChallengeError and
 * StoredVersionError): they report a local programming error, malformed
 * local input or an assembled topology, not a state a request can be in, so
 * no server ever responds with one.
 *
 * The `Stack` prefix is reserved for the taxonomy: a class named
 * `Stack…Error` extends StackError, and nothing else carries the prefix.
 */

import { baseIdOf, parseTypeId } from './schema.js';
import type { SchemaDriftViolation } from './schema.js';
import type { ValidationError } from './validate.js';
import type { EntityId, MissingCapability, TypeId } from './types/index.js';

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
 * Root of the taxonomy: `instanceof StackError` is the one question a
 * server's error middleware asks, and each subclass's `code` makes
 * serialization a lookup. Every code has a WIRE_ERROR_STATUS entry.
 * Subclasses add no hierarchy — StackVersionConflictError is a sibling of
 * StackConflictError. See docs/spec/wire-format.md § Error responses.
 */
export abstract class StackError extends Error {
  abstract readonly code: StackErrorCode;
}

const CONTENT_INVALID = 'Content validation failed';
export const ARGUMENTS_INVALID = 'Invalid arguments';
export const SCHEMA_INVALID = 'Schema validation failed';

/**
 * `header` names what was validated — record content, or the arguments a
 * call was given — so a refusal of `associate([])` doesn't read as a
 * content failure. Only the message varies: `code` is the contract.
 */
export class StackValidationError extends StackError {
  static readonly code = 'validation' as const;
  override readonly code = StackValidationError.code;
  constructor(
    public readonly errors: ValidationError[],
    header: string = CONTENT_INVALID,
  ) {
    super(`${header}:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'));
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
  constructor(message: string) {
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
 * A request structurally malformed — an undecodable cursor, a malformed
 * TypeId, unparseable search text — as opposed to StackValidationError's
 * well-formed request with invalid content. Naming an undefined type is
 * here, not `not_found`: no record was asked for, so none is missing.
 */
export class StackBadRequestError extends StackError {
  static readonly code = 'bad_request' as const;
  override readonly code = StackBadRequestError.code;
  constructor(
    message: string,
    /**
     * The declared capability the query needed and the adapter lacks, or
     * undefined when the query's own shape was wrong. A client reads it from
     * here rather than re-deriving it, so one rule has one answer.
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
 * A server abandoned an operation for taking too long — in practice a
 * full-text search. Never produced in-process, since both SQLite engines
 * run synchronously; it lets an app tell "too expensive, narrow and retry"
 * from `bad_request`'s "malformed". See docs/spec/data-model.md § Capability-gated filters.
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
        `of redefining "${typeId}" in place — e.g. defineType({ id: \`${baseIdOf(typeId)}@${(parseTypeId(typeId)?.version ?? 0) + 1}\`, ... }) plus a migration() passed to Stack.open().\n` +
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
export class UseAfterCloseError extends Error {
  constructor(message = 'This Stack has been closed.') {
    super(message);
    this.name = 'UseAfterCloseError';
  }
}

/**
 * Thrown when Stack.open() is handed an adapter that cannot back a stack.
 * Outside the StackError taxonomy for the same reason UseAfterCloseError is:
 * it reports a local setup mistake, not a state a request can be in.
 * See docs/spec.md § Stack initialization.
 */
export class InvalidAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAdapterError';
  }
}

/**
 * Thrown by an adapter's open() when a plain-string `ownerEntityId` disagrees
 * with the owner the store already has. `where` names the path, URL or
 * Durable Object that was opened; `actual` is undefined when a server reports
 * no owner at all. Outside the StackError taxonomy for the same reason as
 * InvalidAdapterError. See docs/spec/adapters.md § Construction.
 */
export class OwnerMismatchError extends Error {
  constructor(
    public readonly expected: EntityId,
    public readonly actual: EntityId | undefined,
    public readonly where: string,
  ) {
    super(
      actual
        ? `Cannot open ${where}: it is owned by "${actual}", but ownerEntityId "${expected}" was given.`
        : `Cannot open ${where}: it reports no owner, but ownerEntityId "${expected}" was given.`,
    );
    this.name = 'OwnerMismatchError';
  }
}

/**
 * A scoped view asked to observe a stack that relays a remote feed. A
 * relayed frame was scoped by the authority that opened the feed, and a
 * narrower scope cannot re-derive that — a purge leaves nothing to check —
 * so it refuses rather than leak frames or silently drop remote changes.
 * See docs/spec/events.md § Permission scoping.
 */
export class RelayScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayScopeError';
  }
}
