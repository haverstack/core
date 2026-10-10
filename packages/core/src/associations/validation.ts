/**
 * Association validation
 * -------------------------------------------------------
 * The rules an association is held to before it is stored: a known kind,
 * only the keys that kind defines, a well-formed target or grantee, the
 * right half of the authority/data partition, and each identity named
 * once. A discriminated union is a compile-time promise, and a server
 * mapping a request body onto one supplies raw JSON no compiler has seen,
 * so the rules live in the invariant layer where no adapter can forget
 * one. See docs/spec/data-model.md § Associations.
 */

import { ARGUMENTS_INVALID, StackBadRequestError, StackValidationError } from '../errors.js';
import { associationEqual, isAuthorityAssociation } from './identity.js';
import type { ValidationError } from '../validate.js';
import type {
  AnyoneAssociation,
  Association,
  AssociationEdit,
  AttachmentAssociation,
  AuthorityAssociation,
  DataAssociation,
  EntityTarget,
  ExternalTarget,
  GrantGrantee,
  Grantee,
  PermissionAssociation,
  RecordTarget,
  RelationshipAssociation,
  RelationshipTarget,
  RelationshipTargetPattern,
  TagAssociation,
} from '../types/index.js';

/** The identifier spaces a relationship target may name. */
const TARGET_KINDS = new Set(['record', 'entity', 'external']);

/**
 * The keys of one arm of a union, listed as an object so the compiler
 * holds the list to the type: a field added to the arm fails to compile
 * here until it is listed.
 */
const keysOf = <T>(keys: Record<keyof T, true>): readonly string[] => Object.keys(keys);

/** Every key each relationship target arm defines. */
export const TARGET_KEYS: Record<RelationshipTarget['kind'], readonly string[]> = {
  record: keysOf<RecordTarget>({ kind: true, recordId: true, stackUrl: true }),
  entity: keysOf<EntityTarget>({ kind: true, entityId: true }),
  external: keysOf<ExternalTarget>({ kind: true, ns: true, id: true }),
};

/** Every key each association kind defines. */
const ASSOCIATION_KEYS: Record<Association['kind'], readonly string[]> = {
  tag: keysOf<TagAssociation>({ kind: true, label: true }),
  attachment: keysOf<AttachmentAssociation>({
    kind: true,
    label: true,
    fileId: true,
    attachmentRecordId: true,
  }),
  relationship: keysOf<RelationshipAssociation>({ kind: true, label: true, target: true }),
  permission: keysOf<PermissionAssociation>({ kind: true, label: true, grantee: true }),
  anyone: keysOf<AnyoneAssociation>({ kind: true, label: true }),
};

/** Every key each grantee arm defines, the default tier included. */
export const GRANTEE_KEYS: Record<GrantGrantee['kind'], readonly string[]> = {
  entity: keysOf<Extract<Grantee, { kind: 'entity' }>>({ kind: true, entityId: true }),
  group: keysOf<Extract<Grantee, { kind: 'group' }>>({ kind: true, groupId: true, role: true }),
  authenticated: keysOf<Extract<GrantGrantee, { kind: 'authenticated' }>>({ kind: true }),
};

/**
 * The keys of `value` its arm does not define. An element carrying one is
 * refused rather than stored: an adapter keeps only the keys it has
 * columns for, so the rest would answer 200 and then vanish.
 * See docs/spec/data-model.md § Associations.
 */
export function unknownKeys(value: object, keys: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !keys.includes(key));
}

/** unknownKeys() as a refusal. 400, not 422: the key addresses nothing. */
export function assertKnownKeys(value: object, keys: readonly string[], path: string): void {
  const unknown = unknownKeys(value, keys);
  if (unknown.length > 0)
    throw new StackBadRequestError(
      `Unknown key${unknown.length > 1 ? 's' : ''} in ${path}: ${unknown.join(', ')}`,
    );
}

/**
 * Collect what makes a relationship target malformed. Absence is
 * meaningful on `stackUrl` and an external `id` — this stack, and the
 * whole namespace — so every part that names something must be non-empty:
 * an empty string stores and matches as though it were absent.
 * See docs/spec/data-model.md § Relationship targets.
 */
