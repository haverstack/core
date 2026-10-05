/**
 * App installs
 * -------------------------------------------------------
 * An app the owner does not run ships a manifest — the types it defines
 * and the type-level grants it asks for — and the owner applies it with
 * `Stack.planInstall()` then `Stack.installApp()`. What the stack keeps is
 * not the manifest but the owner's approval of it: an `_install` Record,
 * one per `appId`, linked by association to the `_app` cards it was
 * installed for and the `_grant` Records it produced. Its version history
 * is the upgrade log, and soft-deleting it is uninstalling.
 *
 * An install claims the families it defines, one install per family. That
 * claim is what lets a contained app commit migrations within its own
 * families without the owner running its code — see
 * ScopedStack.commitMigration().
 *
 * This module holds the parts that read an install as data: the write-time
 * shape rules, the family claim, and the plan diff. The verbs that write
 * live on `Stack`. See docs/spec/apps.md.
 */

import { baseIdOf, familyIdProblem, parseTypeId } from './schema.js';
import { GRANT_ACTION_SET, UNGRANTABLE_SYSTEM_TYPES } from './grants.js';
import { SYSTEM_TYPES } from './types.js';
import type {
  AppId,
  AuthorityAssociation,
  BaseId,
  EntityId,
  GrantAction,
  GrantContent,
  InstallContent,
  InstallRequest,
  RecordId,
  RelationshipAssociation,
  StackRecord,
  TypeId,
} from './types.js';
import type { DefineTypeOptions } from './stack.js';
import type { ValidationError } from './validate.js';

/** What an app ships: the types it defines and the grants it asks for. */
export type AppManifest = {
  appId: AppId;
  name: string;
  version?: string;
  types: DefineTypeOptions[];
  requests: InstallRequest[];
};

/** A request on a family this install does not define, and who owns that family. */
export type ForeignRequest = InstallRequest & {
  /**
   * The app whose namespace the family is in, whether or not it is
   * installed; `'commons'` or `'system'` for families no app owns; null
   * for a family with no namespace.
   */
  owner: AppId | 'commons' | 'system' | null;
};

/**
 * A manifest type whose definition would write: one not yet defined, or
 * defined with a different schema or name. Commons types included, since
 * defining one claims nothing but still fixes its shape for every app.
 */
export type TypeChange = {
  id: TypeId;
  change: 'new' | 'schema' | 'name';
};

/**
 * What applying a manifest would change, for the owner to approve.
 * `installApp()` applies a plan only while it is still what planning the
 * same manifest would produce. See docs/spec/apps.md § Plan, then apply.
 */
export type InstallPlan = {
  manifest: AppManifest;
  /** The key being installed. */
  did: EntityId;
  /** The install as it stood when planned — null for a first install. */
  existing: (StackRecord & { content: InstallContent }) | null;
  /** Families this install would claim that it does not claim yet. */
  newFamilies: BaseId[];
  /** Type versions not yet in the install's `defines`. */
  newVersions: TypeId[];
  requestsAdded: InstallRequest[];
  requestsRemoved: InstallRequest[];
  /** Requests on families the manifest does not define — the ones an approval most needs to show. */
  foreignRequests: ForeignRequest[];
  /** Every manifest type `installApp()` would define or redefine. */
  typeChanges: TypeChange[];
  /** Whether `did` is a key this install is not yet linked to. */
  newKey: boolean;
  /**
   * The keys already linked to the install. Each holds `requests`, so a
   * plan that changes them changes every one — and a new key joins them
   * as the same app. See docs/spec/apps.md § Plan, then apply.
   */
  linkedKeys: EntityId[];
};

/** Relationship label from an install to an `_app` card it was installed for. */
export const INSTALL_APP_LABEL = 'install.app';
/** Relationship label from an install to a `_grant` it produced. */
export const INSTALL_GRANT_LABEL = 'install.grant';

export const installAppLink = (recordId: RecordId): RelationshipAssociation => ({
  kind: 'relationship',
  label: INSTALL_APP_LABEL,
  target: { kind: 'record', recordId },
});

export const installGrantLink = (recordId: RecordId): RelationshipAssociation => ({
  kind: 'relationship',
  label: INSTALL_GRANT_LABEL,
  target: { kind: 'record', recordId },
});

/** Record-level `read` on an install for one of its keys. */
export const installReader = (entityId: EntityId): AuthorityAssociation => ({
  kind: 'permission',
  label: 'read',
  grantee: { kind: 'entity', entityId },
});

/** Record ids an install links to under `label`. */
export function linkedIds(record: StackRecord, label: string): RecordId[] {
  const ids: RecordId[] = [];
  for (const a of record.associations ?? []) {
    if (a.kind === 'relationship' && a.label === label && a.target.kind === 'record') {
      ids.push(a.target.recordId);
    }
  }
  return ids;
}

const SYSTEM_FAMILIES: ReadonlySet<string> = new Set(Object.values(SYSTEM_TYPES));

export const isSystemFamily = (baseId: BaseId): boolean => SYSTEM_FAMILIES.has(baseId);

/** The Schema Commons namespace: families no app owns. See docs/commons/README.md. */
export const COMMONS_NAMESPACE = 'org.haverstack';

/** The part of a family before its `/` — `com.example.notes` for `com.example.notes/note`. */
export const namespaceOf = (baseId: BaseId): string | null => {
  const slash = baseId.indexOf('/');
  return slash > 0 ? baseId.slice(0, slash) : null;
};

/**
 * How a family stands toward the app `appId`: its own (the family's
 * namespace is the `appId`), a commons or system family nobody owns, or
 * another app's. Only an app's own families can be claimed, so which app
 * owns a family never depends on which was installed first.
 * See docs/spec/apps.md § Who owns a family.
 */
