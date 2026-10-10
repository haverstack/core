/**
 * App installs
 * -------------------------------------------------------
 * Planning, applying and withdrawing an app's install over an unscoped
 * Stack: the bodies of Stack.planInstall(), installApp() and
 * uninstallApp(), whose doc comments describe the contract. Written
 * against Stack's public API alone, so every write here passes the same
 * checks any other caller's would. See docs/spec/apps.md.
 */

import {
  ARGUMENTS_INVALID,
  StackConflictError,
  StackNotFoundError,
  StackSchemaDriftError,
  StackValidationError,
} from '../errors.js';
import { checkGrantValid } from '../grants.js';
import {
  INSTALL_APP_LABEL,
  INSTALL_GRANT_LABEL,
  claimedFamilies,
  familyStanding,
  grantIsRequest,
  installAppLink,
  installGrantLink,
  installReader,
  linkedIds,
  namespaceOf,
  ownTypeIds,
  planFingerprint,
  sameRequest,
  snapshotManifest,
} from '../install.js';
import { filtersContent } from '../query-validation.js';
import { baseIdOf, diffSchemas, hashSchema, parseTypeId } from '../schema.js';
import { findFirstMatch, queryAllPages } from '../stack-reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import {
  validateSchemaFieldNames,
  validateSchemaReservedNames,
  validateSchemaShape,
} from '../validate.js';
import type { AppManifest, ForeignRequest, InstallPlan, TypeChange } from '../install.js';
import type {
  AppContent,
  AppId,
  AssociationEdit,
  AuthorityAssociation,
  BaseId,
  EntityId,
  GrantContent,
  InstallContent,
  InstallRequest,
  StackRecord,
  TypeSchema,
} from '../types/index.js';
import type { ValidationError } from '../validate.js';
import type { Stack } from './stack.js';

export async function planInstall(
  stack: Stack,
  submitted: AppManifest,
  opts: { did: EntityId },
): Promise<InstallPlan> {
  const { did } = opts;
  const manifest = snapshotManifest(submitted);
  checkManifest(manifest, did);

  const installs = await loadInstalls(stack);
  const existing = installs.find((r) => r.content.appId === manifest.appId) ?? null;
  const ownVersions = ownTypeIds(manifest);
  const ownFamilies = new Set(ownVersions.map(baseIdOf));

  const card = await findAppCard(stack, did);
  if (card && (card.content as AppContent).appId !== manifest.appId) {
    throw new StackConflictError(
      `${did} is registered to "${(card.content as AppContent).appId}", not "${manifest.appId}"`,
    );
  }

  const claimed = existing ? claimedFamilies(existing.content) : new Set<BaseId>();
  const defined = new Set(existing?.content.defines ?? []);
  const prior = existing?.content.requests ?? [];
  const foreignRequests: ForeignRequest[] = [];
  for (const r of manifest.requests) {
    const standing = familyStanding(r.baseId, manifest.appId);
    if (standing === 'own') continue;
    const owner =
      standing === 'foreign'
        ? namespaceOf(r.baseId)
        : standing === 'commons'
          ? 'commons'
          : 'system';
    foreignRequests.push({ ...r, owner });
  }

  const typeChanges: TypeChange[] = [];
  for (const t of manifest.types) {
    const current = await stack.getType(t.id);
    if (!current) typeChanges.push({ id: t.id, change: 'new' });
    else if (current.schemaHash !== (await hashSchema(t.schema as TypeSchema))) {
      // Refused here, not left to defineType(): installApp() defines types one
      // by one, so a drift found there leaves the earlier ones written.
      const violations = diffSchemas(current.schema, t.schema as TypeSchema);
      if (violations.length > 0) throw new StackSchemaDriftError(t.id, violations);
      typeChanges.push({ id: t.id, change: 'schema' });
    } else if (current.name !== t.name) typeChanges.push({ id: t.id, change: 'name' });
  }

  const linkedKeys: EntityId[] = [];
  for (const id of existing ? linkedIds(existing, INSTALL_APP_LABEL) : []) {
    const key = ((await stack.get(id))?.content as AppContent | undefined)?.did;
    if (typeof key === 'string') linkedKeys.push(key);
  }

  return {
    manifest,
    did,
    existing,
    newFamilies: [...ownFamilies].filter((f) => !claimed.has(f)),
    newVersions: ownVersions.filter((id) => !defined.has(id)),
    requestsAdded: manifest.requests.filter((r) => !prior.some((p) => sameRequest(p, r))),
    requestsRemoved: prior.filter((p) => !manifest.requests.some((r) => sameRequest(p, r))),
    foreignRequests,
    typeChanges,
    newKey:
      !existing ||
      !card ||
      card.deletedAt !== undefined ||
      !linkedIds(existing, INSTALL_APP_LABEL).includes(card.id),
    linkedKeys,
  };
}

