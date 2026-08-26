# @haverstack/conformance-fixtures

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.12.0

## 0.5.0

### Minor Changes

- [#191](https://github.com/haverstack/core/pull/191) [`dcf1e4c`](https://github.com/haverstack/core/commit/dcf1e4cb4b9b8e75087d28ae72722826bcc665e3) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add change-feed fixtures: `changeFeedFixtures` and `changeFeedSequenceFixtures`, with the `ChangeFeedFixture`, `ChangeFeedSequenceFixture`, `ChangeFeedActivity` and `ChangeFeedFrame` types they are written in. Discovery gains fixtures for a server advertising a feed, including one that neither resumes nor includes records.

  A connection is pinned as an ordered stream of frames plus the mutations made while it is open, since most of what the endpoint owes a client is what a _mutation_ makes an open connection say. The group covers a frame per kind, `ready` leading every connection, `reset` in place of a partial resume, exact filtering, a record the session cannot read producing no frame, and the purge that carries nothing about the record even when the connection asked for one.

### Patch Changes

- Updated dependencies [[`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435)]:
  - @haverstack/wire-types@0.11.0

## 0.4.0

### Minor Changes

- [#185](https://github.com/haverstack/core/pull/185) [`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop `ScopedStack` refusals from confirming which record IDs exist.

  A record the request cannot read now answers exactly as a missing one does. `ScopedStack.get()` returns `null` for an unreadable record instead of throwing `StackPermissionError`, and `update()`, `associate()`, `dissociate()`, `setPermissions()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()` and `restoreVersion()` throw `StackNotFoundError` rather than `StackPermissionError` where the requester holds no read access. `StackPermissionError` is now reserved for a requester who can read the record — over the wire, 403 is earned by readability and everything else is 404.

  Record IDs encode their creation millisecond and increment within it, so the old distinction let anyone holding one ID confirm its same-millisecond siblings. Callers that branch on `StackPermissionError` to detect "exists but forbidden" will see `StackNotFoundError`/`null` instead; the distinction is still available to server operators, which `docs/spec/wire-format.md` § Server implementation checklist now asks them to log.

  Unaffected: refusals that never read the record — `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` answer identically whether or not it exists — and reference-creation gating, which continues to collapse missing and inaccessible targets onto `StackPermissionError`.

  Fixtures gain `error-not-found-record-the-requester-cannot-read`, so a server that answers 403 there now fails conformance.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.10.0