export function targetErrors(
  target: RelationshipTarget | RelationshipTargetPattern,
  path: string,
  opts: { externalIdOptional?: boolean } = {},
): ValidationError[] {
  const fail = (message: string): ValidationError[] => [{ path, message }];
  if (!target || typeof target !== 'object')
    return fail('A relationship target must be an object.');
  if (!TARGET_KINDS.has(target.kind)) {
    return fail(
      `Unknown relationship target kind "${target.kind}": expected "record", "entity" or "external".`,
    );
  }
  assertKnownKeys(target, TARGET_KEYS[target.kind], path);
  if (target.kind === 'record') {
    if (!target.recordId) return fail('A record target requires a non-empty recordId.');
    if (target.stackUrl !== undefined && !target.stackUrl) {
      return fail("A record target's stackUrl must be non-empty; omit it to name this stack.");
    }
    return [];
  }
  if (target.kind === 'entity') {
    return target.entityId ? [] : fail('An entity target requires a non-empty entityId.');
  }
  if (!target.ns) return fail('An external target requires a non-empty ns.');
  if (target.id === undefined) {
    return opts.externalIdOptional ? [] : fail('An external target requires an id.');
  }
  return target.id ? [] : fail("An external target's id must be non-empty when present.");
}

/** The kinds an association may name — the closed set every surface reads. */
const ASSOCIATION_KINDS = new Set(['tag', 'attachment', 'relationship', 'permission', 'anyone']);

/**
 * Whether a value is an association at all. Asked ahead of the partition
 * checks, so a malformed element is named as one rather than reported as
 * the wrong surface for a kind it never had — a request body supplies raw
 * JSON, and `null` or `{}` is neither half of the partition.
 */
function namesKind(association: Association): boolean {
  return (
    !!association &&
    typeof association === 'object' &&
    ASSOCIATION_KINDS.has((association as { kind?: unknown }).kind as string)
  );
}

/**
 * Reject a relationship target outside the closed set the types promise.
 * A discriminated union is not a runtime guard — a server mapping a
 * request body onto an association supplies raw JSON — and an
 * unrecognized kind would otherwise be stored under the one arm that
 * names a Record in this stack. See docs/spec/data-model.md
 * § Relationship targets.
 *
 * A key the element's kind does not define is thrown as a 400 rather than
 * collected, at every depth: it addresses nothing, the way an unknown key
 * on a request body does. See docs/spec/data-model.md § Associations.
 */
export function validateAssociation(
  association: Association,
  path = 'association',
): ValidationError[] {
  if (!namesKind(association)) {
    return [
      {
        path: `${path}.kind`,
        message: `Unknown association kind "${String((association as { kind?: unknown })?.kind)}": expected ${[...ASSOCIATION_KINDS].map((k) => `"${k}"`).join(', ')}.`,
      },
    ];
  }
  assertKnownKeys(association, ASSOCIATION_KEYS[association.kind], path);
  if (association.kind === 'permission') {
    return permissionErrors(association, path);
  }
  if (association.kind === 'anyone') {
    return association.label === 'read'
      ? []
      : [{ path: `${path}.label`, message: 'An `anyone` association carries only `read`.' }];
  }
  if (association.kind !== 'relationship') return [];
  return targetErrors(association.target, `${path}.target`);
}

/**
 * Who a duplicated permission names, since kind and label alone don't
 * distinguish two grants of the same bit to different grantees.
 */
function granteeSuffix(association: Association): string {
  if (association.kind !== 'permission') return '';
  const g = association.grantee;
  return g.kind === 'entity' ? ` for "${g.entityId}"` : ` for ${g.role}s of "${g.groupId}"`;
}

/** The bits a permission element may name — the whole of its meaning. */
const PERMISSION_LABELS = new Set(['read', 'write']);

/** A permission element's label and grantee — see granteeErrors(). */
function permissionErrors(
  association: { label: string; grantee: Grantee },
  path: string,
): ValidationError[] {
  if (!PERMISSION_LABELS.has(association.label)) {
    return [
      {
        path: `${path}.label`,
        message: `Unknown permission label "${association.label}": expected "read" or "write".`,
      },
    ];
  }
  const grantee = association.grantee;
  if (!grantee || typeof grantee !== 'object') {
    return [{ path: `${path}.grantee`, message: 'A permission requires a grantee.' }];
  }
  if (grantee.kind === 'entity' || grantee.kind === 'group')
    assertKnownKeys(grantee, GRANTEE_KEYS[grantee.kind], `${path}.grantee`);
  return granteeErrors(grantee, `${path}.grantee`);
}