export async function installApp(
  stack: Stack,
  plan: InstallPlan,
): Promise<StackRecord & { content: InstallContent }> {
  const fresh = await planInstall(stack, plan.manifest, { did: plan.did });
  if (planFingerprint(fresh) !== planFingerprint(plan)) {
    throw new StackConflictError(
      `The stack changed since the install of "${plan.manifest.appId}" was planned; plan it again`,
    );
  }
  const { manifest, did, existing } = fresh;

  for (const type of manifest.types) await stack.defineType(type);
  const card = await ensureAppCard(stack, manifest, did);

  const defines = [...new Set([...(existing?.content.defines ?? []), ...ownTypeIds(manifest)])];
  const requests: InstallRequest[] = manifest.requests.map((r) => ({
    baseId: r.baseId,
    actions: [...r.actions],
  }));

  let install: StackRecord;
  if (!existing) {
    install = await stack.create<InstallContent>(
      `${SYSTEM_TYPES.INSTALL}@1`,
      {
        appId: manifest.appId,
        name: manifest.name,
        ...(manifest.version !== undefined && { version: manifest.version }),
        defines,
        requests,
      },
      { associations: [installAppLink(card.id)] },
    );
  } else {
    const current = existing.deletedAt ? await stack.undelete(existing.id) : existing;
    install = await stack.patchContent(
      existing.id,
      { name: manifest.name, version: manifest.version ?? null, defines, requests },
      { ifVersion: current.version },
    );
    if (!linkedIds(install, INSTALL_APP_LABEL).includes(card.id)) {
      install = await stack.associate(install.id, [installAppLink(card.id)]);
    }
  }
  return (await reconcileInstallGrants(stack, install)) as StackRecord & {
    content: InstallContent;
  };
}

export async function uninstallApp(
  stack: Stack,
  appId: AppId,
): Promise<StackRecord & { content: InstallContent }> {
  const install = (await loadInstalls(stack)).find(
    (r) => r.content.appId === appId && !r.deletedAt,
  );
  if (!install) throw new StackNotFoundError(`No install for "${appId}"`);
  const edits: AssociationEdit[] = [];
  for (const id of linkedIds(install, INSTALL_GRANT_LABEL)) {
    if (await stack.get(id)) await stack.delete(id);
    edits.push({ op: 'remove', association: installGrantLink(id) });
  }
  if (edits.length > 0) await stack.amendAssociations(install.id, edits);
  const { record } = await stack.deleteAndReturn(install.id);
  return record as StackRecord & { content: InstallContent };
}

/** A manifest's own shape, and every request held to grantType()'s rules. */
function checkManifest(manifest: AppManifest, did: EntityId): void {
  const errors: ValidationError[] = [];
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    errors.push({ path: 'did', message: 'Expected a DID' });
  }
  if (typeof manifest.appId !== 'string' || manifest.appId === '') {
    errors.push({ path: 'appId', message: 'Expected a non-empty appId' });
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    errors.push({ path: 'name', message: 'Expected a non-empty name' });
  }
  const seen = new Set<string>();
  manifest.types.forEach((t, i) => {
    if (seen.has(t.id)) {
      errors.push({ path: `types[${i}].id`, message: `"${t.id}" is listed more than once` });
    }
    seen.add(t.id);
    const schemaPath = `types[${i}].schema`;
    const shapeErrors = validateSchemaShape(t.schema, schemaPath);
    errors.push(...shapeErrors);
    if (shapeErrors.length === 0) {
      const schema = t.schema as TypeSchema;
      for (const e of validateSchemaReservedNames(schema)) {
        errors.push({ ...e, path: `${schemaPath}.${e.path}` });
      }
      validateSchemaFieldNames(schema, schemaPath, errors);
    }
    const parsed = parseTypeId(t.id);
    if (!parsed) {
      errors.push({ path: `types[${i}].id`, message: 'Expected a versioned TypeId' });
    } else {
      const standing = familyStanding(parsed.baseId, manifest.appId);
      if (standing === 'system' || standing === 'foreign') {
        errors.push({
          path: `types[${i}].id`,
          message:
            standing === 'system'
              ? `"${parsed.baseId}" is a system type; no app can define it`
              : `"${parsed.baseId}" is outside the namespace "${manifest.appId}"; request access to it instead of defining it`,
        });
      }
    }
  });
  if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);
  for (const r of manifest.requests) checkGrantValid(r.baseId, r.actions);
}

