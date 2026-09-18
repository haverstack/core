---
'@haverstack/core': patch
'@haverstack/conformance-fixtures': patch
---

Build a change's two halves from one object, and correct the spec the journal left behind

**`Stack` now names a change once.** A mutation writes its change twice — the
durable half travels into the adapter's transaction ahead of the write, and the
live half is built from the record that write produced — and until now each verb
spelled both out separately. "The entry set is the event set" was a sentence in
the spec enforced by nothing: eleven emission sites reconciled against eight
journal sites only by reading each one, and the mutate path already stated the
same actor two different ways.

Both halves now come off one `PendingChange`, so a verb cannot journal one thing
and announce another, and the rule that a hard delete writes no entry is a
property of that object rather than something two call sites remember.

No public API moves — neither builder was exported — and every reachable case
resolves its actor exactly as before: read off the record for a version-bumping
write, which stamped it, and off the request for `associate()`/`dissociate()`,
which did not.

**The surrounding spec caught up with the three changes that landed before it.**

- `docs/spec/journal.md` is a document of its own, indexed from `docs/spec.md`.
  The journal has its own wire endpoint, permission gate and erasure rule; it had
  outgrown being a subsection of Versioning, and `wire-format.md § Journal` now
  defers to it instead of re-arguing five of its rules.
- `data-model.md § Mutations` no longer teaches that every `mutate()` produces a
  version. A change set whose only key is `associations` produces none, which is
  the whole point of decoupling them, and this was the one document a reader
  meets that rule in.
- `attachments.md` claimed nothing retains the `attachmentRecordId` a re-point
  discarded. The journal's `associationsReplaced` does, which is what makes a
  re-point undoable rather than merely observable.
- `wire-format.md § Journal` documents `associationsReplaced`, which the wire
  already serialized and a fixture already pinned.
- `spec.md`'s `StackClient` listing names `getJournal`, `subscribe`,
  `commitMigration`, `getEntityByDid` and `getOwnerEntity`, all of which the
  interface has and the list did not.
- `StackClient.getJournal()`'s doc comment no longer says there is no wire
  surface. There is one.