/**
 * What makes a grantee malformed, under `path`. `role` is required: there is
 * no "any member" default to fall back on. `authenticated` is a tier on a
 * `_grant` alone, and `anyRole` admits a listing's `role: 'any'`. Unknown keys
 * are the caller's, since whether one is a 400 depends on the surface.
 */
export function granteeErrors(
  grantee: unknown,
  path: string,
  opts: { authenticated?: boolean; anyRole?: boolean } = {},
): ValidationError[] {
  const g = (grantee ?? {}) as Partial<Record<'kind' | 'entityId' | 'groupId' | 'role', unknown>>;
  switch (g.kind) {
    case 'authenticated':
      if (opts.authenticated) return [];
      break;
    case 'entity':
      return typeof g.entityId === 'string' && g.entityId.length > 0
        ? []
        : [
            {
              path: `${path}.entityId`,
              message: 'An entity grantee requires a non-empty entityId',
            },
          ];
    case 'group': {
      const errors: ValidationError[] = [];
      if (typeof g.groupId !== 'string' || g.groupId.length === 0) {
        errors.push({
          path: `${path}.groupId`,
          message: 'A group grantee requires a non-empty groupId',
        });
      }
      if (g.role !== 'member' && g.role !== 'admin' && !(opts.anyRole && g.role === 'any')) {
        errors.push({
          path: `${path}.role`,
          message: opts.anyRole
            ? "A group grantee requires role 'member', 'admin' or 'any'"
            : "A group grantee requires role 'member' or 'admin'",
        });
      }
      return errors;
    }
  }
  return [
    {
      path: `${path}.kind`,
      message: opts.authenticated
        ? "A grantee must name its tier: 'entity', 'group' or 'authenticated'"
        : "A grantee must name its tier: 'entity' or 'group'",
    },
  ];
}

/**
 * Refuse an authority element reaching the data half of the partition.
 * The two share a table, a delta shape and a durability tier; they never
 * share a call, because an app editing tags would otherwise be able to
 * replace an ACL it was never shown. Thrown rather than collected: the
 * caller named the wrong surface, not a malformed value, and the verb it
 * wanted is `grantAccess()`/`revokeAccess()`.
 *
 * Lives here, in the invariant layer, so an unscoped `Stack`, an import
 * and a server mapping a request body are all held to it.
 * See docs/spec/access-control.md § Record-level permissions.
 */
export function assertDataAssociations(
  associations: readonly Association[],
  surface: string,
): asserts associations is DataAssociation[] {
  const authority = associations.find((a) => namesKind(a) && isAuthorityAssociation(a));
  if (!authority) return;
  throw new StackBadRequestError(
    `${surface} does not carry authority: a "${authority.kind}" association belongs to the ` +
      '`permissions` surface — use grantAccess()/revokeAccess(), or the `permissions` change-set key.',
  );
}

/**
 * The mirror of assertDataAssociations(): the `permissions` surface takes
 * authority kinds alone, so a tag routed through it is refused rather than
 * quietly becoming an ACL entry the `associations` projection never shows.
 */
export function assertAuthorityAssociations(
  permissions: readonly Association[],
  surface: string,
): asserts permissions is AuthorityAssociation[] {
  const data = permissions.find((a) => namesKind(a) && !isAuthorityAssociation(a));
  if (!data) return;
  throw new StackBadRequestError(
    `${surface} carries authority alone: a "${data.kind}" association belongs to the ` +
      '`associations` surface — use associate()/dissociate(), or the `associations` change-set key.',
  );
}

/**
 * Every association in a list, plus the one rule a list has that a single
 * association does not: **identities are distinct**. A list naming one
 * identity twice describes a state no store can hold — an adapter keys
 * associations by identity, so the second entry displaces the first — and
 * which of the two the record ends up with is a question the caller did
 * not mean to ask. Refused rather than collapsed, for the reason an empty
 * change set is refused: every way of producing one is a caller bug.
 * See docs/spec/data-model.md § Associations.
 */
