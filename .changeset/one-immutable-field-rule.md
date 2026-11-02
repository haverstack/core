---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

Every immutable field follows one rule. `_config.ownerEntityId`, the `did`/`appId` bindings and `_attachment`'s `fileId`, `mimeType` and `size` are declared in one table and checked on `patchContent()`, `restoreVersion()` and `commitMigration()` alike, across both families of a migration.

- Changing or clearing an immutable field throws `StackConflictError` (`409 conflict`) with the message `Cannot change <family>.<field>: it is immutable once set.` Bindings and attachment fields previously threw `StackValidationError` (422).
- A new `_attachment` record whose `mimeType` conflicts with the one established for its `fileId` throws `StackConflictError` (`409 conflict`) instead of `StackValidationError` (422), like a second claim on a DID binding.
- Restating a stored value is no change: a patch that sends an `_attachment` record's current `mimeType` is accepted.
- `restoreVersion()` checks attachment fields and binding uniqueness, as patches do.
- Fixtures: `error-validation-attachment-mimetype-conflict-on-create` is renamed `error-conflict-attachment-mimetype-on-create` and answers 409; `error-validation-attachment-mimetype-immutable-on-update` is replaced by `error-conflict-attachment-mimetype-change`; `error-conflict-config-owner-change` carries the shared message.
