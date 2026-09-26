# @haverstack/adapter-conformance

## 0.8.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`a431168`](https://github.com/haverstack/core/commit/a43116869768b7f6e7f7a7bb9712d6821d831498), [`4a3bc8e`](https://github.com/haverstack/core/commit/4a3bc8e86f69296ce18413e2225e6f35557a3b1c)]:
  - @haverstack/core@0.39.0

## 0.7.0

### Minor Changes

- [#347](https://github.com/haverstack/core/pull/347) [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Align the adapter vocabulary with the client's.
  - The version precondition is `ifVersion` on both sides of the `Stack`/adapter boundary: `StackRecordAdapter` methods take the root export `IfVersionOptions` (`{ ifVersion?: number }`), and `ExpectedVersionOptions` is removed. `StackVersionConflictError.expectedVersion` and the wire payload are unchanged.
  - Capabilities have one name: `AdapterCapabilities` (from `@haverstack/core/adapter`) and its root alias `StackFeatures` are replaced by `StackCapabilities`, exported from the root, and `Stack.features`, `ScopedStack.features` and `StackClient.features` are renamed `capabilities`.
  - `StackBlobAdapter` methods are renamed `putBlob`, `getBlob`, `deleteBlob` and `listBlobs`, and `BlobFileInfo` is renamed `BlobInfo`, so "attachment" names only the record-backed `Stack` operation. `putAttachmentWithMetadata` keeps its name. The blob conformance suite's `listFiles` option is renamed `listBlobs`.

### Patch Changes

- [#351](https://github.com/haverstack/core/pull/351) [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Follow-ups to the API consistency pass.
  - The `Stack` prefix is reserved for the `StackError` taxonomy. The local errors outside it are renamed: `StackClosedError` → `UseAfterCloseError` and `StackRelayScopeError` → `RelayScopeError`.
  - Every `@haverstack/core` export has exactly one entry point. `StackAdapter` moves from the root to `@haverstack/core/adapter`, beside its record and blob halves; `TokenSession` moves from the root to `@haverstack/core/wire`, beside `StackTokenStore` and `TokenInfo`; `ContentFilterReach` and `MissingCapability` are no longer exported from `@haverstack/core/adapter`, only the root; and `@haverstack/core/wire` no longer re-exports the root's errors (`StackValidationError`, and `StackQueryError` under its new name `StackBadRequestError`).
  - `LocalAdapter.openOrInitialize()` throws `LocalAdapterOwnerMismatchError` (with `expectedOwnerEntityId`, `actualOwnerEntityId` and `path`) on an owner mismatch, and releases the database lock before throwing. `APIAdapterOwnerMismatchError`'s `expectedOwner`/`actualOwner` fields are now `expectedOwnerEntityId`/`actualOwnerEntityId`, matching.
  - `DiskBlobAdapter` takes an options object, `new DiskBlobAdapter({ dir })`, like `S3BlobAdapter`.

- [#350](https://github.com/haverstack/core/pull/350) [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make every `ChangeOp` a verb and spell permanent deletion one way. The record-level ACL op `'permissions'` is now `'reshare'`. Permanent deletion is `purge` everywhere: `delete(id, { purge: true })` (was `{ hard: true }`), `deleteRecord(id, { purge: true })` on every adapter, `DELETE /records/:id?purge=true` on the wire (was `?hard=true`), and the op `'purge'` (was `'hard-delete'`), matching the existing `'purged'` kind.

- [#349](https://github.com/haverstack/core/pull/349) [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rename the change feed's resume cursor from `seq` to `cursor`, so it no longer shares a name with the journal's per-record `seq`. `RecordChange.seq` is now `RecordChange.cursor`, the `ready` frame carries `{"cursor": …}`, and `isValidSeq()` is now `isValidCursor()`. The journal window's exclusive bound `JournalQuery.sinceSeq` (and the `?sinceSeq=` query param) is now `afterSeq`.

- [#326](https://github.com/haverstack/core/pull/326) [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, which replaces `PermissionGrantee`, with `GroupRole` naming `'member' | 'admin'`; `GrantGrantee` is `Grantee` plus `{ kind: 'authenticated' }`. The `GrantTarget` alias is removed in favor of `GrantGrantee`. Relationship targets (`RelationshipTarget`, `RelationshipTargetPattern`) move to `kind` too — `{ kind: 'record' | 'entity' | 'external', … }` — so an entity target and an entity grantee are the same value.
- Updated dependencies [[`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7), [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226), [`2f12d0a`](https://github.com/haverstack/core/commit/2f12d0a6ed6adab7d04cf858f566bad18826cdc9), [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62), [`147bbdf`](https://github.com/haverstack/core/commit/147bbdf8e8ce50c5865875b0c56e410fee01994f), [`83ded9c`](https://github.com/haverstack/core/commit/83ded9c2274d5e1ca29e8de4fa714a9da5eff2d1), [`e36923c`](https://github.com/haverstack/core/commit/e36923cf3799f8d3a13176c23b293f4967e4928b), [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d), [`fa9e4b8`](https://github.com/haverstack/core/commit/fa9e4b8be57a22b63bb63479f89644ea52bf038b), [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2), [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6), [`e4c8628`](https://github.com/haverstack/core/commit/e4c862860111a090fe1b08cd63e2da71e62f1e56), [`40b3757`](https://github.com/haverstack/core/commit/40b3757a93a2dd1a68a7fbb40273efe3503719a6), [`e3057db`](https://github.com/haverstack/core/commit/e3057db5af528136270b3c418bb0021d3727d5a5), [`1b0e0c7`](https://github.com/haverstack/core/commit/1b0e0c73e386cd9adc178a8b56a72944bd334f46), [`7cffb1d`](https://github.com/haverstack/core/commit/7cffb1dc8e33993082aaa83599ba2e031a1c5cde)]:
  - @haverstack/core@0.38.0

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`11444f6`](https://github.com/haverstack/core/commit/11444f694cfa6b24fbe926cf7420d3523a3fa95f)]:
  - @haverstack/core@0.37.0

## 0.5.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5), [`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5)]:
  - @haverstack/core@0.36.0

## 0.4.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`227ddf8`](https://github.com/haverstack/core/commit/227ddf8eede5c1ea5a88f2336f33c8bde6280070), [`4368d1b`](https://github.com/haverstack/core/commit/4368d1bd990721f91e5e70f833417aded60ecd8b), [`1d3d8b9`](https://github.com/haverstack/core/commit/1d3d8b998bd52ac0f0b88707a7116007779a226a), [`ea2b328`](https://github.com/haverstack/core/commit/ea2b328b59ae4e4f2fcb8743b0359e49b7a79deb), [`70075a2`](https://github.com/haverstack/core/commit/70075a268a8fbae909dfb5fe9dae04a53f13f2e9), [`b4b21db`](https://github.com/haverstack/core/commit/b4b21dbc208937817f26602fd53751601e6d43a0), [`93111dc`](https://github.com/haverstack/core/commit/93111dcb4989a35c5c5160eb46b418fd829ed50e)]:
  - @haverstack/core@0.35.0

## 0.3.0

### Minor Changes

- [#296](https://github.com/haverstack/core/pull/296) [`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Give the change journal its own association shape, and write down the erasure boundary around a purge.

  A journal entry's three association lists become one tagged list, `associations: AssociationChange[]`, with `add`, `repoint` and `remove` arms. Each element carries the state it displaced, so an inverse is read off one element instead of joined across two lists against a key that was never identity. A removal now keeps the annotation it carried, which makes it as undoable as a re-point. The change feed keeps its two flat lists unchanged; they are flattened out of the entry's list, so the two halves cannot disagree. The `journal` table replaces its three `associations_*` columns with one, and `GET /records/:id/journal` carries the new field.

  An association list holding one identity twice is now refused with `StackValidationError` rather than collapsed, and every adapter keys associations by identity.

  `delete()` returns `{ referencedFileIds }`: a purge deletes no bytes, but it destroys the only rows naming the files the record referenced, so it reports them and the caller makes the intentional `deleteAttachment()` call. A hard delete over the wire answers `200` with the record it destroyed rather than `204`, which is where a client reads that report.

  `getJournal()` throws `StackNotFoundError` for a record that does not exist or was purged, instead of answering an empty log — an empty log means "nothing changed" unconditionally.

### Patch Changes

- Updated dependencies [[`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843)]:
  - @haverstack/core@0.34.0

## 0.2.0

### Minor Changes

- [#294](https://github.com/haverstack/core/pull/294) [`d9a088a`](https://github.com/haverstack/core/commit/d9a088ac710bfc4cb2310e9a38914dc28f70b325) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Cover the change journal in the record adapter suite

  `getJournal()` is required of every adapter — an empty log has to mean "nothing
  changed" unconditionally, because the alternative spelling available to an
  adapter with no journal is exactly that answer. The suite that calls itself the
  runnable form of the adapter contract checked version snapshots and associations
  and said nothing about the tier beside them, so an adapter could pass every test
  here while returning `[]` from `getJournal()` forever.

  Nine tests close that: the method's presence, `seq` dense from 1 and counted per
  record, the `version`/`typeId`/`parentId` stamp coming off the row the write
  produced rather than the caller, a version that stands still across an
  association change, `associationsReplaced` surviving the round trip,
  `previousParentId` telling "did not move" apart from "moved off the root", the
  `sinceSeq`/`limit` window, a failed mutation leaving no entry, and a hard delete
  destroying the log rather than leaving it for the next record at that id.
