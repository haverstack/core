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

`planInstall()`, `installApp()` and `uninstallApp()` live on `Stack` and are absent from `StackClient`, like `grantType()` and `defineType()`: everything they write is the owner's to write. An app reaches them only through the request it can make over the wire — see [Over the wire](#over-the-wire).

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
- **It claims only its own families.** Every `defines` entry must be a versioned TypeId in the install's own namespace (see [Who owns a family](#who-owns-a-family)); anything else is refused with `StackValidationError` on create, patch, migration and restore alike. `appId` being unique is what makes each family's owner single.

Every `request` must name a family and actions from the grant vocabulary; `StackValidationError` otherwise.

**An install and an `_app` card answer different questions.** A card is one per _key_: an app on two devices, or after a key change, has two cards sharing an `appId`. An install is one per _software_. A card says who a key is; an install says what the owner agreed to let that software do. They are linked rather than merged so neither has to answer the other's question.

**Associations hold the links.** An install carries a `relationship` labelled `install.app` to each `_app` card it was installed for, and one labelled `install.grant` to each `_grant` Record it produced. That is what tells a grant the install made from one the owner wrote by hand, and it is what uninstalling withdraws.

**Version history is the upgrade log.** Applying a changed manifest patches the install, so what was approved at any earlier point is a [version](./versioning.md#version-history) of it.

## Who owns a family

**A family belongs to the app whose `appId` is its namespace** — the part of the `BaseId` before the `/`. `com.example.notes/note` is `com.example.notes`'s, whether or not that app is installed, so ownership never depends on which app reached a stack first. A Type's namespace is already how its author is named ([Data model § Types](./data-model.md#types)); an install only makes that enforceable.

Two kinds of family belong to no app. **System families** (`_entity`, `_grant`, …) are the library's. **Commons families** (`org.haverstack/…`) are governed in the open by the [Schema Commons](../commons/README.md), precisely so that no single app controls a shape every app reads. A manifest may list commons types so that installing it defines them, but defining one claims nothing, and no app may migrate a commons family.

**Using a family is a request; owning one is control of its schema.** Any app may ask for grants on any grantable family — another app's, a commons one, `_entity` — and the owner sees each such request, with the family's owner, in the plan. Only the owner of a family defines its versions and migrates its records, so two apps can never publish rival versions of the same family. An app that wants to add to records it does not own defines a family of its own and links its records to them with `relationship` associations; the shared family is untouched.

**Residual, stated rather than fixed:** `appId` is the app's own claim. On a stack where the real `com.example.notes` is not installed, another app can present a manifest under that `appId` and, if approved, own its families. The plan names the `appId` asking, so the owner is the check; closing the gap needs signed manifests.

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
  foreignRequests: (InstallRequest & { owner: AppId | 'commons' | 'system' | null })[];
  newKey: boolean; // whether `did` is not yet linked to this install
};
```

`foreignRequests` are the requests on families outside the app's own namespace, each naming the family's [owner](#who-owns-a-family): another app's `appId`, `'commons'`, `'system'`, or `null` for a family with no namespace. They are the requests an approval most needs to show — an app asking to read another app's records, or `_entity`, is asking for reach beyond its own data.

It refuses what no approval could make valid: a type outside the app's own namespace and the commons (`StackValidationError` — use a request instead), a request [`grantType()` would refuse](./access-control.md#type-level-grants) (`StackValidationError`), and a `did` whose `_app` card names a different `appId` (`StackConflictError`).

`installApp(plan)` applies the plan:

1. Defines each of the manifest's types, with [schema drift](./data-model.md#schema-drift-detection) applying as it does to any `defineType()`.
2. Registers the key on an `_app` card when it has none, undeleting a soft-deleted one. An existing card's `name` is left alone: it is the owner's label.
3. Creates the install, or patches it — undeleting it first if it was uninstalled. `defines` gains the manifest's versions and never loses any, since a Type once defined stays defined; `requests` becomes the manifest's.
4. Brings the grants of **every** key linked to the install to exactly `requests`: a grant no longer requested is revoked, a missing one is written, and the links follow.

**Nothing is applied that was not approved.** `installApp()` plans the same manifest again and refuses with `StackConflictError` when the result differs from the plan it was handed — the install changing, or the key being linked, since it was planned. The remedy is to plan again and show the owner the new plan. Re-applying a manifest whose plan is empty changes nothing.

## Migrating an installed app's types

[Migration is owner-acting-alone](./access-control.md#what-a-grant-covers), and an installed app's migration functions are its own code, which the owner should not have to run with owner authority. An install closes the gap: a contained app may commit migrations within its own families. `ScopedStack.commitMigration()` — and so `migrateAll()` run by the app over `APIAdapter`, which commits through `POST /records/:id/migrate` — admits a request that is not the owner acting alone when **all** of these hold:

1. The source and target families are both in the namespace of one live install, and both in its `defines`.
2. The target TypeId is in that install's `defines` — a version the owner approved.
3. The requester holds `update-any` on each family through a grant naming its DID directly. Default and group grants do not count, on the terms they do not count for [a principal](./access-control.md#who-a-grant-reaches). The manifest has to request it, so the plan shows it.
4. The requester is acting alone — not delegated — as the DID of an `_app` card linked to the install.

The reasons migration is otherwise owner-only do not reach this case. A migration that crosses into `_attachment` or moves a DID binding needs a system family at one end, and no install can claim one; nor can it claim a commons family, which every app reads. Ordinary write access is not consent to move a Record between versions; the owner's approval of the version is. Every migration still snapshots the Record's prior content and type to [version history](./versioning.md#version-history), so it stays recoverable like any other write.

Approving a new version is therefore also approving its migration. Until the owner approves it, the app reads records at the older version through [`presentAt: 'latest'`](./data-model.md#type-migrations).

**The app sweeps what it can see.** `migrateAll()` ordinarily sweeps every record of the family, deleted and unlisted included. A non-owner can do neither: `includeUnlisted` is [owner-only](./unlisted.md#includeunlisted-is-owner-only), and a soft-deleted record reaches it as a [tombstone](./versioning.md#the-tombstone-is-literal) with no content to migrate. So the app passes `sweep: 'listed'`:

```ts
const { migrated, skipped } = await stack.migrateAll('com.example.notes/note', { sweep: 'listed' });
```

which migrates live, listed records and counts the soft-deleted ones it passed over in `skipped`. Unlisted records are not enumerable to it, so they are not counted. Both kinds stay at their version, still found by a query on that `typeId`, and the app commits each one with `commitMigration()` when it next reaches it — after an undelete, or reading an unlisted record by ID.

## Uninstalling

`uninstallApp(appId)` revokes every grant linked to the install and soft-deletes it. The app's records stay: they are the owner's data, and purging them is a separate, deliberate act. Its `_app` cards stay too, since they are what its records' attribution resolves through (see [Identity § Attribution and what can be trusted](./identity.md#attribution-and-what-can-be-trusted)). A deleted install confers no migration authority.

Installing the same `appId` again undeletes the install and grants its requests afresh.

## Over the wire

Install has two halves, and only one of them is the same on every server. **The app's half** — present a manifest, learn whether it was approved — is pinned by [`POST /installs`](./wire-format.md#installs), so an app installs itself the same way on any stack. **The owner's half** — review the plan, approve it — is a person deciding, through whatever the server offers (an admin page, a notification); it is not on the wire, and underneath it is `planInstall()` then `installApp()`.

```ts
const result = await adapter.requestInstall(manifest);
// { status: 'pending' } until the owner approves this manifest for this key,
// then { status: 'installed', install } once applying it would change nothing
```

**The key is the session's.** The request names no DID: the handshake already proved which key is asking, so no app can ask for an install on behalf of a key it does not hold.

**A request is not an approval.** A pending request lives with the server, not in the stack, so a key that merely authenticated writes nothing into the owner's data. The stack holds only what the owner approved.

**An app reads its own install.** `installApp()` gives every linked key record-level `read` on the install, so the app sees which versions and grants were approved with an ordinary read — by id, or `query({ filter: { baseId: '_install' } })`, which returns only installs it can read. Upgrading is the same request with the new manifest: `pending` until the owner approves, with the app reading at the older version through `presentAt: 'latest'` meanwhile.
