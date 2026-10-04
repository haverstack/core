# App installs

An app the owner does not run — one that holds its own key and reaches the stack through `APIAdapter` (see [Identity § Two ways an app reaches a stack](./identity.md#two-ways-an-app-reaches-a-stack)) — knows its schema but cannot define it, since [defining a Type is owner-acting-alone](./access-control.md#what-a-grant-covers). Every such app needs the same owner-side steps: define its types, register its key on an `_app` card, grant that key the types it needs. An **install** is those steps as one reviewable act, and a Record that remembers what was approved.

The app ships a **manifest** — a request. What the stack stores is the owner's **approval** of it, as an `_install` Record. The owner reviews a plan of what applying the manifest would change, then applies exactly that plan.

```ts
type AppManifest = {
  appId: AppId; // reverse-DNS, as on an _app card
  name: string;
  version?: string;
  types: DefineTypeOptions[]; // the types the app defines
  requests: InstallRequest[]; // the grants its keys hold
};

type InstallRequest = { baseId: BaseId; actions: GrantAction[] };

const plan = await stack.planInstall(manifest, { did: appDid });
// …show the plan to the owner…
await stack.installApp(plan);
```

Migration functions are not part of a manifest. They are app code, registered at every startup with `registerMigration()` (see [Data model § Type migrations](./data-model.md#type-migrations)), and the app runs them itself — see [Migrating an installed app's types](#migrating-an-installed-apps-types).

`planInstall()`, `installApp()` and `uninstallApp()` live on `Stack` and are absent from `StackClient`, like `grantType()` and `defineType()`: everything they write is the owner's to write. There is no wire endpoint for them; a server offering an install flow builds its approval step on these calls.

## The `_install` record

```ts
type InstallContent = {
  appId: AppId; // a binding: immutable, unique among installs
  name: string;
  version?: string;
  defines: TypeId[]; // every version the owner has approved
  requests: InstallRequest[]; // the grants each of the app's keys holds
};
```

`_install@1` is a system type, pre-seeded with the others ([Data model § System types](./data-model.md#system-types)). It is integrity-bearing in the way `_grant` is — it decides which grants exist and who may commit migrations — and is protected the same way:

- **It cannot be granted.** `grantType()` refuses `_install` beside `_grant`, `_config` and `_app` (see [Access control § What a grant covers](./access-control.md#what-a-grant-covers)), and a `request` naming any of the four is refused at the write.
- **Only the owner acting alone writes one.** `ScopedStack` refuses every write to an `_install` Record on the same terms as a `_grant` Record, whatever the Record's own `permissions` say.
- **`appId` is a binding**, immutable and unique on the terms [Identity § DID bindings](./identity.md#did-bindings) sets out: one install answers for each app, and an existing install cannot be relabelled to answer for another.
- **A family is claimed by one install.** The families named by an install's `defines` are its own, and a write that would have a second install claim one is refused with `StackConflictError`, on create, patch, migration and restore alike. A soft-deleted install keeps its claims, for the reason a soft-deleted card keeps its DID: it can be undeleted. No install can claim a system family.

Every `defines` entry must be a versioned TypeId, and every `request` must name a family and actions from the grant vocabulary; `StackValidationError` otherwise.

**An install and an `_app` card answer different questions.** A card is one per _key_: an app on two devices, or after a key change, has two cards sharing an `appId`. An install is one per _software_. A card says who a key is; an install says what the owner agreed to let that software do. They are linked rather than merged so neither has to answer the other's question.

**Associations hold the links.** An install carries a `relationship` labelled `install.app` to each `_app` card it was installed for, and one labelled `install.grant` to each `_grant` Record it produced. That is what tells a grant the install made from one the owner wrote by hand, and it is what uninstalling withdraws.

**Version history is the upgrade log.** Applying a changed manifest patches the install, so what was approved at any earlier point is a [version](./versioning.md#version-history) of it.

## Plan, then apply

`planInstall(manifest, { did })` writes nothing. It reports what applying the manifest for that key would change:

```ts
type InstallPlan = {
  manifest: AppManifest;
  did: EntityId;
  existing: (StackRecord & { content: InstallContent }) | null;
  newFamilies: BaseId[]; // families the install would claim for the first time
  newVersions: TypeId[]; // versions not yet in `defines`
  requestsAdded: InstallRequest[];
  requestsRemoved: InstallRequest[];
  foreignRequests: (InstallRequest & { owner: AppId | 'system' | null })[];
  newKey: boolean; // whether `did` is not yet linked to this install
};
```

`foreignRequests` are the requests on families the install does not define, each naming who owns the family: another install's `appId`, `'system'`, or `null` when nothing claims it. They are the requests an approval most needs to show — an app asking to read another app's records, or `_entity`, is asking for reach beyond its own data.

It refuses what no approval could make valid: a type in a system family or in a family another install claims (`StackConflictError`), a request [`grantType()` would refuse](./access-control.md#type-level-grants) (`StackValidationError`), and a `did` whose `_app` card names a different `appId` (`StackConflictError`).

`installApp(plan)` applies the plan:

1. Defines each of the manifest's types, with [schema drift](./data-model.md#schema-drift-detection) applying as it does to any `defineType()`.
2. Registers the key on an `_app` card when it has none, undeleting a soft-deleted one. An existing card's `name` is left alone: it is the owner's label.
3. Creates the install, or patches it — undeleting it first if it was uninstalled. `defines` gains the manifest's versions and never loses any, since a Type once defined stays defined; `requests` becomes the manifest's.
4. Brings the grants of **every** key linked to the install to exactly `requests`: a grant no longer requested is revoked, a missing one is written, and the links follow.

**Nothing is applied that was not approved.** `installApp()` plans the same manifest again and refuses with `StackConflictError` when the result differs from the plan it was handed — another install claiming a family, the install changing, the key being linked. The remedy is to plan again and show the owner the new plan. Re-applying a manifest whose plan is empty changes nothing.

## Migrating an installed app's types

[Migration is owner-acting-alone](./access-control.md#what-a-grant-covers), and an installed app's migration functions are its own code, which the owner should not have to run with owner authority. An install closes the gap: a contained app may commit migrations within its own families. `ScopedStack.commitMigration()` — and so `migrateAll()` run by the app over `APIAdapter`, which commits through `POST /records/:id/migrate` — admits a request that is not the owner acting alone when **all** of these hold:

1. The source and target families are both claimed by one live install, and by no other.
2. The target TypeId is in that install's `defines` — a version the owner approved.
3. The requester holds `update-any` on each family through a grant naming its DID directly. Default and group grants do not count, on the terms they do not count for [a principal](./access-control.md#who-a-grant-reaches). The manifest has to request it, so the plan shows it.
4. The requester is acting alone — not delegated — as the DID of an `_app` card linked to the install.

The reasons migration is otherwise owner-only do not reach this case. A migration that crosses into `_attachment` or moves a DID binding needs a system family at one end, and no install can claim one. Ordinary write access is not consent to move a Record between versions; the owner's approval of the version is. Every migration still snapshots the Record's prior content and type to [version history](./versioning.md#version-history), so it stays recoverable like any other write.

Approving a new version is therefore also approving its migration. Until the owner approves it, the app reads records at the older version through [`presentAt: 'latest'`](./data-model.md#type-migrations).

**The app sweeps what it can see.** `migrateAll()` ordinarily sweeps every record of the family, deleted and unlisted included. A non-owner can do neither: `includeUnlisted` is [owner-only](./unlisted.md#includeunlisted-is-owner-only), and a soft-deleted record reaches it as a [tombstone](./versioning.md#the-tombstone-is-literal) with no content to migrate. So the app passes `sweep: 'listed'`:

```ts
const { migrated, skipped } = await stack.migrateAll('com.example.notes/note', { sweep: 'listed' });
```

which migrates live, listed records and counts the soft-deleted ones it passed over in `skipped`. Unlisted records are not enumerable to it, so they are not counted. Both kinds stay at their version, still found by a query on that `typeId`, and the app commits each one with `commitMigration()` when it next reaches it — after an undelete, or reading an unlisted record by ID.

## Uninstalling

`uninstallApp(appId)` revokes every grant linked to the install and soft-deletes it. The app's records stay: they are the owner's data, and purging them is a separate, deliberate act. Its `_app` cards stay too, since they are what its records' attribution resolves through (see [Identity § Attribution and what can be trusted](./identity.md#attribution-and-what-can-be-trusted)). A deleted install confers no migration authority.

Installing the same `appId` again undeletes the install and grants its requests afresh. Its families stay claimed in between, so no other app can take them over while it is uninstalled.