export function validateAssociations(
  associations: Association[] | undefined,
  path = 'associations',
): ValidationError[] {
  const list = associations ?? [];
  return [
    ...list.flatMap((a, i) => validateAssociation(a, `${path}[${i}]`)),
    ...duplicateIdentityErrors(list, path),
  ];
}

/** Each element naming an identity an earlier element already named. */
function duplicateIdentityErrors(list: Association[], path: string): ValidationError[] {
  return list.flatMap((a, i) =>
    list.slice(0, i).some((b) => associationEqual(a, b))
      ? [
          {
            path: `${path}[${i}]`,
            message: `Duplicate association identity: ${a.kind} "${a.label}"${granteeSuffix(a)} is named more than once.`,
          },
        ]
      : [],
  );
}

/**
 * Hold an association edit list to the rules every verb shares: non-empty,
 * every element a known `op` over a well-formed association, one surface,
 * and each identity named once — a list that both removes and adds one
 * identity is the same ambiguity as naming it twice. `repoint` is the
 * journal's word, never a request. Asked of the whole list before anything
 * is read or written. See docs/spec/data-model.md § Mutations.
 */
export function assertAssociationEdits(
  changes: unknown,
  surface: string,
  half: 'data' | 'authority',
): asserts changes is AssociationEdit[] {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new StackValidationError(
      [{ path: 'changes', message: `${surface} names at least one change.` }],
      ARGUMENTS_INVALID,
    );
  }
  const errors: ValidationError[] = [];
  changes.forEach((raw: unknown, i) => {
    const path = `changes[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push({ path, message: `${path} must be an object.` });
      return;
    }
    const edit = raw as { op?: unknown; association?: unknown };
    if (edit.op !== 'repoint') assertKnownKeys(edit, ['op', 'association'], path);
    if (edit.op === 'repoint') {
      errors.push({
        path: `${path}.op`,
        message:
          'op: "repoint" is recorded by the journal, not requested. ' +
          "Send { op: 'add', association }: an add naming an attachment the record already holds re-points it in place.",
      });
    } else if (edit.op !== 'add' && edit.op !== 'remove') {
      errors.push({ path: `${path}.op`, message: 'op must be "add" or "remove".' });
    }
    errors.push(...validateAssociation(edit.association as Association, `${path}.association`));
  });
  if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);

  const associations = (changes as AssociationEdit[]).map((c) => c.association);
  if (half === 'data') assertDataAssociations(associations, surface);
  else assertAuthorityAssociations(associations, surface);

  const duplicates = duplicateIdentityErrors(associations, 'changes');
  if (duplicates.length > 0) throw new StackValidationError(duplicates, ARGUMENTS_INVALID);
}

/**
 * assertAssociationEdits() for the verbs taking a bare association list —
 * associate(), grantAccess() and their inverses — asked before the list is
 * wrapped as edits, so each problem is reported under `param`, the name the
 * caller passed it as, rather than the wrapped list's `changes`. The checks
 * run in the same order, so a wrong-surface element is refused as such
 * before its duplicates are counted.
 */
export function assertAssociationList(
  associations: unknown,
  surface: string,
  param: string,
  half: 'data' | 'authority',
): asserts associations is Association[] {
  if (!Array.isArray(associations) || associations.length === 0) {
    throw new StackValidationError(
      [{ path: param, message: `${surface} names at least one association.` }],
      ARGUMENTS_INVALID,
    );
  }
  const errors = associations.flatMap((raw: unknown, i) =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? []
      : [{ path: `${param}[${i}]`, message: `${param}[${i}] must be an object.` }],
  );
  if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);
  const list = associations as Association[];
  const shapeErrors = list.flatMap((a, i) => validateAssociation(a, `${param}[${i}]`));
  if (shapeErrors.length > 0) throw new StackValidationError(shapeErrors, ARGUMENTS_INVALID);
  if (half === 'data') assertDataAssociations(list, surface);
  else assertAuthorityAssociations(list, surface);
  const listErrors = validateAssociations(list, param);
  if (listErrors.length > 0) throw new StackValidationError(listErrors, ARGUMENTS_INVALID);
}