/** Every `_install` Record, deleted and unlisted included — a deleted install keeps its claims. */
async function loadInstalls(stack: Stack): Promise<(StackRecord & { content: InstallContent })[]> {
  const records = await queryAllPages((q) => stack.query(q), {
    filter: { baseId: SYSTEM_TYPES.INSTALL, includeDeleted: true, includeUnlisted: true },
  });
  return records as (StackRecord & { content: InstallContent })[];
}

/** The `_app` card claiming `did`, deleted and unlisted included. */
function findAppCard(stack: Stack, did: EntityId): Promise<StackRecord | undefined> {
  return findFirstMatch(
    (q) => stack.query(q),
    {
      filter: {
        baseId: SYSTEM_TYPES.APP,
        includeDeleted: true,
        includeUnlisted: true,
        ...(filtersContent(stack.capabilities) && { content: { did } }),
      },
    },
    (r) => (r.content as AppContent).did === did,
  );
}

/** The key's `_app` card, created or undeleted as needed. */
async function ensureAppCard(
  stack: Stack,
  manifest: AppManifest,
  did: EntityId,
): Promise<StackRecord> {
  const card = await findAppCard(stack, did);
  if (!card) {
    return stack.create<AppContent>(`${SYSTEM_TYPES.APP}@1`, {
      appId: manifest.appId,
      name: manifest.name,
      ...(manifest.version !== undefined && { version: manifest.version }),
      did,
    });
  }
  return card.deletedAt ? stack.undelete(card.id) : card;
}

/**
 * Make the grants linked to `install` exactly its `requests`, once per
 * live linked key: withdraw any that no longer match, write any missing,
 * and drop links to grants that are gone.
 */
async function reconcileInstallGrants(stack: Stack, install: StackRecord): Promise<StackRecord> {
  const { requests } = install.content as InstallContent;
  const dids: EntityId[] = [];
  for (const id of linkedIds(install, INSTALL_APP_LABEL)) {
    const did = ((await stack.get(id))?.content as AppContent | undefined)?.did;
    if (typeof did === 'string') dids.push(did);
  }

  const edits: AssociationEdit[] = [];
  const held: GrantContent[] = [];
  for (const id of linkedIds(install, INSTALL_GRANT_LABEL)) {
    const grant = await stack.get(id);
    const content = grant?.content as GrantContent | undefined;
    const wanted =
      content !== undefined &&
      baseIdOf(grant!.typeId) === SYSTEM_TYPES.GRANT &&
      dids.some((did) => requests.some((r) => grantIsRequest(content, r, did)));
    if (wanted) {
      held.push(content);
      continue;
    }
    if (grant) await stack.delete(id);
    edits.push({ op: 'remove', association: installGrantLink(id) });
  }

  for (const did of dids) {
    for (const r of requests) {
      if (held.some((g) => grantIsRequest(g, r, did))) continue;
      const grant = await stack.grantType(r.baseId, {
        actions: r.actions,
        grantee: { kind: 'entity', entityId: did },
      });
      held.push(grant.content);
      edits.push({ op: 'add', association: installGrantLink(grant.id) });
    }
  }
  let result = edits.length > 0 ? await stack.amendAssociations(install.id, edits) : install;

  // Each linked key may read its own install, which is how an app learns
  // what was approved; a key of this app no longer linked may not.
  // See docs/spec/apps.md § Over the wire.
  const appKeys = new Set(
    (
      await queryAllPages((q) => stack.query(q), {
        filter: { baseId: SYSTEM_TYPES.APP, includeDeleted: true, includeUnlisted: true },
      })
    )
      .map((r) => r.content as AppContent)
      .filter((c) => c.appId === (install.content as InstallContent).appId)
      .map((c) => c.did),
  );
  const readerOf = (p: AuthorityAssociation): EntityId | null =>
    p.kind === 'permission' && p.label === 'read' && p.grantee.kind === 'entity'
      ? p.grantee.entityId
      : null;
  const current = (result.permissions ?? []).map(readerOf);
  const access: AssociationEdit[] = [
    ...dids
      .filter((did) => !current.includes(did))
      .map((entityId) => ({ op: 'add' as const, association: installReader(entityId) })),
    ...current
      .filter((did): did is EntityId => did !== null && appKeys.has(did) && !dids.includes(did))
      .map((entityId) => ({ op: 'remove' as const, association: installReader(entityId) })),
  ];
  if (access.length > 0) result = await stack.amendAccess(install.id, access);
  return result;
}