export function familyStanding(
  baseId: BaseId,
  appId: AppId,
): 'own' | 'commons' | 'system' | 'foreign' {
  if (isSystemFamily(baseId)) return 'system';
  const namespace = namespaceOf(baseId);
  if (namespace === COMMONS_NAMESPACE) return 'commons';
  return namespace === appId ? 'own' : 'foreign';
}

/**
 * The families an install claims, read as data: entries that are not
 * well-formed TypeIds claim nothing.
 */
export function claimedFamilies(content: unknown): Set<BaseId> {
  const defines = (content as { defines?: unknown } | null)?.defines;
  const families = new Set<BaseId>();
  if (!Array.isArray(defines)) return families;
  for (const id of defines) {
    if (typeof id !== 'string') continue;
    const parsed = parseTypeId(id);
    if (parsed) families.add(parsed.baseId);
  }
  return families;
}

/**
 * An `_install`'s `defines` and `requests`, asked of its content on every
 * write. A schema can say both are lists; only this can say what their
 * entries must name. See docs/spec/apps.md § The `_install` record.
 */
export function validateInstall(typeId: TypeId, content: unknown): ValidationError[] {
  if (baseIdOf(typeId) !== SYSTEM_TYPES.INSTALL) return [];
  const c = content as Partial<Record<keyof InstallContent, unknown>> | null;
  const errors: ValidationError[] = [];
  if (Array.isArray(c?.defines)) {
    c.defines.forEach((id, i) => {
      const parsed = typeof id === 'string' ? parseTypeId(id) : null;
      if (!parsed) {
        errors.push({ path: `defines[${i}]`, message: 'Expected a versioned TypeId' });
      } else if (typeof c?.appId === 'string' && familyStanding(parsed.baseId, c.appId) !== 'own') {
        errors.push({
          path: `defines[${i}]`,
          message: `"${parsed.baseId}" is outside the namespace "${c.appId}"; an install claims only its own families`,
        });
      }
    });
  }
  if (Array.isArray(c?.requests)) {
    c.requests.forEach((r, i) => {
      const req = r as Partial<Record<keyof InstallRequest, unknown>> | null;
      const problem = familyIdProblem(req?.baseId, `requests[${i}].baseId`);
      if (problem) {
        errors.push({ path: `requests[${i}].baseId`, message: problem });
      } else if (UNGRANTABLE_SYSTEM_TYPES.has(req!.baseId as string)) {
        errors.push({
          path: `requests[${i}].baseId`,
          message: `"${String(req!.baseId)}" cannot be granted, so no install can request it`,
        });
      }
      if (Array.isArray(req?.actions)) {
        req.actions.forEach((a, j) => {
          if (!GRANT_ACTION_SET.has(a as GrantAction)) {
            errors.push({
              path: `requests[${i}].actions[${j}]`,
              message: `Unknown grant action "${String(a)}"`,
            });
          }
        });
      }
    });
  }
  return errors;
}

/** The manifest's types in its own namespace — the versions an install of it defines. */
export function ownTypeIds(manifest: AppManifest): TypeId[] {
  const ids = manifest.types
    .map((t) => t.id)
    .filter((id) => familyStanding(baseIdOf(id), manifest.appId) === 'own');
  return [...new Set(ids)];
}

/**
 * A deep-frozen copy of `manifest`, so the plan that holds it applies what
 * was reviewed even if the caller's object changes afterwards.
 */
export function snapshotManifest(manifest: AppManifest): AppManifest {
  return deepFreeze(structuredClone(manifest));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Whether two requests ask for the same family and exactly the same actions. */
export function sameRequest(a: InstallRequest, b: InstallRequest): boolean {
  if (a.baseId !== b.baseId) return false;
  const as = new Set(a.actions);
  const bs = new Set(b.actions);
  return as.size === bs.size && [...bs].every((x) => as.has(x));
}

/** Whether a stored grant is exactly `request`, made out to `did`. */
export function grantIsRequest(
  grant: GrantContent,
  request: InstallRequest,
  did: EntityId,
): boolean {
  if (grant.grantee?.kind !== 'entity' || grant.grantee.entityId !== did) return false;
  if (!Array.isArray(grant.actions)) return false;
  return sameRequest({ baseId: grant.baseId, actions: grant.actions }, request);
}

/**
 * Whether applying `plan` would change nothing: the install is live, this
 * key is linked to it, the manifest adds and removes nothing, and its
 * `name` and `version` are the ones the install holds. A server
 * answers such a request as already installed rather than queuing it.
 * See docs/spec/wire-format.md § Installs.
 */
export function isPlanEmpty(plan: InstallPlan): boolean {
  return (
    plan.existing !== null &&
    !plan.existing.deletedAt &&
    !plan.newKey &&
    plan.manifest.name === plan.existing.content.name &&
    (plan.manifest.version ?? null) === (plan.existing.content.version ?? null) &&
    plan.newFamilies.length === 0 &&
    plan.newVersions.length === 0 &&
    plan.typeChanges.length === 0 &&
    plan.requestsAdded.length === 0 &&
    plan.requestsRemoved.length === 0
  );
}

/**
 * The parts of a plan that depend on the stack's state — what
 * `installApp()` compares to refuse a stale one.
 */
export function planFingerprint(plan: InstallPlan): string {
  return JSON.stringify([
    plan.existing?.id ?? null,
    plan.existing?.version ?? null,
    plan.existing?.deletedAt ? true : false,
    plan.newFamilies,
    plan.newVersions,
    plan.requestsAdded,
    plan.requestsRemoved,
    plan.foreignRequests,
    plan.typeChanges,
    plan.newKey,
    plan.linkedKeys,
  ]);
}
